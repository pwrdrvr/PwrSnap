// Hit-testing + bounds for non-source raster layers (pasted images, the
// captured cursor) on the editor canvas. The vector/effect overlays have
// their own hit-test (hitTestOverlays, keyed on Overlay shapes); rasters
// carry a `transform` 6-tuple instead, so they need this parallel pass.
//
// Coordinate space: canvas-normalized [0,1] — the SAME space as the
// pointer (clientToNormalized divides by the canvas element's rect) and
// the RasterLayers <img> positioning (computeRasterLayerStyle). A raster
// anchors top-left at (tx, ty) with size natural*scale; v2.0 transforms
// are translate + scale only (transform[1]/[2] stay 0).

import type { BundleLayerNode } from "@pwrsnap/shared";

type RasterLayer = Extract<BundleLayerNode, { kind: "raster" }>;

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A raster layer's on-canvas bounding box in canvas-normalized [0,1]
 *  coords. Matches computeRasterLayerStyle's left/top/width/height so the
 *  hit-box lines up exactly with the rendered <img>. */
export function rasterLayerBoundsN(
  layer: RasterLayer,
  canvasWidthPx: number,
  canvasHeightPx: number
): NormRect {
  const scaleX = layer.transform[0];
  const scaleY = layer.transform[3];
  const tx = layer.transform[4];
  const ty = layer.transform[5];
  const cw = canvasWidthPx > 0 ? canvasWidthPx : 1;
  const ch = canvasHeightPx > 0 ? canvasHeightPx : 1;
  return {
    x: tx / cw,
    y: ty / ch,
    w: (layer.natural_width_px * scaleX) / cw,
    h: (layer.natural_height_px * scaleY) / ch
  };
}

/** Topmost raster layer under a canvas-normalized point, or null.
 *
 *  `rasters` is assumed z-ascending (listLayerTree order: z_index ASC,
 *  then created_at ASC), so we walk it in REVERSE — the last entry paints
 *  last and wins. `padN` is a small normalized tolerance (matches the
 *  overlay rect padding) so edge clicks still land. Returns `{ id,
 *  zIndex }` so the caller can compare against the overlay hit and pick
 *  the global topmost layer. */
export function hitTestRasterLayers(
  rasters: readonly RasterLayer[],
  xn: number,
  yn: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
  padN = 0
): { id: string; zIndex: number } | null {
  for (let i = rasters.length - 1; i >= 0; i -= 1) {
    const layer = rasters[i]!;
    const b = rasterLayerBoundsN(layer, canvasWidthPx, canvasHeightPx);
    if (
      xn >= b.x - padN &&
      xn <= b.x + b.w + padN &&
      yn >= b.y - padN &&
      yn <= b.y + b.h + padN
    ) {
      return { id: layer.id, zIndex: layer.z_index };
    }
  }
  return null;
}
