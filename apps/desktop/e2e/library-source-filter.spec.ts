import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";

const HEAD_PAGE_SIZE = 100;
const PRIMARY_BUNDLE_ID = "com.pwrsnap.synth.recent-feed";
const FIXTURE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#14100e"/><rect x="64" y="72" width="672" height="456" rx="28" fill="#e8743a" opacity="0.88"/><circle cx="400" cy="300" r="120" fill="#f4d2bd" opacity="0.72"/></svg>`;

test.setTimeout(10_000);

type SourceFilterApp = Awaited<ReturnType<typeof launchPwrSnap>>;

type SourceFilterCase = {
  name: string;
  bundleId: string;
  sourceName: string;
  sidebarLabelPattern: RegExp;
  count: number;
  targetIndex: number;
  seedPrefix: string;
  headVisibleCount: number;
};

const CASES: SourceFilterCase[] = [
  {
    name: "Splashtop Business",
    bundleId: "com.splashtop.stb.macosx",
    sourceName: "Splashtop Business",
    sidebarLabelPattern: /^(?:Splashtop Business|Macosx)$/,
    count: 47,
    targetIndex: 1,
    seedPrefix: "splashtop",
    // One row in the head page normally lets the sidebar refine the
    // bundle tail ("Macosx") to the OS name ("Splashtop Business"),
    // while the target row still sits outside the initially-loaded
    // rows. CI can observe the app_stats-only label first, which is
    // fine for this test: the bucket still needs to filter correctly.
    headVisibleCount: 1
  },
  {
    name: "Telegram",
    bundleId: "ru.keepcoder.Telegram",
    sourceName: "Telegram",
    sidebarLabelPattern: /^Telegram$/,
    count: 4,
    targetIndex: 0,
    seedPrefix: "telegram",
    // Telegram is a curated app id, so the sidebar can show the
    // friendly label from APP_INFO even when every Telegram capture
    // is beyond the first page.
    headVisibleCount: 0
  },
  {
    name: "LINE",
    bundleId: "jp.naver.line.mac",
    sourceName: "LINE",
    sidebarLabelPattern: /^LINE$/,
    count: 4,
    targetIndex: 0,
    seedPrefix: "line",
    // Regression: deriving from the bundle tail produced "Mac" until
    // a LINE row entered the loaded head page. The app_stats payload
    // must carry the captured app name up front.
    headVisibleCount: 0
  }
];

