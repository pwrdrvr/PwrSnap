// Smart-arrow geometry. Pure math; no DOM, no Node deps. Imported by
// both the renderer (live SVG in the editor) and main (sharp bake of
// arrow overlays into the cache).
//
// Per the Phase-1 plan §"Smart arrow algorithm", the goal is to never
// look like a needle (too thin) or a crayola box (too thick). Stroke
// width is a function of the source image's short side; head size is
// a function of stroke width; short arrows get a thicker tail to keep
// proportions sane.
//
// All inputs/outputs are in NORMALIZED coordinates ([0,1]^2 fractions
// of the source image's W×H). Both consumers convert to pixels at
// their natural resolution:
//   • Renderer SVG: viewBox 0..1, strokeWidth = strokeFraction.
//   • Sharp bake: strokeWidth_px = strokeFraction * shortSide_px;
//     SVG buffer has viewBox = full image pixels.
//
// Color is decided in main only (we sample the source image under
// `to`); the renderer just uses the fixed accent without sampling.
// `colorMode` in the output describes WHAT to draw, not HOW (the
// caller applies the chosen palette).

export type Point = { x: number; y: number };

export type ArrowInput = {
  /** Tail of the arrow, normalized [0,1]^2. */
  from: Point;
  /** Head of the arrow, normalized [0,1]^2. */
  to: Point;
  /** Source image width in pixels. */
  imageWidthPx: number;
  /** Source image height in pixels. */
  imageHeightPx: number;
};

export type ArrowGeometry = {
  /** Pass-through. */
  from: Point;
  /** Pass-through. */
  to: Point;
  /** Where the line ends and the head triangle begins, normalized. */
  baseCenter: Point;
  /** Two outer corners of the head triangle, normalized. */
  baseLeft: Point;
  baseRight: Point;
  /**
   * Stroke width as fraction of `min(imageWidth, imageHeight)`. Both
   * consumers multiply by their image short-side (in their target
   * px space) to get the actual pixel stroke. Renderer uses canvas
   * short-side; bake uses image short-side.
   */
  strokeFraction: number;
  /**
   * Pre-computed pixel stroke for the bake's pixel-space SVG buffer.
   * Equivalent to `strokeFraction * min(imageWidthPx, imageHeightPx)`.
   * Stored separately so consumers don't have to re-derive it.
   */
  strokeWidthPx: number;
  headLengthPx: number;
  headWidthPx: number;
  /**
   * The arrow's pixel length on the source image — used by callers
   * that need to scale outline widths or other secondary marks.
   */
  lengthPx: number;
};

const STROKE_DIVISOR = 220;
const STROKE_MIN_PX = 4;
const STROKE_MAX_PX = 14;
const HEAD_LENGTH_RATIO = 3.5;
const HEAD_WIDTH_RATIO = 2.6;
/**
 * Tail-thickening threshold from the plan: when an arrow is shorter
 * than 2× the head length, scale the stroke up so the geometry
 * doesn't look like a needle.
 */
const SHORT_ARROW_FACTOR = 2;

/**
 * Compute the smart-arrow geometry for the given inputs. Pure
 * function — no globals, no allocation beyond the returned object.
 */
export function computeArrowGeometry(input: ArrowInput): ArrowGeometry {
  const shortSidePx = Math.max(1, Math.min(input.imageWidthPx, input.imageHeightPx));

  // Step 1: base stroke width derived from image short-side.
  let strokeWidthPx = clamp(shortSidePx / STROKE_DIVISOR, STROKE_MIN_PX, STROKE_MAX_PX);

  let headLengthPx = strokeWidthPx * HEAD_LENGTH_RATIO;
  let headWidthPx = strokeWidthPx * HEAD_WIDTH_RATIO;

  // Step 2: arrow length in image pixels.
  const dx_norm = input.to.x - input.from.x;
  const dy_norm = input.to.y - input.from.y;
  const dxPx = dx_norm * input.imageWidthPx;
  const dyPx = dy_norm * input.imageHeightPx;
  const lengthPx = Math.hypot(dxPx, dyPx);

  // Step 3: short-arrow tail thickening. When the arrow length is
  // smaller than the head's natural size, the head visually
  // dominates and the line looks like a stub. Scaling stroke + head
  // proportionally keeps the silhouette readable.
  if (lengthPx < headLengthPx * SHORT_ARROW_FACTOR) {
    const scale = lengthPx / Math.max(1, headLengthPx * SHORT_ARROW_FACTOR);
    // Bring stroke up but never below the floor.
    strokeWidthPx = Math.max(STROKE_MIN_PX, strokeWidthPx * Math.max(scale, 0.7));
    headLengthPx = strokeWidthPx * HEAD_LENGTH_RATIO;
    headWidthPx = strokeWidthPx * HEAD_WIDTH_RATIO;
  }

  // Compute the head triangle's three corners. The triangle's apex
  // is at `to`; the base is at `to - direction * headLengthPx`. Two
  // outer corners are along the perpendicular at half head-width.
  // Direction in pixel space (so the perpendicular doesn't get
  // skewed by non-square aspect ratios).
  const dirLen = Math.max(1, lengthPx);
  const ux_px = dxPx / dirLen;
  const uy_px = dyPx / dirLen;
  // Perpendicular (rotated 90°).
  const px_px = -uy_px;
  const py_px = ux_px;

  // Convert the pixel-space displacements back to normalized.
  const baseCenterPx = {
    x: input.to.x * input.imageWidthPx - ux_px * headLengthPx,
    y: input.to.y * input.imageHeightPx - uy_px * headLengthPx
  };
  const halfHeadPx = headWidthPx / 2;
  const baseLeftPx = {
    x: baseCenterPx.x + px_px * halfHeadPx,
    y: baseCenterPx.y + py_px * halfHeadPx
  };
  const baseRightPx = {
    x: baseCenterPx.x - px_px * halfHeadPx,
    y: baseCenterPx.y - py_px * halfHeadPx
  };
  const baseCenter = {
    x: baseCenterPx.x / input.imageWidthPx,
    y: baseCenterPx.y / input.imageHeightPx
  };
  const baseLeft = {
    x: baseLeftPx.x / input.imageWidthPx,
    y: baseLeftPx.y / input.imageHeightPx
  };
  const baseRight = {
    x: baseRightPx.x / input.imageWidthPx,
    y: baseRightPx.y / input.imageHeightPx
  };

  return {
    from: input.from,
    to: input.to,
    baseCenter,
    baseLeft,
    baseRight,
    strokeFraction: strokeWidthPx / shortSidePx,
    strokeWidthPx,
    headLengthPx,
    headWidthPx,
    lengthPx
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
