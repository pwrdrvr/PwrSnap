// Linux/x64 visual-regression coverage for the two primary PwrSnap renderer
// states. These are intentionally locator-scoped: native BrowserWindow
// frames and OS chrome are outside the renderer contract and vary by host.
//
// The reference images are lossless WebP and are generated in the same
// Linux/x64 Docker environment that CI uses. Update them with:
//
//   pnpm test:desktop-e2e:docker -- --platform linux/amd64 \
//     --test 'visual regression' --update-snapshots
//
// See CONTRIBUTING.md for why this suite is Linux-only and how the generated
// baseline files are stored in Git LFS.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";

const LIBRARY_WINDOW_SIZE = { width: 1280, height: 800 };
const FIXTURE_WIDTH = 1600;
const FIXTURE_HEIGHT = 1000;

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
  srcPath: string;
  byteSize: number;
};

/**
 * Make stable, real image sources inside the fixture HOME (so `close()`
 * cleans them up), then use the normal E2E bridge to seed Library records.
 * Fixed ids, timestamps, app names, dimensions, and pixels keep both the
 * rendered card data and its thumbnail deterministic.
 */
async function seedVisualCaptures(app: LaunchedApp): Promise<VisualCapture[]> {
  const fixtureDir = path.join(app.homeRoot, "visual-regression-fixtures");
  await mkdir(fixtureDir, { recursive: true });

  const captures = await Promise.all(
    FIXTURE_CAPTURES.map(async (capture) => {
      const srcPath = path.join(fixtureDir, `${capture.id}.png`);
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
      await writeFile(srcPath, png);
      return { ...capture, srcPath, byteSize: png.byteLength };
    })
  );

  await app.electronApp.evaluate(
    (
      _electron,
      payload: Array<{
        id: string;
        capturedAt: string;
        sourceAppName: string;
        srcPath: string;
        byteSize: number;
        width: number;
        height: number;
      }>
    ) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: {
              id: string;
              kind: "image";
              captured_at: string;
              source_app_bundle_id: string;
              source_app_name: string;
              legacy_src_path: string;
              width_px: number;
              height_px: number;
              device_pixel_ratio: number;
              byte_size: number;
              sha256: string;
            }) => void;
          };
        }
      ).__PWRSNAP_TEST__;

      for (const capture of payload) {
        bridge.seedCapture({
          id: capture.id,
          kind: "image",
          captured_at: capture.capturedAt,
          source_app_bundle_id: `com.pwrsnap.visual.${capture.id}`,
          source_app_name: capture.sourceAppName,
          legacy_src_path: capture.srcPath,
          width_px: capture.width,
          height_px: capture.height,
          device_pixel_ratio: 1,
          byte_size: capture.byteSize,
          sha256: `visual-${capture.id}`
        });
      }
    },
    captures.map((capture) => ({
      ...capture,
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT
    }))
  );

  return captures;
}

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test.describe("visual regression", () => {
  // Screenshot baselines depend on the rendering platform. The project has
  // Linux + Windows E2E jobs, but this focused suite uses the Linux/x64 job
  // as its one source of truth; Windows still exercises the behavioral E2E
  // coverage without requiring a second baseline set.
  test.skip(
    process.platform !== "linux",
    "visual goldens are generated and compared in Linux/x64 only"
  );

  test.setTimeout(120_000);

  test("library grid renders seeded captures", async () => {
    const app = await launchPwrSnap({
      env: { TZ: "UTC" },
      windowSize: LIBRARY_WINDOW_SIZE
    });
    try {
      await seedVisualCaptures(app);
      const library = app.window.locator(".psl");

      await expect(library).toHaveAttribute("data-mode", "grid");
      await expect(app.window.locator(".psl__cell")).toHaveCount(FIXTURE_CAPTURES.length);
      await waitForFonts(app.window);

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
    const app = await launchPwrSnap({
      env: { TZ: "UTC" },
      windowSize: LIBRARY_WINDOW_SIZE
    });
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
