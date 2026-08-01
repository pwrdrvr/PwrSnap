// Library grid — day-header / cell-row overlap regression spec.
//
// Reproduces the degenerate grid state where the first cell-row of a
// day renders UNDERNEATH the pinned (sticky) day banner, chopping off
// the top of the tiles (and the selection ring) at rest at the top of
// the library.
//
// Mechanism (two compounding defects around TanStack Virtual):
//
//  1. Zero-size poisoning. The grid stays mounted under
//     `display: none` while the user is in Reel or Focus mode
//     (`.psl[data-mode="reel"] .psl__grid-wrap { display: none }`).
//     TanStack's per-item ResizeObserver fires for every observed row
//     with `borderBoxSize` = 0 when the subtree is display:none, and
//     virtual-core has no zero-guard — it writes 0 into itemSizeCache.
//
//  2. The active sticky header can never heal. VirtualizedGrid renders
//     the active sticky day-header with `ref={undefined}` (it must not
//     be re-positioned by measurement), so a header that is currently
//     pinned is never observed. When the user scrolls UP into a day,
//     that day's header enters the rendered range already-active — so
//     a poisoned 0 for that header sticks forever. Every row of the
//     day then starts `headerHeight` pixels too high and slides under
//     the pinned banner.
//
// The repro needs the poisoned header to be MOUNTED but NON-active at
// hide time, which happens when the first day-group is short (a few
// captures — e.g. early in the day) and the user has scrolled just
// past it: the next day's header is active, and the first day's header
// sits within the virtualizer's overscan, observed. Toggling
// Reel → Grid then: (a) zeroes the header's cached size while hidden,
// (b) collapses scrollTop (total virtual height shrinks under
// display:none, Chromium clamps), so on return the user is at the top
// with the poisoned header pinned active — where it is never
// re-measured. The overlap survives new captures being added (the
// header stays at flat-row index 0), matching the reported real-world
// state where the broken day accumulated captures for hours.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

const DAY_MS = 24 * 60 * 60 * 1000;

// 1×1 transparent PNG — same fixture bytes the focus-scroll spec uses.
const PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000158d57340000000049454e44ae426082";

type SeedDay = { dayOffset: number; count: number };

async function seedDays(app: LaunchedApp, days: SeedDay[], idPrefix: string): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-day-hdr-"));
  const pngPath = path.join(dir, "fixture.png");
  await writeFile(pngPath, Buffer.from(PNG_HEX, "hex"));

  await app.electronApp.evaluate(
    (
      _electron,
      payload: { days: SeedDay[]; dayMs: number; pngPath: string; idPrefix: string }
    ) => {
      type Bridge = {
        seedCapture: (input: {
          id: string;
          kind: "image" | "video";
          captured_at: string;
          source_app_bundle_id: string | null;
          source_app_name: string | null;
          legacy_src_path: string;
          width_px: number;
          height_px: number;
          device_pixel_ratio: number;
          byte_size: number;
          sha256: string;
        }) => unknown;
      };
      const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
      const now = Date.now();
      let seq = 0;
      for (const day of payload.days) {
        for (let i = 0; i < day.count; i++) {
          // Space intra-day captures a minute apart, oldest first, so
          // ordering within the day is deterministic.
          const ts = new Date(
            now - day.dayOffset * payload.dayMs - (day.count - i) * 60_000
          ).toISOString();
          const id = `${payload.idPrefix}-${seq.toString().padStart(4, "0")}`;
          seq += 1;
          bridge.seedCapture({
            id,
            kind: "image",
            captured_at: ts,
            source_app_bundle_id: "com.test.spec",
            source_app_name: "Day Header Spec",
            legacy_src_path: payload.pngPath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: id
          });
        }
      }
    },
    { days, dayMs: DAY_MS, pngPath, idPrefix }
  );

  await broadcastCapturesChanged(app);
}