test.describe("flaky source-app filter coverage", () => {
  // Per-test budget. 15s covers a cold Electron launch, 100+ row seed,
  // source-filter refetches, and teardown on the slowest CI runner we've
  // observed. The specs normally finish in ~1-5s; a longer timeout would
  // hide real hangs in the filter/refetch path.
  test.describe.configure({
    retries: process.env.CI ? 2 : 0,
    timeout: 15_000
  });

test("source-app filters load captures outside the initial virtualized page", async () => {
  const app = await launchSourceFilterPwrSnap();
  try {
    const window = app.window;
    await expect(window.getByRole("button", { name: /All Captures\s+0/ })).toBeVisible({
      timeout: 10_000
    });
    await disableAnimations(window);
    await disableCacheImageLoading(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-"));
    const imagePath = path.join(dir, "fixture.svg");
    await writeFile(imagePath, fixtureImageBytes());

    await app.electronApp.evaluate(
      (
        _electron,
        payload: {
          headPageSize: number;
          imagePath: string;
          primaryBundleId: string;
          cases: Array<{
            bundleId: string;
            sourceName: string;
            count: number;
            seedPrefix: string;
            headVisibleCount: number;
          }>;
        }
      ) => {
        type SeedInput = {
          id: string;
          kind: "image" | "video";
          captured_at: string;
          source_app_bundle_id: string | null;
          source_app_name: string | null;
          src_path: string;
          width_px: number;
          height_px: number;
          device_pixel_ratio: number;
          byte_size: number;
          sha256: string;
        };
        type Bridge = { seedCaptures: (inputs: SeedInput[]) => unknown };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        const now = Date.now();
        const recentCount = payload.headPageSize - Math.max(
          ...payload.cases.map((filterCase) => filterCase.headVisibleCount)
        );

        const inputs: SeedInput[] = [];
        for (let i = 0; i < recentCount; i++) {
          inputs.push({
            id: `source-filter-recent-${i.toString().padStart(3, "0")}`,
            kind: "image",
            captured_at: new Date(now - i * 1000).toISOString(),
            source_app_bundle_id: payload.primaryBundleId,
            source_app_name: "Recent Feed",
            src_path: payload.imagePath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: `source-filter-recent-${i.toString().padStart(3, "0")}`
          });
        }

        let olderOffsetSeconds = 0;
        for (const filterCase of payload.cases) {
          for (let i = 0; i < filterCase.count; i++) {
            const id = `source-filter-${filterCase.seedPrefix}-${i.toString().padStart(3, "0")}`;
            const capturedAt =
              i < filterCase.headVisibleCount
                ? new Date(now - (recentCount + olderOffsetSeconds + i) * 1000).toISOString()
                : new Date(
                    now - 24 * 60 * 60 * 1000 - (olderOffsetSeconds + i) * 1000
                  ).toISOString();
            inputs.push({
              id,
              kind: "image",
              captured_at: capturedAt,
              source_app_bundle_id: filterCase.bundleId,
              source_app_name: filterCase.sourceName,
              src_path: payload.imagePath,
              width_px: 800,
              height_px: 600,
              device_pixel_ratio: 1,
              byte_size: 70,
              sha256: id
            });
          }
          olderOffsetSeconds += filterCase.count;
        }
        bridge.seedCaptures(inputs);
      },
      {
        headPageSize: HEAD_PAGE_SIZE,
        imagePath,
        primaryBundleId: PRIMARY_BUNDLE_ID,
        cases: CASES.map(({ bundleId, sourceName, count, seedPrefix, headVisibleCount }) => ({
          bundleId,
          sourceName,
          count,
          seedPrefix,
          headVisibleCount
        }))
      }
    );

    // Tell the live renderer the captures changed instead of
    // reloading the whole window. The reload path destroys the
    // renderer mid-IPC (we just synchronously inserted 154 rows
    // via the bridge), which can leave broadcaster handlers
    // firing against a destroyed webContents and adds 200–1000ms
    // of cold-render cost the rest of the test doesn't need.
    await broadcastCapturesChanged(app);

    for (const filterCase of CASES) {
      await waitForAppStat(app, filterCase.bundleId, filterCase.count);
      await clickSourceFilterButton(window, filterCase);

      const targetId = `source-filter-${filterCase.seedPrefix}-${filterCase.targetIndex
        .toString()
        .padStart(3, "0")}`;
      await expect.poll(() => countGridCells(window, targetId), { timeout: 10_000 }).toBe(1);
    }
  } finally {
    await app.close();
  }
});

test("active source-app filter refetches after capture stats change", async () => {
  const filterCase = CASES.find((candidate) => candidate.seedPrefix === "telegram");
  if (filterCase === undefined) throw new Error("telegram case missing");

  const app = await launchSourceFilterPwrSnap();
  try {
    const window = app.window;
    await expect(window.getByRole("button", { name: /All Captures\s+0/ })).toBeVisible({
      timeout: 10_000
    });
    await disableAnimations(window);
    await disableCacheImageLoading(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-refresh-"));
    const imagePath = path.join(dir, "fixture.svg");
    await writeFile(imagePath, fixtureImageBytes());

    await app.electronApp.evaluate(
      (
        _electron,
        payload: {
          headPageSize: number;
          imagePath: string;
          primaryBundleId: string;
          targetBundleId: string;
          targetLabel: string;
          targetCount: number;
          seedPrefix: string;
        }
      ) => {
        type SeedInput = {
          id: string;
          kind: "image" | "video";
          captured_at: string;
          source_app_bundle_id: string | null;
          source_app_name: string | null;
          src_path: string;
          width_px: number;
          height_px: number;
          device_pixel_ratio: number;
          byte_size: number;
          sha256: string;
        };
        type Bridge = { seedCaptures: (inputs: SeedInput[]) => unknown };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        const now = Date.now();
        const inputs: SeedInput[] = [];
        for (let i = 0; i < payload.headPageSize; i++) {
          inputs.push({
            id: `source-filter-refresh-recent-${i.toString().padStart(3, "0")}`,
            kind: "image",
            captured_at: new Date(now - i * 1000).toISOString(),
            source_app_bundle_id: payload.primaryBundleId,
            source_app_name: "Recent Feed",
            src_path: payload.imagePath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: `source-filter-refresh-recent-${i.toString().padStart(3, "0")}`
          });
        }
        for (let i = 0; i < payload.targetCount; i++) {
          const id = `source-filter-refresh-${payload.seedPrefix}-${i.toString().padStart(3, "0")}`;
          inputs.push({
            id,
            kind: "image",
            captured_at: new Date(now - 24 * 60 * 60 * 1000 - i * 1000).toISOString(),
            source_app_bundle_id: payload.targetBundleId,
            source_app_name: payload.targetLabel,
            src_path: payload.imagePath,
            width_px: 800,
            height_px: 600,
            device_pixel_ratio: 1,
            byte_size: 70,
            sha256: id
          });
        }
        bridge.seedCaptures(inputs);
      },
      {
        headPageSize: HEAD_PAGE_SIZE,
        imagePath,
        primaryBundleId: PRIMARY_BUNDLE_ID,
        targetBundleId: filterCase.bundleId,
        targetLabel: filterCase.sourceName,
        targetCount: filterCase.count,
        seedPrefix: filterCase.seedPrefix
      }
    );

    // Broadcast instead of reload — see the note in the first
    // test in this file. Removes the renderer destroy-mid-IPC race
    // and saves a cold-render cycle.
    await broadcastCapturesChanged(app);

    await waitForAppStat(app, filterCase.bundleId, filterCase.count);
    await clickSourceFilterButton(window, filterCase);

    const targetId = "source-filter-refresh-telegram-000";
    await expect.poll(() => countGridCells(window, targetId), { timeout: 10_000 }).toBe(1);

    await app.electronApp.evaluate(
      (
        _electron,
        payload: {
          imagePath: string;
          targetBundleId: string;
          targetLabel: string;
        }
      ) => {
        type Bridge = {
          seedCapture: (input: {
            id: string;
            kind: "image" | "video";
            captured_at: string;
            source_app_bundle_id: string | null;
            source_app_name: string | null;
            src_path: string;
            width_px: number;
            height_px: number;
            device_pixel_ratio: number;
            byte_size: number;
            sha256: string;
          }) => unknown;
        };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        bridge.seedCapture({
          id: "source-filter-refresh-telegram-new",
          kind: "image",
          captured_at: new Date(Date.now() + 1000).toISOString(),
          source_app_bundle_id: payload.targetBundleId,
          source_app_name: payload.targetLabel,
          src_path: payload.imagePath,
          width_px: 800,
          height_px: 600,
          device_pixel_ratio: 1,
          byte_size: 70,
          sha256: "source-filter-refresh-telegram-new"
        });
      },
      {
        imagePath,
        targetBundleId: filterCase.bundleId,
        targetLabel: filterCase.sourceName
      }
    );

    await broadcastCapturesChanged(app);

    await waitForAppStat(app, filterCase.bundleId, filterCase.count + 1);
    await expect
      .poll(() => countGridCells(window, "source-filter-refresh-telegram-new"), { timeout: 10_000 })
      .toBe(1);
    await expect.poll(() => countGridCells(window, targetId), { timeout: 10_000 }).toBe(1);
  } finally {
    await app.close();
  }
});

});

test("top-level filters do not appear as empty source-app rows after leaving Unknown app focus", async () => {
  const app = await launchSourceFilterPwrSnap();
  try {
    const window = app.window;
    await disableAnimations(window);
    await disableCacheImageLoading(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-source-filter-unknown-"));
    const imagePath = path.join(dir, "fixture.svg");
    await writeFile(imagePath, fixtureImageBytes());

    await app.electronApp.evaluate(
      (_electron, payload: { imagePath: string }) => {
        type Bridge = {
          seedCapture: (input: {
            id: string;
            kind: "image" | "video";
            captured_at: string;
            source_app_bundle_id: string | null;
            source_app_name: string | null;
            src_path: string;
            width_px: number;
            height_px: number;
            device_pixel_ratio: number;
            byte_size: number;
            sha256: string;
          }) => unknown;
        };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        bridge.seedCapture({
          id: "source-filter-unknown-null-bundle",
          kind: "image",
          captured_at: new Date().toISOString(),
          source_app_bundle_id: null,
          source_app_name: null,
          src_path: payload.imagePath,
          width_px: 800,
          height_px: 600,
          device_pixel_ratio: 1,
          byte_size: 70,
          sha256: "source-filter-unknown-null-bundle"
        });
      },
      { imagePath }
    );

    await broadcastCapturesChanged(app);

    await waitForAppStat(app, null, 1);

    const unknownSourceButton = window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Unknown app$/ }) })
      .filter({ has: window.locator(".psl__nav-count", { hasText: /^1$/ }) });
    await expect(unknownSourceButton).toHaveCount(1, { timeout: 10_000 });

    await unknownSourceButton.first().click();
    await expect(window.locator(".psl__cell[data-cell-id='source-filter-unknown-null-bundle']")).toHaveCount(1, {
      timeout: 10_000
    });

    // Double-click opens Focus (single-click selects in the grid-first model).
    await window.locator(".psl__cell[data-cell-id='source-filter-unknown-null-bundle']").dblclick();
    await expect(window.locator(".psl")).toHaveAttribute("data-mode", "focus", {
      timeout: 10_000
    });

    // Edit is a takeover — the left nav (filters) is hidden in Focus, so
    // leave Focus via Esc before navigating filters.
    await window.keyboard.press("Escape");
    await expect(window.locator(".psl")).toHaveAttribute("data-mode", "grid", {
      timeout: 10_000
    });

    await window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Today$/ }) })
      .click();

    const unknownSourceRows = window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Unknown app$/ }) });
    await expect(unknownSourceRows).toHaveCount(1);
    await expect(unknownSourceRows.first().locator(".psl__nav-count")).toHaveText("1");
  } finally {
    await app.close();
  }
});

