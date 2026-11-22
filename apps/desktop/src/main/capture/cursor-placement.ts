// Where a cursor sprite draws on a capture — pure, so anything can place a
// cursor without loading the helper that samples one (cursor-sample.ts
// spawns a native process; a burst's pointer is already sampled by the
// recorder and only needs placing).

/** The persist-side cursor-layer contract: sprite bytes + placement in
 *  CANVAS PIXELS. One named type shared by the capture handlers and
 *  `persistCaptureFromTempV2` (imported type-only there) so the shape
 *  can't drift between the three sites that used to inline it. */
export type CursorLayerPlacement = {
  pngBytes: Buffer;
  xPx: number;
  yPx: number;
  drawWidthPx: number;
  drawHeightPx: number;
};

/** What placing needs from a sample: position + hotspot + draw size, POINTS. */
export type CursorPlacementSample = {
  posX: number;
  posY: number;
  hotspotX: number;
  hotspotY: number;
  pointWidth: number;
  pointHeight: number;
};

/**
 * Compute the cursor layer's placement for a captured region, or null
 * when the cursor isn't inside the region (R6 in the plan — a cursor
 * on another display or outside the selection gets no layer).
 *
 * All rect inputs are LOGICAL points; `regionOrigin` is the captured
 * rect's origin in GLOBAL points (display.bounds origin + selection
 * rect origin). `scaleFactor` maps points → the capture's physical px.
 *
 * Returns the sprite's top-left position + on-canvas draw size in
 * CANVAS PIXELS: position = (pos − hotspot − regionOrigin) · scale;
 * draw size = pointSize · scale (the raster layer's transform scale is
 * then drawSize / naturalPx, handling Retina/XL-cursor sprites whose
 * PNG raster exceeds the point size).
 */
export function computeCursorPlacement(args: {
  sample: CursorPlacementSample;
  regionOriginX: number;
  regionOriginY: number;
  regionWidth: number;
  regionHeight: number;
  scaleFactor: number;
}): { xPx: number; yPx: number; drawWidthPx: number; drawHeightPx: number } | null {
  const { sample, regionOriginX, regionOriginY, regionWidth, regionHeight, scaleFactor } =
    args;
  const localX = sample.posX - regionOriginX;
  const localY = sample.posY - regionOriginY;
  // R6: the HOTSPOT (the pixel the user "points" with) must be inside
  // the captured region. Sprite overhang past the edge is fine — it
  // clips at the canvas like any raster.
  if (localX < 0 || localY < 0 || localX >= regionWidth || localY >= regionHeight) {
    return null;
  }
  return {
    xPx: (localX - sample.hotspotX) * scaleFactor,
    yPx: (localY - sample.hotspotY) * scaleFactor,
    drawWidthPx: sample.pointWidth * scaleFactor,
    drawHeightPx: sample.pointHeight * scaleFactor
  };
}
