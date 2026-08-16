// Linux/x64 and macOS/arm64 visual-regression coverage for the two primary
// PwrSnap renderer states. These are intentionally locator-scoped: native
// BrowserWindow frames and OS chrome are outside the renderer contract and
// vary by host.
//
// The reference images are lossless WebP and are generated in their matching
// CI environment. Update the Linux references with:
//
//   pnpm test:desktop-e2e:docker -- --platform linux/amd64 \
//     --test 'visual regression' --update-snapshots
//
// See CONTRIBUTING.md for the platform-specific baseline workflow and how the
// generated files are stored in Git LFS.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Page } from "@playwright/test";
import sharp from "sharp";
import { expect, type LaunchedApp, launchPwrSnap, test } from "./fixtures/electron-app";

const LIBRARY_WINDOW_SIZE = { width: 1280, height: 800 };
const FIXTURE_WIDTH = 1600;
const FIXTURE_HEIGHT = 1000;
const VISUAL_CLOCK_TIME = "2026-08-01T12:00:00.000Z";
const VISUAL_APP_VERSION = "1.2.3-beta.1";

const FIXTURE_CAPTURES = [
  {
    id: "visual-library-slate",
    capturedAt: "2026-01-14T14:20:00.000Z",
    sourceAppName: "Safari",
    background: { r: 28, g: 56, b: 92 }
  },
  {
    id: "visual-library-copper",
    capturedAt: "2026-01-14T14:10:00.000Z",
    sourceAppName: "Slack",
    background: { r: 128, g: 61, b: 30 }
  },
  {
    id: "visual-library-forest",
    capturedAt: "2026-01-14T14:00:00.000Z",
    sourceAppName: "Terminal",
    background: { r: 29, g: 92, b: 70 }
  }
] as const;

type VisualCapture = (typeof FIXTURE_CAPTURES)[number] & {
  tempPath: string;
};

/**
 * Make stable, real image sources inside the fixture HOME (so `close()`
 * cleans them up), then use the normal E2E bridge to seed Library records.
 * Fixed ids, timestamps, app names, dimensions, pixels, and renderer clock
 * keep both the rendered card data and its thumbnail deterministic.
 */
async function seedVisualCaptures(app: LaunchedApp): Promise<VisualCapture[]> {
  const fixtureDir = path.join(app.homeRoot, "visual-regression-fixtures");
  const bundleDir = path.join(app.homeRoot, "visual-regression-bundles");
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(bundleDir, { recursive: true });

  const captures = await Promise.all(
    FIXTURE_CAPTURES.map(async (capture) => {
      const tempPath = path.join(fixtureDir, `${capture.id}.png`);
      const png = await sharp({
        create: {
          width: FIXTURE_WIDTH,
          height: FIXTURE_HEIGHT,
          channels: 3,
          background: capture.background
        }
      })
        .png()
        .toBuffer();
      await writeFile(tempPath, png);
      return { ...capture, tempPath };
    })
  );

  const persistedIds = await app.electronApp.evaluate(
    (
      _electron,
      payload: Array<{
        id: string;
        capturedAt: string;
        sourceAppName: string;
        tempPath: string;
        outputDir: string;
      }>
    ) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            persistBundleCapture: (input: {
              tempPath: string;
              sourceApp: { bundleId: string; appName: string };
              captureId: string;
              capturedAt: string;
              devicePixelRatio: number;
              outputDir: string;
            }) => Promise<{ record: { id: string } }>;
          };
        }
      ).__PWRSNAP_TEST__;

      return Promise.all(
        payload.map(async (capture) => {
          const { record } = await bridge.persistBundleCapture({
            tempPath: capture.tempPath,
            sourceApp: {
              bundleId: `com.pwrsnap.visual.${capture.id}`,
              appName: capture.sourceAppName
            },
            captureId: capture.id,
            capturedAt: capture.capturedAt,
            devicePixelRatio: 1,
            outputDir: capture.outputDir
          });
          return record.id;
        })
      );
    },
    captures.map((capture) => ({
      ...capture,
      outputDir: bundleDir
    }))
  );

  expect(persistedIds).toEqual(captures.map((capture) => capture.id));
  await broadcastCapturesChanged(app, persistedIds);

  return captures;
}