const isMac = process.platform === "darwin";

test("Source-app sidebar row renders the real bundle icon for an installed app (Finder)", async () => {
  // Bundle-icon resolution goes through the Swift helper +
  // NSWorkspace.urlForApplication(...). Both are macOS-only and
  // require the helper binary the postinstall step compiles.
  test.skip(!isMac, "app-icon extraction is macOS-only");

  // Finder is present on every macOS Playwright runner — guaranteed
  // to resolve via NSWorkspace and produce a real PNG. Using a
  // synthetic bundle id would 404 and fall back to the procedural
  // glyph, defeating the assertion.
  const FINDER_BUNDLE_ID = "com.apple.finder";

  const app = await launchSourceFilterPwrSnap();
  try {
    const window = app.window;
    await disableAnimations(window);
    await disableCacheImageLoading(window);

    const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-app-icon-e2e-"));
    const imagePath = path.join(dir, "fixture.svg");
    await writeFile(imagePath, fixtureImageBytes());

    await app.electronApp.evaluate(
      (_electron, payload: { imagePath: string; bundleId: string }) => {
        type Bridge = {
          seedCapture: (input: {
            id: string;
            kind: "image" | "video";
            captured_at: string;
            source_app_bundle_id: string | null;
            source_app_name: string | null;
            src_path: string;
            width_px: number;
            height_px: number;
            device_pixel_ratio: number;
            byte_size: number;
            sha256: string;
          }) => unknown;
        };
        const bridge = (globalThis as unknown as { __PWRSNAP_TEST__: Bridge }).__PWRSNAP_TEST__;
        bridge.seedCapture({
          id: "app-icon-real-finder",
          kind: "image",
          captured_at: new Date().toISOString(),
          source_app_bundle_id: payload.bundleId,
          source_app_name: "Finder",
          src_path: payload.imagePath,
          width_px: 800,
          height_px: 600,
          device_pixel_ratio: 1,
          byte_size: 70,
          sha256: "app-icon-real-finder"
        });
      },
      { imagePath, bundleId: FINDER_BUNDLE_ID }
    );

    await broadcastCapturesChanged(app);
    await waitForAppStat(app, FINDER_BUNDLE_ID, 1);

    // The sidebar Source App row for Finder should:
    //   1. Exist and show the count.
    //   2. Contain an <img class="ps-app-icon-img"> — the real-icon
    //      path — NOT a procedural <svg>.
    //   3. The img must have loaded successfully (naturalWidth > 0).
    const finderRow = window
      .locator("button.psl__nav")
      .filter({ has: window.locator(".psl__nav-label", { hasText: /^Finder$/ }) });
    await expect(finderRow).toHaveCount(1, { timeout: 10_000 });

    const finderIconImg = finderRow.first().locator(".psl__nav-icon img.ps-app-icon-img");
    await expect(finderIconImg).toHaveCount(1, { timeout: 10_000 });

    // Wait for the protocol handler to extract + serve the PNG. The
    // <img> reports naturalWidth > 0 only after Chromium successfully
    // decoded the response body — if the protocol 404'd or the helper
    // failed, this stays at 0 and we'd know the integration broke.
    await expect
      .poll(
        async () =>
          finderIconImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

function fixtureImageBytes(): Buffer {
  return Buffer.from(FIXTURE_SVG, "utf8");
}

function launchSourceFilterPwrSnap(): ReturnType<typeof launchPwrSnap> {
  return launchPwrSnap({
    env: {
      PWRSNAP_E2E_SKIP_REGION_PREWARM: "1"
    }
  });
}

async function broadcastCapturesChanged(app: SourceFilterApp): Promise<void> {
  await app.electronApp.evaluate((electronModule) => {
    const { BrowserWindow } = electronModule;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("events:captures:changed", { changedIds: [] });
    }
  });
}

async function waitForAppStat(
  app: SourceFilterApp,
  bundleId: string | null,
  expectedCount: number
): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await app.dispatch("library:list", { limit: 1, includeDeleted: true });
        if (!result.ok) return -1;
        return result.value.appStats?.find((stat) => stat.bundleId === bundleId)?.count ?? 0;
      },
      {
        timeout: 10_000,
        message: `waiting for app_stats ${bundleId}=${expectedCount}`
      }
    )
    .toBe(expectedCount);
}

