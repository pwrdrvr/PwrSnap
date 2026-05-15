// Clipboard copy spec — verifies the three Float-Over presets and
// the Library Copy button produce images of the expected widths on
// the system clipboard.
//
// Pre-bake (Phase 1) the clipboard handler always wrote the source
// PNG. Post-bake (Phase 2 Slice A) the handler renders the source +
// applied overlays, resizes to the preset width, encodes to PNG,
// writes to clipboard. This spec was missing — the user discovered
// the clipboard copy was completely broken (Low/Med/High buttons
// only animated a "copied" badge without dispatching, ⌘1/2/3 only
// fired when float-over had focus). With the fixes in e2d28cf the
// dispatch path is correct; this spec locks the behavior down so a
// future regression doesn't go unnoticed for weeks again.
//
// What this spec asserts:
//
//   1. preset='low' produces a clipboard image ~800px wide.
//   2. preset='med' produces a clipboard image ~1440px wide.
//   3. preset='high' produces a clipboard image at SOURCE width
//      (no resize when targetWidth >= source width).
//   4. The clipboard NativeImage is non-empty (has decoded bytes).
//
// macOS-only because clipboard image handling differs across
// platforms; the macOS clipboard supports NativeImage natively
// while Linux CI runners need xclip / wl-copy and produce inconsistent
// pixel dimensions when reading back. We only ship to macOS in
// Phase 1; cross-platform clipboard testing lands when Phase 8 does.

import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap } from "./fixtures/electron-app";

const isMac = process.platform === "darwin";

/**
 * Generate a real-sized fixture PNG so we can verify resize widths.
 * The 1×1 PNG used by editor.spec.ts/float-over-visibility.spec.ts
 * is too small — `clamp(width, 1, 8192)` would flatten low/med/high
 * to the same 1px output. This produces a sized PNG with deterministic
 * byte content (constant fill color) so the same fixture is used
 * across runs.
 */
async function makeFixturePng(
  widthPx: number,
  heightPx: number
): Promise<{ pngPath: string; sha256: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-clipboard-spec-"));
  const pngPath = path.join(dir, "fixture.png");

  // Solid color image — sharp's `create` factory produces a real PNG
  // sized to whatever we ask for. Constant fill keeps the sha256
  // deterministic so we don't trip the captures.sha256 UNIQUE
  // constraint when the spec re-runs in the same DB.
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
  // sha256 isn't critical for the test — we just need a UNIQUE-safe
  // value for the captures table. Use the file size + dims as a
  // pseudo-hash; collision probability across one test run is zero.
  const sha256 = `clipboard-spec-${widthPx}x${heightPx}-${buf.length}`;
  return { pngPath, sha256 };
}

/**
 * Seed a real capture row backed by `pngPath`. Returns the
 * captureId. Same pattern as float-over-visibility.spec.ts /
 * editor.spec.ts; duplicated locally for spec-isolation rules.
 */
async function seedCapture(
  app: Awaited<ReturnType<typeof launchPwrSnap>>,
  pngPath: string,
  widthPx: number,
  heightPx: number,
  sha256: string
): Promise<string> {
  const captureId = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await app.electronApp.evaluate(
    (_electron, payload) => {
      const bridge = (
        globalThis as unknown as {
          __PWRSNAP_TEST__: {
            seedCapture: (input: Record<string, unknown>) => unknown;
          };
        }
      ).__PWRSNAP_TEST__;
      bridge.seedCapture({
        id: payload.captureId,
        kind: "image",
        captured_at: new Date().toISOString(),
        source_app_bundle_id: "com.test.clipboard-spec",
        source_app_name: "Clipboard Spec",
        src_path: payload.pngPath,
        width_px: payload.widthPx,
        height_px: payload.heightPx,
        device_pixel_ratio: 2,
        byte_size: 1024,
        sha256: payload.sha256
      });
    },
    { captureId, pngPath, widthPx, heightPx, sha256 }
  );
  return captureId;
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

async function clearClipboard(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<void> {
  await app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as { __PWRSNAP_TEST__: { clearClipboard: () => void } }
    ).__PWRSNAP_TEST__;
    bridge.clearClipboard();
  });
}

async function readClipboardBookmark(
  app: Awaited<ReturnType<typeof launchPwrSnap>>
): Promise<{ title: string; url: string }> {
  return await app.electronApp.evaluate(() => {
    const bridge = (
      globalThis as unknown as {
        __PWRSNAP_TEST__: {
          readClipboardBookmark: () => { title: string; url: string };
        };
      }
    ).__PWRSNAP_TEST__;
    return bridge.readClipboardBookmark();
  });
}