// `seedCapture` writes straight through `insertCapture` and bypasses
// the bus — the renderer's `useLibrary` only refetches on the
// `events:captures:changed` broadcast, so kick it manually.
async function broadcastCapturesChanged(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate((electronModule) => {
    const { BrowserWindow } = electronModule;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("events:captures:changed", { changedIds: [] });
    }
  });
}

async function waitForGrid(window: Page, minCells: number): Promise<void> {
  await window.waitForSelector('.psl[data-mode="grid"] .psl__cell[data-cell-id]');
  await expect
    .poll(async () =>
      window.evaluate(() => document.querySelectorAll(".psl__cell[data-cell-id]").length)
    )
    .toBeGreaterThan(minCells);
}

type RowProbe = {
  idx: number;
  sticky: boolean;
  /** translateY offset for absolute rows; null for the sticky row. */
  y: number | null;
  height: number;
  isHeader: boolean;
};

type GridProbe = {
  scrollTop: number;
  rows: RowProbe[];
};

/** Snapshot every rendered virtual row: flat index, sticky/absolute
 *  positioning, translateY, rendered height, header-or-cells. */
async function probeGrid(window: Page): Promise<GridProbe> {
  return window.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
    if (wrap === null) throw new Error("grid wrap missing");
    const rows = Array.from(wrap.querySelectorAll<HTMLElement>("[data-index]"));
    const parsed = rows
      .map((el) => {
        const idx = Number(el.getAttribute("data-index"));
        const sticky = el.style.position === "sticky";
        const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform ?? "");
        return {
          idx,
          sticky,
          y: m === null ? null : Number(m[1]),
          height: el.offsetHeight,
          isHeader: el.querySelector(".psl__day-hdr") !== null
        };
      })
      .sort((a, b) => a.idx - b.idx);
    return { scrollTop: wrap.scrollTop, rows: parsed };
  });
}

/** Scroll the grid to the top and assert the first cell-row does NOT
 *  overlap the day banner. The banner (flat row 0) is the active
 *  sticky at the top; the first cell-row (flat row 1) is absolute at
 *  translateY(cachedSize(row 0)). If the header's cached size was
 *  poisoned, translateY lands above the banner's real bottom edge and
 *  the tiles render underneath it. Also cross-check with live
 *  bounding rects so the assertion reflects what the user sees. */
async function expectNoOverlapAtTop(window: Page): Promise<void> {
  await window.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
    if (wrap === null) throw new Error("grid wrap missing");
    wrap.scrollTop = 0;
  });
  // Let the virtualizer + ResizeObserver passes settle.
  await window.waitForTimeout(400);

  const probe = await probeGrid(window);
  expect(probe.scrollTop).toBe(0);

  const header = probe.rows.find((r) => r.idx === 0);
  const firstCells = probe.rows.find((r) => r.idx === 1);
  expect(header, "day header row rendered").toBeDefined();
  expect(firstCells, "first cell row rendered").toBeDefined();
  if (header === undefined || firstCells === undefined) return;
  expect(header.isHeader).toBe(true);
  expect(firstCells.isHeader).toBe(false);

  // Virtual-layout invariant: the first cell row starts at the
  // header's cached size — which must be at least the header's real
  // rendered height (tolerance 2px for sub-pixel rounding).
  expect(
    firstCells.y,
    `first cell row translateY (${String(firstCells.y)}px) must clear the ` +
      `day banner (rendered ${header.height}px tall) — cached header size ` +
      `was poisoned`
  ).toBeGreaterThanOrEqual(header.height - 2);

  // Pixel-level cross-check: no rendered cell may overlap the banner.
  const rects = await window.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
    const hdr = document.querySelector<HTMLElement>(".psl__day-hdr");
    if (wrap === null || hdr === null) throw new Error("probe elements missing");
    const hdrRect = hdr.getBoundingClientRect();
    const cellTops = Array.from(
      document.querySelectorAll<HTMLElement>(".psl__cell[data-cell-id]")
    )
      .map((cell) => cell.getBoundingClientRect().top)
      .sort((a, b) => a - b);
    return { headerBottom: hdrRect.bottom, firstCellTop: cellTops[0] ?? null };
  });
  expect(rects.firstCellTop).not.toBeNull();
  if (rects.firstCellTop !== null) {
    expect(
      rects.firstCellTop,
      `first visible cell top (${rects.firstCellTop}px) is under the day ` +
        `banner (bottom edge ${rects.headerBottom}px)`
    ).toBeGreaterThanOrEqual(rects.headerBottom - 2);
  }
}