async function disableAnimations(page: SourceFilterApp["window"]): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `
  });
}

// These specs prove source-app filtering, not thumbnail rendering.
// On Linux/Xvfb the rapid source-filter swaps can trip Electron's
// native GTK/Chromium path while a burst of pwrsnap-cache:// images
// is decoding; suppress those incidental image requests so failures
// stay tied to the filter/query behavior this file owns.
async function disableCacheImageLoading(page: SourceFilterApp["window"]): Promise<void> {
  await page.evaluate(() => {
    const global = globalThis as unknown as {
      __PWRSNAP_E2E_CACHE_IMAGES_DISABLED__?: boolean;
    };
    if (global.__PWRSNAP_E2E_CACHE_IMAGES_DISABLED__ === true) return;
    global.__PWRSNAP_E2E_CACHE_IMAGES_DISABLED__ = true;

    const isCacheUrl = (value: unknown): boolean =>
      typeof value === "string" && value.startsWith("pwrsnap-cache://");

    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name: string, value: string): void {
      if (this instanceof HTMLImageElement && name.toLowerCase() === "src" && isCacheUrl(value)) {
        return;
      }
      return originalSetAttribute.call(this, name, value);
    };

    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    const srcGetter = srcDescriptor?.get;
    const srcSetter = srcDescriptor?.set;
    if (srcGetter === undefined || srcSetter === undefined) return;
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: true,
      enumerable: srcDescriptor?.enumerable ?? false,
      get(this: HTMLImageElement): string {
        return srcGetter.call(this) as string;
      },
      set(this: HTMLImageElement, value: string): void {
        if (isCacheUrl(value)) return;
        srcSetter.call(this, value);
      }
    });
  });
}

async function reloadLibraryWindow(page: SourceFilterApp["window"]): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /All Captures\s+\d+/ })).toBeVisible({
    timeout: 10_000
  });
  await disableAnimations(page);
  await disableCacheImageLoading(page);
}

async function clickSourceFilterButton(
  page: SourceFilterApp["window"],
  filterCase: SourceFilterCase
): Promise<void> {
  await expect
    .poll(
      () => clickMatchingSourceFilterButton(page, filterCase),
      {
        timeout: 10_000,
        message: `clicking rendered source filter ${filterCase.name}`
      }
    )
    .toBe(true);

  await expect
    .poll(
      () => sourceFilterButtonState(page, filterCase).then((state) => state.active),
      {
        timeout: 10_000,
        message: `activating source filter ${filterCase.name}`
      }
    )
    .toBe(true);
}

async function clickMatchingSourceFilterButton(
  page: SourceFilterApp["window"],
  filterCase: SourceFilterCase
): Promise<boolean> {
  return page.evaluate(
    ({ patternSource, patternFlags, count }) => {
      const pattern = new RegExp(patternSource, patternFlags);
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button.psl__nav"));
      for (const button of buttons) {
        const label = button.querySelector(".psl__nav-label")?.textContent?.trim() ?? "";
        const countText = button.querySelector(".psl__nav-count")?.textContent?.trim() ?? "";
        if (!pattern.test(label) || countText !== String(count)) continue;
        button.click();
        return true;
      }
      return false;
    },
    {
      patternSource: filterCase.sidebarLabelPattern.source,
      patternFlags: filterCase.sidebarLabelPattern.flags,
      count: filterCase.count
    }
  );
}

async function sourceFilterButtonState(
  page: SourceFilterApp["window"],
  filterCase: SourceFilterCase
): Promise<{ active: boolean }> {
  return page.evaluate(
    ({ patternSource, patternFlags, count }) => {
      const pattern = new RegExp(patternSource, patternFlags);
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button.psl__nav"));
      for (const button of buttons) {
        const label = button.querySelector(".psl__nav-label")?.textContent?.trim() ?? "";
        const countText = button.querySelector(".psl__nav-count")?.textContent?.trim() ?? "";
        if (!pattern.test(label) || countText !== String(count)) continue;
        return { active: button.classList.contains("is-active") };
      }
      return { active: false };
    },
    {
      patternSource: filterCase.sidebarLabelPattern.source,
      patternFlags: filterCase.sidebarLabelPattern.flags,
      count: filterCase.count
    }
  );
}

async function countGridCells(page: SourceFilterApp["window"], id: string): Promise<number> {
  return page.evaluate(
    (targetId) => document.querySelectorAll(`.psl__cell[data-cell-id="${targetId}"]`).length,
    id
  );
}
