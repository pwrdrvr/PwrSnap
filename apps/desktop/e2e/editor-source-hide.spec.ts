// E2E for "hide the Source layer → annotations on an empty canvas". The
// base raster's eye was a no-op in the editor (the <img> ignored the
// layer's `visible` flag) even though the bake already drops a hidden
// raster onto a transparent canvas. Now hiding the Source hides the
// <img> behind a transparency checker while annotations keep painting —
// matching the bake (WYSIWYG).

import { expect, test } from "@playwright/test";
import { launchPwrSnap } from "./fixtures/electron-app";
import {
  drawOnCanvas,
  openEditorFocus,
  seedRasterCapture,
  selectTool,
  setLayerVisibleByKind
} from "./fixtures/editor-helpers";

test.setTimeout(90_000);

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