/** Scroll until the SECOND day's header is at/just above the viewport
 *  top — the first day's header is then inside the virtualizer's
 *  overscan (mounted, absolute, observed) while the second day's
 *  header is the active sticky. Precondition for the poisoning repro.
 *  Returns false if the topology never put row 0 in the overscan. */
async function scrollFirstHeaderIntoOverscan(window: Page): Promise<boolean> {
  const target = await window.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
    if (wrap === null) throw new Error("grid wrap missing");
    const rows = Array.from(wrap.querySelectorAll<HTMLElement>("[data-index]"));
    const headers = rows
      .filter((el) => el.querySelector(".psl__day-hdr") !== null)
      .map((el) => {
        const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform ?? "");
        return { idx: Number(el.getAttribute("data-index")), y: m === null ? null : Number(m[1]) };
      })
      .sort((a, b) => a.idx - b.idx);
    const second = headers.find((h) => h.idx > 0 && h.y !== null);
    return second?.y ?? null;
  });
  if (target === null) return false;

  await window.evaluate((top) => {
    const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
    if (wrap === null) throw new Error("grid wrap missing");
    wrap.scrollTop = top + 10;
  }, target);
  await window.waitForTimeout(300);

  // Verify the precondition actually holds: row 0 rendered and
  // NON-sticky (i.e. mounted via overscan, observed by the
  // virtualizer's ResizeObserver).
  const probe = await probeGrid(window);
  const row0 = probe.rows.find((r) => r.idx === 0);
  return row0 !== undefined && !row0.sticky;
}

async function toggleView(window: Page, label: "Reel" | "Grid"): Promise<void> {
  await window.click(`.psl__view-btn:has-text("${label}")`);
  await window.waitForSelector(
    label === "Reel" ? '.psl[data-mode="reel"]' : '.psl[data-mode="grid"]'
  );
}

type GridDebugDump = {
  cache: [number, number][];
  observed: number[];
  offset: number | null;
  total: number;
  activeSticky: number;
};

/** Read the virtualizer's internal state via the renderer's
 *  `__PWRSNAP_GRID_DEBUG__` hook (installed by VirtualizedGrid). */
async function dumpGrid(window: Page): Promise<GridDebugDump> {
  const dump = await window.evaluate(() => {
    const hook = (window as unknown as {
      __PWRSNAP_GRID_DEBUG__?: { dump: () => unknown };
    }).__PWRSNAP_GRID_DEBUG__;
    return hook === undefined ? null : hook.dump();
  });
  expect(dump, "__PWRSNAP_GRID_DEBUG__ hook installed").not.toBeNull();
  return dump as GridDebugDump;
}

function expectNoZeroSizes(dump: GridDebugDump, context: string): void {
  const zeroed = dump.cache.filter(([, size]) => size <= 0);
  expect(
    zeroed,
    `${context}: itemSizeCache entries poisoned to zero ` +
      `(flat-row indexes ${zeroed.map(([i]) => i).join(", ")}) — the ` +
      `display:none ResizeObserver pass wrote 0 sizes`
  ).toHaveLength(0);
}

// Short first day (6 captures ⇒ 1-2 cell rows at the 1440px layout) +
// three fuller previous days. The short first day is what lets its
// header sit inside the overscan while the second day's header is
// active.
const SHORT_FIRST_DAY: SeedDay[] = [
  { dayOffset: 0, count: 6 },
  { dayOffset: 1, count: 24 },
  { dayOffset: 2, count: 24 },
  { dayOffset: 3, count: 24 }
];