test.describe("clipboard copy preset widths", () => {
  test.skip(
    !isMac,
    "clipboard NativeImage round-trip is macOS-only in Phase 1; cross-platform lands in Phase 8"
  );

  // 2400×1500 source: comfortably bigger than `med` (1440) and `low`
  // (800) so the resize path is exercised, but small enough to keep
  // the test under a few hundred ms.
  const SRC_W = 2400;
  const SRC_H = 1500;

  test("preset='low' → clipboard image ≈800px wide", async () => {
    const app = await launchPwrSnap();
    try {
      const { pngPath, sha256 } = await makeFixturePng(SRC_W, SRC_H);
      const captureId = await seedCapture(app, pngPath, SRC_W, SRC_H, sha256);

      await clearClipboard(app);
      const result = await app.dispatch("clipboard:copy", { captureId, preset: "low" });
      expect(result.ok, `clipboard:copy failed: ${JSON.stringify(result)}`).toBe(true);

      const img = await readClipboardImage(app);
      expect(img, "clipboard should hold an image after copy").not.toBeNull();
      expect(img!.isEmpty).toBe(false);
      // Allow ±2px tolerance for sharp's rounding when resizing
      // (e.g. 800w on a non-multiple aspect ratio can land at 799 or
      // 801). The aspect ratio (1.6) should yield ~800×500.
      expect(img!.width).toBeGreaterThanOrEqual(798);
      expect(img!.width).toBeLessThanOrEqual(802);
    } finally {
      await app.close();
    }
  });

  test("preset='med' → clipboard image ≈1440px wide", async () => {
    const app = await launchPwrSnap();
    try {
      const { pngPath, sha256 } = await makeFixturePng(SRC_W, SRC_H);
      const captureId = await seedCapture(app, pngPath, SRC_W, SRC_H, sha256);

      await clearClipboard(app);
      const result = await app.dispatch("clipboard:copy", { captureId, preset: "med" });
      expect(result.ok).toBe(true);

      const img = await readClipboardImage(app);
      expect(img).not.toBeNull();
      expect(img!.isEmpty).toBe(false);
      expect(img!.width).toBeGreaterThanOrEqual(1438);
      expect(img!.width).toBeLessThanOrEqual(1442);
    } finally {
      await app.close();
    }
  });

  test("preset='med' also advertises the rendered PNG file URL", async () => {
    const app = await launchPwrSnap();
    try {
      const { pngPath, sha256 } = await makeFixturePng(SRC_W, SRC_H);
      const captureId = await seedCapture(app, pngPath, SRC_W, SRC_H, sha256);

      await clearClipboard(app);
      const result = await app.dispatch("clipboard:copy", { captureId, preset: "med" });
      expect(result.ok).toBe(true);

      const drag = await app.dispatch("capture:prepareDrag", { captureId, preset: "med" });
      if (!drag.ok) {
        throw new Error(`capture:prepareDrag failed: ${JSON.stringify(drag)}`);
      }

      const bookmark = await readClipboardBookmark(app);
      expect(bookmark.url).toBeTruthy();
      expect(fileURLToPath(bookmark.url)).toBe(drag.value.path);
      expect(bookmark.title).toBe(path.basename(drag.value.path));

      const img = await readClipboardImage(app);
      expect(img).not.toBeNull();
      expect(img!.width).toBeGreaterThanOrEqual(1438);
      expect(img!.width).toBeLessThanOrEqual(1442);
    } finally {
      await app.close();
    }
  });

  test("preset='high' → clipboard image at source width (no resize)", async () => {
    const app = await launchPwrSnap();
    try {
      const { pngPath, sha256 } = await makeFixturePng(SRC_W, SRC_H);
      const captureId = await seedCapture(app, pngPath, SRC_W, SRC_H, sha256);

      await clearClipboard(app);
      const result = await app.dispatch("clipboard:copy", { captureId, preset: "high" });
      expect(result.ok).toBe(true);

      const img = await readClipboardImage(app);
      expect(img).not.toBeNull();
      expect(img!.isEmpty).toBe(false);
      // High preset = source width with `withoutEnlargement: true`,
      // so output equals source on a source >= preset comparison.
      expect(img!.width).toBe(SRC_W);
      expect(img!.height).toBe(SRC_H);
    } finally {
      await app.close();
    }
  });

  test("three sequential copies overwrite the clipboard each time", async () => {
    // Catches a regression where the second/third dispatch silently
    // no-ops because some shared state (rendercoordinator inFlight,
    // clipboard write throttle, etc.) wedges. After the user clicks
    // Low → Med → High in rapid succession the clipboard should
    // hold the LAST one's bytes.
    const app = await launchPwrSnap();
    try {
      const { pngPath, sha256 } = await makeFixturePng(SRC_W, SRC_H);
      const captureId = await seedCapture(app, pngPath, SRC_W, SRC_H, sha256);

      await clearClipboard(app);

      let result = await app.dispatch("clipboard:copy", { captureId, preset: "low" });
      expect(result.ok).toBe(true);
      result = await app.dispatch("clipboard:copy", { captureId, preset: "med" });
      expect(result.ok).toBe(true);
      result = await app.dispatch("clipboard:copy", { captureId, preset: "high" });
      expect(result.ok).toBe(true);

      const img = await readClipboardImage(app);
      expect(img).not.toBeNull();
      // Last write wins → high preset → source width.
      expect(img!.width).toBe(SRC_W);
    } finally {
      await app.close();
    }
  });
});
