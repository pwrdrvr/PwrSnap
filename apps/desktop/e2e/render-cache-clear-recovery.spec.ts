// Clearing source.png must leave both resized copies and source reuse
// working. V2 composition reads verified bytes directly from the bundle:
// Copy Med needs no extracted source file. An unedited Copy High reuses
// the original and must lazily restore that file after the cache wipe.
//
// macOS-only — same reason as clipboard-copy.spec.ts (NativeImage
// round-trip is most consistent on the platform PwrSnap ships to
// in Phase 1; cross-platform clipboard lands in Phase 8).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, launchPwrSnap, test } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

/**
 * Write a real PNG to a temp dir for persistCaptureFromTempV2 to
 * adopt. The dimensions are picked so the clipboard:copy preset
 * widths (low=800, med=1440) actually exercise the resize path.
 */
async function makeTempPng(widthPx: number, heightPx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-clear-recovery-"));
  const pngPath = path.join(dir, "fixture.png");
  const buf = await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 30, g: 144, b: 255 }
    }
  })
    .png()
    .toBuffer();
  await writeFile(pngPath, buf);
  return pngPath;
}

type BundleSeed = {
  captureId: string;
  cacheSourcePath: string;
};

/**
 * Run the production persistCaptureFromTempV2 pipeline through the
 * E2E bridge so the seeded capture has a real .pwrsnap bundle on
 * disk and a real per-capture source.png under render-cache. Returns
 * the captureId + the expected cache source.png path so the spec
 * can assert against it directly.
 *
 * `outputDir` is pinned under the test's tmpdir HOME so the spec
 * knows the bundle's exact location. (E2E launches also rebase
 * `app.getPath("documents")` under the tmpdir HOME, so even the
 * `getCapturesRoot()` default stays out of the host machine's real
 * `~/Documents/PwrSnap`.)
 */
async function seedBundleCapture(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  tempPath: string,
  outputDir: string
): Promise<BundleSeed> {
  return await app.electronApp.evaluate(
    async (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            persistBundleCapture: (input: {
              tempPath: string;
              sourceApp: { bundleId: string | null; appName: string | null } | null;
              outputDir?: string;
            }) => Promise<{ record: { id: string } }>;
            getCacheSourcePathFor: (id: string) => string;
          };
        }
      ).__PWRSNAP_TEST__;
      const { record } = await bridge.persistBundleCapture({
        tempPath: payload.tempPath,
        sourceApp: { bundleId: "com.test.clear-recovery", appName: "Clear Recovery Spec" },
        outputDir: payload.outputDir
      });
      return {
        captureId: record.id,
        cacheSourcePath: bridge.getCacheSourcePathFor(record.id)
      };
    },
    { tempPath, outputDir }
  );
}

async function readClipboardImage(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<{ width: number; height: number; isEmpty: boolean } | null> {
  return await app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__: {
          readClipboardImage: () => {
            width: number;
            height: number;
            isEmpty: boolean;
          } | null;
        };
      }
    ).__PWRSNAP_TEST__;
    return bridge.readClipboardImage();
  });
}

async function clearClipboard(app: Awaited<ReturnType<typeof launchPwrSnap>>): Promise<void> {
  await app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: { clearClipboard: () => void } }
    ).__PWRSNAP_TEST__;
    bridge.clearClipboard();
  });
}

test.describe("render-cache clear → bundle source recovery", () => {
  test.skip(
    !isMac,
    "clipboard NativeImage round-trip is macOS-only in Phase 1; same gate as clipboard-copy.spec.ts"
  );

  test("clipboard:copy recovers after cache clear and only extracts a source for reuse", async () => {
    const app = await launchPwrSnap();
    try {
      // The Library's preset metrics can independently request the original
      // and restore source.png. Close it before seeding so this assertion
      // observes only the clipboard consumer of the shared source cache.
      await app.window.close();

      // 1. Seed a real bundle capture — persistCaptureFromTempV2 packs
      //    the .pwrsnap and materializes <userData>/render-cache/<id>/source.png.
      //    outputDir is pinned under homeRoot so the spec controls the
      //    bundle's location explicitly (E2E launches also rebase
      //    app.getPath("documents") under homeRoot, so even the default
      //    would stay off the host's real ~/Documents/PwrSnap).
      const tempPath = await makeTempPng(2400, 1500);
      const bundleDir = path.join(app.homeRoot, "captures");
      const { captureId, cacheSourcePath } = await seedBundleCapture(app, tempPath, bundleDir);
      expect(
        existsSync(cacheSourcePath),
        "persistCaptureFromTempV2 should materialize source.png under render-cache"
      ).toBe(true);

      // 2. Reproduce the post-wipe state by deleting the cache file
      //    directly. `storage:maintainRenderCache mode='clear'` would
      //    produce the same end state but pulls in a storage-snapshot
      //    scan that walks the host's real ~/Documents/PwrSnap on
      //    macOS — slow and unrelated to what we're testing. The
      //    integration we care about is "cache gone → next read
      //    recovers," which doesn't depend on which path nuked it.
      await rm(cacheSourcePath, { force: true });
      expect(existsSync(cacheSourcePath), "cache source.png should be wiped").toBe(false);

      // 3. + 4. V2 composition renders directly from the durable bundle.
      await clearClipboard(app);
      const copyResult = await app.dispatch("clipboard:copy", { captureId, preset: "med" });
      expect(copyResult.ok, `clipboard:copy after wipe failed: ${JSON.stringify(copyResult)}`).toBe(
        true
      );

      const img = await readClipboardImage(app);
      expect(img, "clipboard should hold an image after the recovered copy").not.toBeNull();
      expect(img!.isEmpty).toBe(false);
      // med preset resizes to ~1440px wide on a 2400×1500 source.
      // Allow ±2px tolerance (same tolerance band as clipboard-copy.spec.ts).
      expect(img!.width).toBeGreaterThanOrEqual(1438);
      expect(img!.width).toBeLessThanOrEqual(1442);

      expect(existsSync(cacheSourcePath), "Copy Med needs no extracted source file").toBe(false);

      // 5. Source-sized unedited output reuses the original instead of
      //    composing. That caller still needs lazy source extraction.
      await clearClipboard(app);
      const highResult = await app.dispatch("clipboard:copy", { captureId, preset: "high" });
      expect(highResult.ok, `Copy High after wipe failed: ${JSON.stringify(highResult)}`).toBe(true);
      const highImage = await readClipboardImage(app);
      expect(highImage).toMatchObject({ isEmpty: false, width: 2400, height: 1500 });
      expect(
        existsSync(cacheSourcePath),
        "source reuse should re-materialize source.png after the cache wipe"
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