test.describe("Library grid — day banner overlap", () => {
  test("hiding the grid (reel mode) must not zero the virtualizer's cached row sizes", async () => {
    // The deterministic root-cause assertion. Entering Reel sets the
    // grid wrap to display:none; the per-item ResizeObserver then
    // fires 0-height entries for every observed row, and (unguarded)
    // virtual-core writes those zeros into itemSizeCache. Everything
    // user-visible — the collapsed scrollHeight, the clamped
    // scrollTop, and the rows piling up underneath the pinned day
    // banner when a re-measure race is lost on return — follows from
    // those zeros. The cache must stay intact while hidden and after
    // returning.
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "cache-zero");
      const window = app.window;
      await waitForGrid(window, 8);

      const scrolled = await scrollFirstHeaderIntoOverscan(window);
      expect(scrolled, "first day header mounted non-sticky in overscan").toBe(true);
      const before = await dumpGrid(window);
      expectNoZeroSizes(before, "before reel");
      expect(before.cache.length).toBeGreaterThan(8);

      await toggleView(window, "Reel");
      await window.waitForTimeout(600);
      const hidden = await dumpGrid(window);
      expectNoZeroSizes(hidden, "while hidden in reel");

      await toggleView(window, "Grid");
      await window.waitForTimeout(600);
      const restored = await dumpGrid(window);
      expectNoZeroSizes(restored, "after returning to grid");
    } finally {
      await app.close();
    }
  });

  test("reel round-trip preserves the grid scroll position", async () => {
    // User-visible corollary of the same zero-poisoning: with the
    // cache zeroed while hidden, the wrap's scrollHeight collapses,
    // Chromium clamps scrollTop to 0, and leaving Reel dumps the user
    // back at the top of the library instead of where they were. With
    // the cache intact the total virtual height never collapses and
    // native scrollTop preservation just works.
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "reel-scrollpos");
      const window = app.window;
      await waitForGrid(window, 8);

      const scrolled = await scrollFirstHeaderIntoOverscan(window);
      expect(scrolled, "first day header mounted non-sticky in overscan").toBe(true);
      const before = await window.evaluate(
        () => document.querySelector<HTMLElement>(".psl__grid-wrap")?.scrollTop ?? -1
      );
      expect(before).toBeGreaterThan(0);

      await toggleView(window, "Reel");
      await window.waitForTimeout(600);
      await toggleView(window, "Grid");
      await window.waitForTimeout(600);

      const after = await window.evaluate(
        () => document.querySelector<HTMLElement>(".psl__grid-wrap")?.scrollTop ?? -1
      );
      expect(
        Math.abs(after - before),
        `grid scrollTop after reel round-trip (${after}) should stay near ${before}`
      ).toBeLessThan(50);
    } finally {
      await app.close();
    }
  });

  test("reel round-trip while scrolled past a short first day must not corrupt the day banner layout", async () => {
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "reel-poison");
      const window = app.window;
      await waitForGrid(window, 8);

      // Baseline: layout at top is sane before we do anything.
      await expectNoOverlapAtTop(window);

      const preconditionMet = await scrollFirstHeaderIntoOverscan(window);
      expect(preconditionMet, "first day header mounted non-sticky in overscan").toBe(true);

      // Reel hides the grid (display:none, still mounted): the
      // ResizeObserver pass fires 0-heights for every observed row.
      await toggleView(window, "Reel");
      await window.waitForTimeout(500);
      await toggleView(window, "Grid");
      await window.waitForTimeout(500);

      await expectNoOverlapAtTop(window);
    } finally {
      await app.close();
    }
  });

  test("focus round-trip while scrolled past a short first day must not corrupt the day banner layout", async () => {
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "focus-poison");
      const window = app.window;
      await waitForGrid(window, 8);

      await expectNoOverlapAtTop(window);

      const preconditionMet = await scrollFirstHeaderIntoOverscan(window);
      expect(preconditionMet, "first day header mounted non-sticky in overscan").toBe(true);

      // Open Focus via double-click on a currently-visible cell, then
      // close with Escape. Focus display:none's the grid just like
      // Reel does.
      const cellId = await window.evaluate(() => {
        const wrap = document.querySelector<HTMLElement>(".psl__grid-wrap");
        if (wrap === null) throw new Error("grid wrap missing");
        const wrapRect = wrap.getBoundingClientRect();
        const cell = Array.from(
          document.querySelectorAll<HTMLElement>(".psl__cell[data-cell-id]")
        ).find((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= wrapRect.top + 20 && r.bottom <= wrapRect.bottom - 20;
        });
        return cell?.getAttribute("data-cell-id") ?? null;
      });
      expect(cellId).not.toBeNull();
      await window.dblclick(`.psl__cell[data-cell-id="${cellId}"]`);
      await window.waitForSelector('.psl[data-mode="focus"]');
      await window.waitForTimeout(500);
      await window.keyboard.press("Escape");
      await window.waitForSelector('.psl[data-mode="grid"]');
      await window.waitForTimeout(500);

      await expectNoOverlapAtTop(window);
    } finally {
      await app.close();
    }
  });

  test("poisoned banner layout must not persist while new captures arrive", async () => {
    // Mirrors the real-world report: the corruption forms early (short
    // first day + a reel round-trip), then captures keep arriving all
    // day — flat-row 0 stays the same day header, so a poisoned cached
    // size survives every re-flatten and the overlap persists for
    // hours. After arrivals the grid must still lay out cleanly.
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "arrival");
      const window = app.window;
      await waitForGrid(window, 8);

      const preconditionMet = await scrollFirstHeaderIntoOverscan(window);
      expect(preconditionMet, "first day header mounted non-sticky in overscan").toBe(true);

      await toggleView(window, "Reel");
      await window.waitForTimeout(500);
      await toggleView(window, "Grid");
      await window.waitForTimeout(500);

      // A fresh capture lands in the first day while the app is open.
      await seedDays(app, [{ dayOffset: 0, count: 3 }], "arrival-late");
      await window.waitForTimeout(500);

      await expectNoOverlapAtTop(window);
    } finally {
      await app.close();
    }
  });

  test("reel round-trip at the top of the library keeps the banner layout intact", async () => {
    // Control case: at the top the first day's header is the active
    // sticky (unobserved) the whole time, so the hide/show cycle must
    // not disturb it.
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "reel-top");
      const window = app.window;
      await waitForGrid(window, 8);

      await toggleView(window, "Reel");
      await window.waitForTimeout(500);
      await toggleView(window, "Grid");
      await window.waitForTimeout(500);

      await expectNoOverlapAtTop(window);
    } finally {
      await app.close();
    }
  });

  test("window resizes across column-count boundaries keep the banner layout intact", async () => {
    // Resize churn re-flattens flatRows at each new column count while
    // the size cache is keyed by flat index — stale sizes land on the
    // wrong rows until re-measured. The end state must always heal.
    const app = await launchPwrSnap({ windowSize: { width: 1440, height: 900 } });
    try {
      await seedDays(app, SHORT_FIRST_DAY, "resize");
      const window = app.window;
      await waitForGrid(window, 8);

      const preconditionMet = await scrollFirstHeaderIntoOverscan(window);
      expect(preconditionMet, "first day header mounted non-sticky in overscan").toBe(true);

      for (const width of [1040, 1440, 900, 1440]) {
        await app.electronApp.evaluate(({ BrowserWindow }, w) => {
          // Positive library-URL match — see the identical filter in
          // fixtures/electron-app.ts for why a bare "no stage=region"
          // check can steal the resize onto a still-loading selector.
          const win = BrowserWindow.getAllWindows().find((x) => {
            if (x.isDestroyed()) return false;
            const url = x.webContents.getURL();
            return url.includes("/renderer/index.html") && !url.includes("stage=region");
          });
          if (!win) throw new Error("no live library BrowserWindow to resize");
          win.setContentSize(w, 900);
        }, width);
        await window.waitForTimeout(350);
      }

      await expectNoOverlapAtTop(window);
    } finally {
      await app.close();
    }
  });
});
