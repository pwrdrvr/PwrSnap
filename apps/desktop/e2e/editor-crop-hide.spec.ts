// E2E for "hide the Crop layer → show the full image" (non-destructive
// crop viewport). A real raster-backed v2 capture is cropped via the
// atomic bundle:cropCanvas op, then the crop layer's `visible` flag is
// toggled. We assert the EDITOR canvas re-renders at the full-source
// aspect ratio when the crop is hidden and snaps back when shown — and
// that the persisted (cropped) canvas dims never change, proving the
// toggle is non-destructive (annotations / dims don't "walk").
//
// Seeding mirrors editor-crop-clip.spec.ts (a real bundle with a root
// group + raster at the PNG's natural dims), which the layers-panel
// fixture lacks.

import { expect, test, type Page } from "@playwright/test";
import { launchPwrSnap, type LaunchedApp } from "./fixtures/electron-app";
import { seedRasterCapture, setLayerVisibleByKind } from "./fixtures/editor-helpers";

test.setTimeout(90_000);

const SRC_W = 800;
const SRC_H = 600;
// Crop to the left 60% → 480×600 (edge-aligned, raster translate 0).
const CROP_RECT = { x: 0, y: 0, w: 0.6, h: 1 };
const CROPPED_ASPECT = (SRC_W * CROP_RECT.w) / (SRC_H * CROP_RECT.h); // 0.8
const FULL_ASPECT = SRC_W / SRC_H; // 1.333…

async function openEditor(app: LaunchedApp, captureId: string): Promise<Page> {
  const result = await app.dispatch("editor:open", { captureId });
  expect(result.ok, "editor:open should succeed").toBe(true);
  const page = app.window;
  await page.locator(".psl__focus").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="editor-image"]').waitFor({ state: "visible", timeout: 15_000 });
  return page;
}

/** Poll the `.editor-canvas` box aspect until two reads agree — so we
 *  measure AFTER the dispatch → broadcast → refetch settles. */
async function stableCanvasAspect(win: Page): Promise<number> {
  const canvas = win.locator(".editor-canvas");
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    // eslint-disable-next-line no-await-in-loop
    await win.waitForTimeout(50);
    // eslint-disable-next-line no-await-in-loop
    const box = await canvas.boundingBox();
    if (box === null || box.height === 0) continue;
    const aspect = box.width / box.height;
    if (prev > 0 && Math.abs(aspect - prev) < 0.01) return aspect;
    prev = aspect;
  }
  if (prev <= 0) throw new Error("canvas never measured");
  return prev;
}

async function canvasDims(app: LaunchedApp, captureId: string): Promise<{ w: number; h: number }> {
  const res = await app.dispatch("library:byId", { id: captureId });
  expect(res.ok).toBe(true);
  if (!res.ok) return { w: 0, h: 0 };
  const rec = res.value as { width_px: number; height_px: number };
  return { w: rec.width_px, h: rec.height_px };
}

test("editor-crop-hide: hiding the Crop layer shows the full image; showing it re-crops; dims never change", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, {
      widthPx: SRC_W,
      heightPx: SRC_H,
      appName: "Crop Hide Spec"
    });

    // Crop to the left 60% via the atomic op (shrinks canvas + inserts a
    // crop layer).
    const cropped = await app.dispatch("bundle:cropCanvas", { captureId, rect: CROP_RECT });
    expect(cropped.ok, "bundle:cropCanvas should succeed").toBe(true);

    const dimsAfterCrop = await canvasDims(app, captureId);
    expect(dimsAfterCrop.w).toBe(Math.round(SRC_W * CROP_RECT.w)); // 480
    expect(dimsAfterCrop.h).toBe(SRC_H); // 600

    const win = await openEditor(app, captureId);

    // Crop visible → editor canvas is the CROPPED aspect.
    const aspectCropped = await stableCanvasAspect(win);
    expect(Math.abs(aspectCropped - CROPPED_ASPECT)).toBeLessThan(0.06);

    // Hide the crop → the editor shows the FULL image.
    await setLayerVisibleByKind(app, captureId, "crop", false);
    await expect
      .poll(async () => Math.abs((await stableCanvasAspect(win)) - FULL_ASPECT) < 0.06, {
        timeout: 8_000
      })
      .toBe(true);

    // Non-destructive: the persisted (cropped) canvas dims are UNCHANGED —
    // hiding is a render-time viewport, not a data edit.
    const dimsWhileHidden = await canvasDims(app, captureId);
    expect(dimsWhileHidden).toEqual(dimsAfterCrop);

    // Show the crop again → snaps back to the cropped aspect, bit-stable.
    await setLayerVisibleByKind(app, captureId, "crop", true);
    await expect
      .poll(async () => Math.abs((await stableCanvasAspect(win)) - CROPPED_ASPECT) < 0.06, {
        timeout: 8_000
      })
      .toBe(true);

    const dimsAfterToggle = await canvasDims(app, captureId);
    expect(dimsAfterToggle).toEqual(dimsAfterCrop);
  } finally {
    await app.close();
  }
});
