// Tray first-paint baseline + regression spec.
//
// What this measures: the time between a tray-icon click and a fully-
// painted, size-stable tray popover, on a freshly-launched app. This
// is the "schtick" first-click latency users feel — every subsequent
// click is fast because the BrowserWindow + renderer process is warm.
//
// Why it's a separate spec: tray-sizing.spec.ts already exercises the
// popover sizing math, but it's correctness-focused — it doesn't care
// whether the popover took 50ms or 5000ms to land at its final size.
// This spec just times the path and dumps the per-launch numbers; it
// asserts nothing tight, so it's safe to land before optimizations.
//
// Output: each run prints a table of checkpoint deltas to stdout. The
// summary at the end averages across N runs so the optimization PR
// can paste a before/after diff into the description.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";
const ITERATIONS = Number.parseInt(process.env.PWRSNAP_TRAY_PAINT_RUNS ?? "5", 10);

/**
 * Produce a real PNG on disk and return its path + sha. Used to seed
 * the "user has prior snaps" measurement variant — the tray's last-
 * snap preview only renders when there's something to show, which
 * pulls in image decode + custom-protocol fetch on the first-paint
 * critical path.
 */
async function makeFixturePng(
  widthPx: number,
  heightPx: number
): Promise<{ pngPath: string; sha256: string; byteSize: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-tray-paint-spec-"));
  const pngPath = path.join(dir, "fixture.png");
  const buf = await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 200, g: 80, b: 40 }
    }
  })
    .png()
    .toBuffer();
  await writeFile(pngPath, buf);
  return {
    pngPath,
    sha256: `tray-paint-spec-${widthPx}x${heightPx}-${buf.length}-${Date.now()}`,
    byteSize: buf.length
  };
}

async function seedLatestCapture(
  app: LaunchedApp,
  pngPath: string,
  widthPx: number,
  heightPx: number,
  sha256: string,
  byteSize: number
): Promise<void> {
  const captureId = `tray-paint-${Date.now().toString(36)}`;
  await app.electronApp.evaluate(
    (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: { seedCapture: (input: Record<string, unknown>) => unknown };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.captureId,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.tray-paint-spec",
        source_app_name: "Tray Paint Spec",
        src_path: payload.pngPath,
        width_px: payload.widthPx,
        height_px: payload.heightPx,
        device_pixel_ratio: 2,
        byte_size: payload.byteSize,
        sha256: payload.sha256
      });
    },
    { captureId, pngPath, widthPx, heightPx, sha256, byteSize }
  );
}

type Checkpoints = {
  mode: "cold" | "prewarmed";
  windowCreated: number | null;
  domReady: number | null;
  didFinishLoad: number | null;
  readyToShow: number | null;
  isVisible: number | null;
  firstResize: number | null;
  stableResize: number | null;
  finalContentHeight: number | null;
  resizeCount: number;
  timedOut: boolean;
};

async function measure(app: LaunchedApp): Promise<Checkpoints> {
  return (await app.electronApp.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__: { measureTrayFirstPaint: () => Promise<unknown> };
      }
    ).__PWRSNAP_TEST__;
    return await bridge.measureTrayFirstPaint();
  })) as Checkpoints;
}

/**
 * Drive the pre-warm bridge — creates the hidden tray window so the
 * subsequent measure() call lands on the "prewarmed" code path. Waits
 * for the renderer to finish its initial resize (otherwise the next
 * show() races the in-flight measurement and the timings get noisy).
 */
async function prewarmTrayPopover(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__: { prewarmTrayPopover: () => void };
      }
    ).__PWRSNAP_TEST__;
    bridge.prewarmTrayPopover();
  });
  // Let the pre-warmed renderer mount + post its first resize before
  // we measure the show() path. Without this hold, runs alternate
  // between "the resize is in flight when we measure" (slow + noisy)
  // and "stable when we measure" (fast). The user's first click in
  // production will always land on the stable case.
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Hide the library window. We deliberately do NOT destroy it (or the
 * pre-warmed region selectors / focus-sink) — destroying the library
 * + selectors at the same time tends to cascade into "no library
 * window" launches on the next iteration. And in real life, users
 * close the library by clicking the red traffic-light, which under
 * Electron's default close → hide handling on macOS leaves the
 * renderer process alive. The tray + library + selectors all load
 * the same file:// origin, so under Chromium's process-per-site
 * default they share one renderer process either way.
 *
 * Net result: this is a "library backgrounded, app idle" scenario —
 * the most common state when a user clicks the tray.
 */
async function hideLibraryWindow(app: LaunchedApp): Promise<void> {
  await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      const url = w.webContents.getURL();
      if (url.includes("stage=")) continue; // selectors, focus-sink, etc.
      if (w.isVisible()) w.hide();
    }
  });
}

function fmt(value: number | null): string {
  if (value === null) return "    —";
  return value.toFixed(1).padStart(7) + " ms";
}

function summarize(label: string, samples: number[]): string {
  if (samples.length === 0) return `${label.padEnd(22)}    —`;
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return (
    `${label.padEnd(22)} ` +
    `min ${min.toFixed(0).padStart(5)} ` +
    `p50 ${median.toFixed(0).padStart(5)} ` +
    `mean ${mean.toFixed(0).padStart(5)} ` +
    `max ${max.toFixed(0).padStart(5)} ms`
  );
}

