// Candidate for the still-sizing experiment. The production handler keeps
// its existing preparation defaults.
export const DISPLAY_POINT_LIMITS = {
  maxPixels: 1_400_000,
  maxEdgePx: 2048,
  maxBytes: 1_000_000
} as const;

export function fitInside(sourceWidth: number, sourceHeight: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

export function displayPointEdge(width: number, height: number, dpr: number | null): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Expected positive integer source raster dimensions");
  }
  // A missing or invalid scale conveys no density information. Treat it as
  // 1× for sizing, subject to the same edge, area and encoded byte bounds.
  const divisor = dpr !== null && Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  let lower = 1;
  let upper = Math.max(1, Math.min(DISPLAY_POINT_LIMITS.maxEdgePx, Math.floor(Math.max(width, height) / divisor)));
  // Pick the largest fitting edge after integer rounding, including narrow
  // rasters. A second integer divide would often discard a lot of detail.
  while (lower < upper) {
    const edge = Math.ceil((lower + upper) / 2);
    const target = fitInside(width, height, edge);
    if (target.width * target.height <= DISPLAY_POINT_LIMITS.maxPixels) lower = edge;
    else upper = edge - 1;
  }
  return lower;
}
