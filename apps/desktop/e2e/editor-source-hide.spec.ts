// E2E for "hide the Source layer → annotations on an empty canvas". The
// base raster's eye was a no-op in the editor (the <img> ignored the
// layer's `visible` flag) even though the bake already drops a hidden
// raster onto a transparent canvas. Now hiding the Source hides the
// <img> behind a transparency checker while annotations keep painting —
// matching the bake (WYSIWYG).

import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { launchPwrSnap } from "./fixtures/electron-app";
import {
  drawOnCanvas,
  openEditorFocus,
  seedRasterCapture,
  selectTool,
  setLayerVisibleByKind
} from "./fixtures/editor-helpers";

test.setTimeout(90_000);

test("editor-source-hide: the BAKE of a source-hidden capture is transparent, not black", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 400, heightPx: 300 });
    // Hide the base raster — with no annotations, every baked pixel must be
    // fully transparent (alpha 0). If the compositor flattened onto an
    // opaque background, the sampled pixel would come back opaque black
    // (a=255), which is exactly the "black where the image was" symptom.
    await setLayerVisibleByKind(app, captureId, "raster", false);

    const res = await app.dispatch("render:composite", { captureId, maxEdgePx: 200 });
    expect(res.ok, "render:composite should succeed").toBe(true);
    if (!res.ok) return;
    const png = Buffer.from((res.value as { base64: string }).base64, "base64");
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // Sample the center pixel.
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const idx = (cy * info.width + cx) * info.channels;
    const alpha = data[idx + 3];
    expect(info.channels, "bake should be RGBA").toBe(4);
    expect(alpha, "source-hidden bake must be transparent (alpha 0), not opaque").toBe(0);
  } finally {
    await app.close();
  }
});

test("editor-source-hide: hiding the Source reveals an empty canvas; annotations stay; showing it restores the image", async () => {
  const app = await launchPwrSnap();
  try {
    const captureId = await seedRasterCapture(app, { widthPx: 800, heightPx: 600 });
    const win = await openEditorFocus(app, captureId);

    // Draw an arrow so there's an annotation to keep visible.
    await selectTool(win, "arrow");
    await drawOnCanvas(win);
    const glyph = win.locator('[data-testid="persisted-glyph-svg"]').first();
    await glyph.waitFor({ state: "attached", timeout: 5_000 });

    const img = win.locator('[data-testid="editor-image"]').first();
    const clip = win.locator(".editor-image-clip").first();

    // Source visible → image shown, no empty-canvas marker.
    await expect(img).toBeVisible();
    await expect(clip).not.toHaveAttribute("data-source-hidden", "true");

    // Hide the Source → the <img> hides (transparency checker shows) but
    // the annotation keeps painting on the now-empty canvas.
    await setLayerVisibleByKind(app, captureId, "raster", false);
    await expect(clip).toHaveAttribute("data-source-hidden", "true", { timeout: 8_000 });
    await expect(img).not.toBeVisible();
    await expect(glyph).toBeVisible();

    // Show it again → the image comes back, marker clears.
    await setLayerVisibleByKind(app, captureId, "raster", true);
    await expect(clip).not.toHaveAttribute("data-source-hidden", "true", { timeout: 8_000 });
    await expect(img).toBeVisible();
  } finally {
    await app.close();
  }
});