test.describe("tray popover first-paint baseline", () => {
  // The bridge function exercises NSPanel-only window options. On
  // Linux the production tray itself is also skipped (no menubar
  // story), so the measurement isn't meaningful there.
  test.skip(
    !isMac && process.platform !== "win32",
    "tray popover first-paint runs on macOS + Windows (Linux/xvfb excluded)"
  );

  // Each scenario carries its expected popover height range so the
  // hard-floor assertion below can reject the constructor-frame
  // regression (440×440 stuck) specifically — not just absurdly small
  // values. The 440 case is what the inline-block measurement
  // machinery was added to defeat; a regression that re-introduced
  // it would otherwise paint a popover too short or too tall by ~150
  // px and still pass a generic `> 100` floor.
  for (const scenario of [
    { label: "cold | empty library", seed: false, prewarm: false, minHeight: 200, maxHeight: 320 },
    { label: "cold | 1 seeded capture", seed: true, prewarm: false, minHeight: 420, maxHeight: 560 },
    { label: "prewarmed | empty library", seed: false, prewarm: true, minHeight: 200, maxHeight: 320 },
    { label: "prewarmed | 1 seeded capture", seed: true, prewarm: true, minHeight: 420, maxHeight: 560 }
  ] as const) {
    test(`${scenario.label}: first click → painted (×${ITERATIONS} cold launches)`, async () => {
      test.setTimeout(180_000);
      const runs: Checkpoints[] = [];

      // Pre-bake a fixture PNG once per scenario; we re-use the same
      // file across iterations to keep per-launch overhead consistent.
      const fixture = scenario.seed
        ? await makeFixturePng(1280, 800)
        : null;

      for (let i = 0; i < ITERATIONS; i += 1) {
        const app = await launchPwrSnap();
        try {
          if (fixture !== null) {
            await seedLatestCapture(
              app,
              fixture.pngPath,
              1280,
              800,
              `${fixture.sha256}-${i}`,
              fixture.byteSize
            );
          }
          // Mirror the "user has the library closed" idle state — most
          // common scenario at tray-click time. See helper for why this
          // is a hide, not a destroy.
          await hideLibraryWindow(app);
          if (scenario.prewarm) {
            await prewarmTrayPopover(app);
          }
          const result = await measure(app);
          runs.push(result);
          // eslint-disable-next-line no-console
          console.log(
            `[${scenario.label} ${i + 1}/${ITERATIONS}] ` +
              `windowCreated=${fmt(result.windowCreated)} ` +
              `domReady=${fmt(result.domReady)} ` +
              `didFinishLoad=${fmt(result.didFinishLoad)} ` +
              `readyToShow=${fmt(result.readyToShow)} ` +
              `isVisible=${fmt(result.isVisible)} ` +
              `firstResize=${fmt(result.firstResize)} ` +
              `stableResize=${fmt(result.stableResize)} ` +
              `resizeCount=${result.resizeCount} ` +
              `height=${result.finalContentHeight ?? "—"} ` +
              `timedOut=${result.timedOut}`
          );
        } finally {
          await app.close();
        }
      }

      const pick = (key: keyof Checkpoints): number[] =>
        runs
          .map((r) => r[key])
          .filter((v): v is number => typeof v === "number");

      // eslint-disable-next-line no-console
      console.log(`\n────── tray first-paint summary [${scenario.label}] ──────`);
      for (const key of [
        "windowCreated",
        "domReady",
        "didFinishLoad",
        "readyToShow",
        "isVisible",
        "firstResize",
        "stableResize"
      ] as const) {
        // eslint-disable-next-line no-console
        console.log(summarize(key, pick(key)));
      }
      // eslint-disable-next-line no-console
      console.log(
        `iterations=${runs.length} ` +
          `timeouts=${runs.filter((r) => r.timedOut).length} ` +
          `mean resizeCount=${
            (runs.reduce((a, r) => a + r.resizeCount, 0) / Math.max(runs.length, 1)).toFixed(1)
          }`
      );
      // eslint-disable-next-line no-console
      console.log("────────────────────────────────────────────────────────\n");

      for (const [i, r] of runs.entries()) {
        if (r.timedOut) {
          throw new Error(
            `run ${i + 1}: tray popover never reached stable size within bridge timeout`
          );
        }
        // Cold mode: renderer must post at least one resize event
        // (measures content height on mount). Pre-warmed mode: the
        // renderer already measured during pre-warm; firstResize is
        // legitimately null because no fresh resize fires during show().
        if (r.mode === "cold" && r.firstResize === null) {
          throw new Error(`run ${i + 1}: cold renderer never posted a resize event`);
        }
        // Both modes: the popover must land inside the scenario's
        // expected height window. Specifically rules out the 440×440
        // constructor-frame regression (would land at height=440 if
        // the renderer's resize never took effect) — a plain `> 100`
        // floor would PASS for that bug, defeating the spec.
        if (r.finalContentHeight === null) {
          throw new Error(`run ${i + 1}: tray popover content height is null`);
        }
        if (r.finalContentHeight === 440) {
          throw new Error(
            `run ${i + 1}: tray popover stuck at constructor frame 440 — ` +
              `the renderer's resize IPC didn't size the window (regression of the ` +
              `setMinimumSize(0,0) + inline-block measurement machinery)`
          );
        }
        if (
          r.finalContentHeight < scenario.minHeight ||
          r.finalContentHeight > scenario.maxHeight
        ) {
          throw new Error(
            `run ${i + 1}: tray popover height ${r.finalContentHeight} ` +
              `outside expected range [${scenario.minHeight}, ${scenario.maxHeight}] ` +
              `for scenario "${scenario.label}"`
          );
        }
      }
    });
  }
});
