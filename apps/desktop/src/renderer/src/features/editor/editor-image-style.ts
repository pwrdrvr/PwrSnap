// Editor `<img>` styling — pulled out of Editor.tsx so the math is
// testable in isolation. The editor's view renders the SOURCE raster
// directly (not the baked composite), so the img element has to honor
// the v2 raster layer's transform translation if we want off-origin
// crops to show the user's chosen region of the source.
//
// Pre-pwrdrvr/PwrSnap#110: the img was always pinned to the canvas's
// top-left, which silently rendered the top-left source region for
// ANY crop — even when the user dragged an off-origin (center) rect.
// The dispatcher writes the raster's transform.tx/ty correctly per
// the crop's offset (see `useCaptureModel.ts` Step 0.5); this helper
// is the consumer that propagates that translation into the editor's
// on-screen rendering.

import type React from "react";

export interface EditorImageStyleArgs {
  /** Raster's natural pixel width (e.g. 2880 for a typical Retina capture). */
  sourceWidthPx: number;
  /** Raster's natural pixel height. */
  sourceHeightPx: number;
  /** Current (possibly cropped) canvas width in pixels. */
  canvasWidthPx: number;
  /** Current (possibly cropped) canvas height in pixels. */
  canvasHeightPx: number;
  /** Raster layer `transform[4]` (X translation in source-pixel units).
   *  Negative when the canvas is cropped from the LEFT (the raster has
   *  been shifted leftward so the kept region lines up with the new
   *  canvas's top-left). Zero for edge-aligned crops and uncropped
   *  captures.
   *
   *  v1 captures pass 0 (no layer tree). */
  rasterTranslateXPx: number;
  /** Raster layer `transform[5]` (Y translation). Symmetric semantics. */
  rasterTranslateYPx: number;
}

/** Compute the inline style for the editor's source-image `<img>`.
 *
 *  Sizing: the img is `(source / canvas) × 100%` of its parent so the
 *  source raster's natural pixels map 1:1 to canvas CSS pixels
 *  regardless of zoom. With the default object-fit (fill), the image
 *  content stretches to fill the img box — so a 1.6× source/canvas
 *  ratio means the img is 160% × 160% of the canvas wrap, extending
 *  past the right/bottom edges (clipped by `.editor-canvas`'s
 *  overflow:hidden).
 *
 *  Translation: for off-origin crops, the raster layer's transform
 *  records a translation in source-pixel units. We convert that to a
 *  CSS `translate(%, %)` on the img — `transform %` is relative to
 *  the element being transformed (the img), and the img covers the
 *  source 1:1, so the fraction is `tx / sourceWidth`. transformOrigin
 *  is pinned to (0, 0) so the math holds regardless of whether the
 *  browser would default it to "center" (which would shift the math
 *  by half the img's dimension). */
export function computeEditorImageStyle(args: EditorImageStyleArgs): React.CSSProperties {
  const {
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx,
    canvasHeightPx,
    rasterTranslateXPx,
    rasterTranslateYPx
  } = args;
  // Defensive: division-by-zero in pathological dev fixtures shouldn't
  // crash render. The pre-measured class on .editor-canvas already
  // covers the not-yet-measured frame; this is just a safety net.
  const safeCanvasW = canvasWidthPx > 0 ? canvasWidthPx : sourceWidthPx;
  const safeCanvasH = canvasHeightPx > 0 ? canvasHeightPx : sourceHeightPx;
  const widthPct = (sourceWidthPx / safeCanvasW) * 100;
  const heightPct = (sourceHeightPx / safeCanvasH) * 100;
  const style: React.CSSProperties = {
    width: `${widthPct}%`,
    height: `${heightPct}%`
  };
  // Skip the transform attribute when there's no translation — keeps
  // the (edge-aligned crop / uncropped) DOM identical to the pre-#110
  // shape so existing screenshot tests don't churn.
  if (rasterTranslateXPx !== 0 || rasterTranslateYPx !== 0) {
    const safeSourceW = sourceWidthPx > 0 ? sourceWidthPx : 1;
    const safeSourceH = sourceHeightPx > 0 ? sourceHeightPx : 1;
    const txPct = (rasterTranslateXPx / safeSourceW) * 100;
    const tyPct = (rasterTranslateYPx / safeSourceH) * 100;
    style.transform = `translate(${txPct}%, ${tyPct}%)`;
    // Browser default for transformOrigin on an img is "50% 50%"; for
    // our percentage math to land we need (0, 0).
    style.transformOrigin = "0 0";
  }
  return style;
}
