// Render-cache clear-recovery spec — locks down the bug where
// Settings → Storage → "Clear" wiped the per-capture cached
// source.png that bundle-backed captures store under
// <userData>/render-cache/<id>/source.png. Pre-fix, the wipe left
// every thumbnail 500ing, Copy Med pasting un-decodable bytes,
// drag-out failing — because nothing lazy-re-extracted from the
// bundle. The fix in `ensureEffectiveSrcPath` re-materializes
// source.png on demand from the bundle (system of record).
//
// This spec exercises the end-to-end loop the user actually hit:
//
//   1. Seed a real bundle-backed capture (production
//      persistCaptureFromTempV2 path). Verify the per-capture
//      source.png lives under render-cache.
//   2. Delete the cache source.png from disk — same observable
//      end state as `storage:maintainRenderCache mode='clear'`,
//      but without depending on its storage-snapshot scan that
//      walks `getCapturesRoot()` (which resolves to the host's
//      real ~/Documents/PwrSnap on macOS — slow + unrelated to
//      what we're testing).
//   3. Dispatch clipboard:copy mode='med' — same command the
//      Library + Float-Over Copy buttons fire.
//   4. Assert the dispatch returns ok AND the clipboard holds a
//      non-empty NativeImage. Pre-fix the dispatch returned err
//      and the clipboard was unchanged (renderer fire-and-forgets
//      the err, so the user pasted whatever stale bytes were
//      already on the pasteboard).
//   5. Assert source.png was re-materialized at the expected cache
//      path so subsequent reads hit the fast path.
//
// macOS-only — same reason as clipboard-copy.spec.ts (NativeImage
// round-trip is most consistent on the platform PwrSnap ships to
// in Phase 1; cross-platform clipboard lands in Phase 8).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap } from "./fixtures/electron-app";

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
 * `outputDir` is pinned under the test's tmpdir HOME so the bundle
 * never lands in the host machine's real `~/Documents/PwrSnap` —
 * the launchPwrSnap fixture rebases userData via PWRSNAP_USER_DATA
 * but `getCapturesRoot()` defaults to `app.getPath("documents")`
 * which Electron resolves against the OS, not HOME.
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

  test("clipboard:copy recovers after the per-capture cache source.png is wiped", async () => {
    const app = await launchPwrSnap();
    try {
      // 1. Seed a real bundle capture — persistCaptureFromTempV2 packs
      //    the .pwrsnap and materializes <userData>/render-cache/<id>/source.png.
      //    outputDir under homeRoot keeps the bundle out of the host's
      //    real ~/Documents/PwrSnap (PWRSNAP_USER_DATA only rebases userData,
      //    not Documents).
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

      // 3. + 4. Copy after the wipe. Pre-fix, the handler's compose()
      //    call threw "Input file is missing" inside sharp, returned
      //    err, the renderer's `void dispatch(...)` swallowed it, and
      //    the clipboard kept whatever stale bytes were there. With
      //    the fix, ensureEffectiveSrcPath re-extracts source.png
      //    from the bundle and compose succeeds.
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

      // 5. The recovered path should have re-materialized the cache
      //    file so subsequent reads hit the fast path instead of
      //    paying yauzl + decompress every time.
      expect(
        existsSync(cacheSourcePath),
        "ensureEffectiveSrcPath should re-materialize source.png after the recovered copy"
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
