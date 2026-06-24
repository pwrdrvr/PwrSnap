// Editor styling for a NON-base raster layer — the per-layer analogue
// of `computeEditorImageStyle` (which positions the single base source
// `<img>`). The raster LayerView renders every additional `kind:"raster"`
// layer (pasted images today; the captured cursor in Phase 3) as its own
// absolutely-positioned `<img>` inside `.editor-image-clip`, and this
// helper computes that element's box so it MATCHES the baked compositor
// (`composeV2` in compose-tree.ts).
//
// Parity with `compositeRasterOntoAccumulator` (compose-tree.ts):
//   • The affine transform is `[scaleX, 0, 0, scaleY, tx, ty]` in CANVAS
//     pixels (v2.0 is translate + scale only; shear/rotation stay 0).
//   • The raster anchors at its TOP-LEFT — the compositor places it at
//     (tx, ty) with no transform-origin offset.
//   • Off-origin crops are already folded into each layer's tx/ty by the
//     crop dispatcher (useCaptureModel Step 0.5), so we read tx/ty
//     directly — no separate crop-offset term (unlike the base img,
//     which carries its own `rasterTranslate*`).
//   • `.editor-image-clip` is canvas-sized (`position:absolute; inset:0`),
//     so canvas pixels map to percentages of the clip: a layer at
//     (tx, ty) of size (naturalW*scaleX, naturalH*scaleY) becomes
//     left/top/width/height percentages of the clip. Zoom scales the
//     clip, so the percentages hold at any zoom.
//
// Known first-increment limitation (documented in the Phase 2 plan):
// these layers render in one stack above the base image; full z-order
// INTERLEAVING with the vector/effect overlays is a later step. Correct
// for the common cases (pasted image / cursor above the screenshot,
// below annotations); a raster with a z_index above a vector overlay
// will not yet layer above it on-screen even though the export does.

import type React from "react";

import type { AffineTransform } from "@pwrsnap/shared";

export interface RasterLayerStyleArgs {
  /** The layer's affine transform `[scaleX, 0, 0, scaleY, tx, ty]` in
   *  canvas-pixel units. */
  transform: AffineTransform;
  /** The raster source's natural (unscaled) pixel dimensions. */
  naturalWidthPx: number;
  naturalHeightPx: number;
  /** Current (possibly cropped) canvas dimensions in pixels. */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Layer opacity in [0, 1]. */
  opacity: number;
}

/**
 * Inline style for a non-base raster layer's `<img>`, positioned to
 * match the baked composite. Anchored top-left; scale folds into the
 * element's width/height so the natural source stretches to its on-canvas
 * footprint (object-fit defaults to fill, like the base `.editor-image`).
 */
export function computeRasterLayerStyle(args: RasterLayerStyleArgs): React.CSSProperties {
  const { transform, naturalWidthPx, naturalHeightPx, canvasWidthPx, canvasHeightPx, opacity } =
    args;
  const scaleX = transform[0];
  const scaleY = transform[3];
  const tx = transform[4];
  const ty = transform[5];
  // Defensive against a not-yet-measured / degenerate canvas — never emit
  // NaN percentages (which would collapse the element and hide the layer).
  const safeCanvasW = canvasWidthPx > 0 ? canvasWidthPx : 1;
  const safeCanvasH = canvasHeightPx > 0 ? canvasHeightPx : 1;
  const widthPct = ((naturalWidthPx * scaleX) / safeCanvasW) * 100;
  const heightPct = ((naturalHeightPx * scaleY) / safeCanvasH) * 100;
  const leftPct = (tx / safeCanvasW) * 100;
  const topPct = (ty / safeCanvasH) * 100;
  return {
    position: "absolute",
    left: `${leftPct}%`,
    top: `${topPct}%`,
    width: `${widthPct}%`,
    height: `${heightPct}%`,
    opacity
  };
}