// `persistBundleCapture` deliberately calls the persistence seam directly,
// unlike production's capture handler, so it does not broadcast to the
// already-loaded Library. Mirror the production event here before asserting
// the grid contents.
async function broadcastCapturesChanged(app: LaunchedApp, changedIds: string[]): Promise<void> {
  await app.electronApp.evaluate((electronModule, ids) => {
    const { BrowserWindow } = electronModule;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("events:captures:changed", { changedIds: ids });
    }
  }, changedIds);
}

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * Fail loudly if the backing scale pin did not take effect.
 *
 * Without this the harness degrades silently in the worst possible way:
 * a screenshot taken at 2x still LOOKS right, so `--update-snapshots`
 * run in an unpinned environment happily writes a golden that then
 * fails on every runner. That is exactly how the library-grid golden
 * broke main. Assert the pin instead of trusting it.
 *
 * Called from `launchVisualPwrSnap` rather than from each screenshot so
 * a new visual test cannot forget it — the scale cannot change during a
 * test, so checking once at launch is equivalent and un-skippable.
 *
 * NOTE on tolerance: this suite compares at Playwright's default (no
 * `maxDiffPixels`), because every macOS runner in the fleet reproduces
 * the goldens exactly once pinned — #395 passed on M2-Max, M5-Max and
 * pwrlab-m4 with zero tolerance. PwrAgnt's harness does carry a small
 * floor (20) because its lab guest and CI rasterize 8 pixels apart. If
 * PwrSnap ever generates goldens somewhere with a real floor, measure it
 * and add the tolerance then — do not copy the number across.
 */
async function expectPinnedDeviceScale(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
}

async function launchVisualPwrSnap(): Promise<LaunchedApp> {
  const app = await launchPwrSnap({
    env: {
      TZ: "UTC",
      PWRSNAP_E2E_APP_VERSION: VISUAL_APP_VERSION
    },
    // Pin the backing scale factor. Without this the goldens are
    // machine-specific: Chromium rasterizes at the attached display's
    // scale, so a Retina 2x session and a 1x session produce visibly
    // identical but pixel-different screenshots (`scale: "css"` only
    // normalizes the screenshot's logical size, not the rasterization).
    // Measured on the macOS runner fleet: the same commit rendered on a
    // 1x runner matched the golden exactly while a 2x session differed
    // by ~325k pixels — the whole window, every glyph edge — which reads
    // like a real regression but is pure environment drift. Forcing 1x
    // is what the current goldens already encode, so this is a no-op for
    // them; it just stops a differently-configured runner or a developer
    // on a Retina display from failing the suite.
    extraArgs: ["--force-device-scale-factor=1"],
    windowSize: LIBRARY_WINDOW_SIZE
  });
  // Library date buckets omit the year for captures in `new Date()`'s
  // calendar year. Freeze that value after the renderer has loaded but
  // before seeded records are converted into Library fixtures. Playwright's
  // setFixedTime intentionally leaves rendering timers running.
  await app.window.clock.setFixedTime(VISUAL_CLOCK_TIME);
  await expectPinnedDeviceScale(app.window);
  return app;
}

test.describe("visual regression", () => {
  // Screenshot baselines depend on the rendering platform. The project has
  // Linux/x64 and macOS/arm64 goldens. Linux CI temporarily excludes this
  // suite until its worker teardown is stable; the macOS VM is the active
  // visual CI lane. Windows continues to exercise behavioral E2E coverage.
  test.skip(
    process.platform !== "linux" && process.platform !== "darwin",
    "visual goldens are generated and compared in Linux/x64 and macOS/arm64 only"
  );

  test.setTimeout(120_000);

  test("library grid renders seeded captures", async () => {
    const app = await launchVisualPwrSnap();
    try {
      await seedVisualCaptures(app);
      const library = app.window.locator(".psl");

      await expect(library).toHaveAttribute("data-mode", "grid");
      await expect(app.window.locator(".psl__cell")).toHaveCount(FIXTURE_CAPTURES.length);
      await waitForFonts(app.window);
      await expect(app.window.locator(".psl__status-r b")).toHaveText(
        `v${VISUAL_APP_VERSION}`
      );

      await expect(library).toHaveScreenshot("library-grid.webp", {
        animations: "disabled",
        caret: "hide",
        scale: "css"
      });
    } finally {
      await app.close();
    }
  });

  test("editor focus renders the source canvas and chrome", async () => {
    const app = await launchVisualPwrSnap();
    try {
      const [firstCapture] = await seedVisualCaptures(app);
      const result = await app.dispatch("editor:open", { captureId: firstCapture.id });
      expect(result.ok, "editor:open should succeed").toBe(true);

      const focus = app.window.locator(".psl__focus");
      await expect(focus).toBeVisible();
      await expect(app.window.locator('[data-testid="editor-image"]')).toBeVisible();
      await waitForFonts(app.window);

      await expect(focus).toHaveScreenshot("editor-focus.webp", {
        animations: "disabled",
        caret: "hide",
        scale: "css"
      });
    } finally {
      await app.close();
    }
  });
});
