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
  /**
   * Optional stroke-width override in source pixels. When provided
   * (and positive), skips the auto-derivation (short-side + length
   * scaling, MIN/MAX clamps) and uses this value as the basis for
   * head sizing. `undefined` and non-positive values fall through to
   * auto-derivation. The short-arrow correction still applies — if
   * the override produces a head longer than the arrow itself, head
   * + stroke shrink together so the head fits.
   *
   * Used by the user's thickness override (small/medium/large/
   * numeric): without this, the stem stroke would scale 2× for
   * "large" but the head triangle would stay at the auto-derived
   * size, leaving a fat stem with a tiny head and (for open-
   * triangle) a hollow whose interior fills with the now-thick
   * outline stroke.
   *
   * Explicitly `| undefined` (not just `?`) so callers can pass the
   * resolved-or-undefined override directly under
   * `exactOptionalPropertyTypes` — matching the settings-substrate
   * convention. See [AGENTS.md §"Settings substrate"].
   */
  strokeWidthOverridePx?: number | undefined;
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
/**
 * Head proportions, length:width ≈ 5:3 ≈ 1.67:1 ≈ golden ratio. Same
 * neighborhood as PowerPoint / Word / Keynote default annotation
 * arrows, which is the visual grammar most users have already
 * internalized from Office.
 *
 * Pre-2026-05 these were 3.5 / 2.6 (length:width ≈ 1.35:1), which
 * read as a squat / chunky "modern UI" arrow — visibly different from
 * Office and noticeably worse on Large thickness where the head
 * looked stubby next to the doubled stem. The longer-thinner shape
 * also gives the head more room before the stem stroke starts to
 * crowd the open-triangle's hollow.
 *
 * NOT pinned per-overlay yet: changing these constants re-renders
 * every historical arrow at next load. The plan is to fold ratios
 * into a snapshotted `arrowStyleVersion` on the overlay row so old
 * captures stay frozen at the ratios they were drawn with — see the
 * comment block at the bottom of this file.
 */
const HEAD_LENGTH_RATIO = 5;
const HEAD_WIDTH_RATIO = 3;
/**
 * Long arrows traversing a large fraction of the image need a thicker
 * stroke to avoid looking like a hair, especially on tall-skinny or
 * wide-short images where the short-side-derived base stroke clamps
 * to STROKE_MIN_PX (4). Scale the stroke by `lengthPx / LENGTH_DIVISOR`,
 * take the max with the image-derived base, and re-clamp.
 *
 * A 3000px-long arrow → 3000/250 = 12px stroke (capped at MAX 14).
 * A 200px arrow → 200/250 = 0.8 → falls below short-side floor; the
 * image-derived stroke wins.
 */
const LENGTH_DIVISOR = 250;
/**
 * Hard floor for short-arrow strokes. Smaller than STROKE_MIN_PX
 * because for very short arrows we'd rather have a thin-but-
 * proportional silhouette than a normal stroke with a missing head.
 */
const SHORT_ARROW_STROKE_MIN_PX = 2;

/**
 * Compute the smart-arrow geometry for the given inputs. Pure
 * function — no globals, no allocation beyond the returned object.
 */
export function computeArrowGeometry(input: ArrowInput): ArrowGeometry {
  const shortSidePx = Math.max(1, Math.min(input.imageWidthPx, input.imageHeightPx));

  // Step 1: arrow length in image pixels. Needed for the
  // length-aware stroke scaling below.
  const dx_norm = input.to.x - input.from.x;
  const dy_norm = input.to.y - input.from.y;
  const dxPx = dx_norm * input.imageWidthPx;
  const dyPx = dy_norm * input.imageHeightPx;
  const lengthPx = Math.hypot(dxPx, dyPx);

  // Step 2: base stroke from image short-side, then bump for long
  // arrows so a hairline never happens on wide-short images. The
  // optional override short-circuits auto-derivation so callers
  // (user-picked Small/Medium/Large) can scale stem + head together
  // through a single source of truth.
  let strokeWidthPx: number;
  if (input.strokeWidthOverridePx !== undefined && input.strokeWidthOverridePx > 0) {
    strokeWidthPx = input.strokeWidthOverridePx;
  } else {
    const strokeFromShortSide = clamp(
      shortSidePx / STROKE_DIVISOR,
      STROKE_MIN_PX,
      STROKE_MAX_PX
    );
    const strokeFromLength = lengthPx / LENGTH_DIVISOR;
    strokeWidthPx = clamp(
      Math.max(strokeFromShortSide, strokeFromLength),
      STROKE_MIN_PX,
      STROKE_MAX_PX
    );
  }

  let headLengthPx = strokeWidthPx * HEAD_LENGTH_RATIO;
  let headWidthPx = strokeWidthPx * HEAD_WIDTH_RATIO;

  // Step 3: short-arrow correction. When the arrow length is smaller
  // than the head's natural size, baseCenter would land behind `from`
  // (the head triangle's base is computed as `to − unit*headLength`
  // along the arrow direction). The visual is a backwards-pointing
  // line + a head that overflows the segment.
  //
  // Fix: shrink the head + stroke together so headLength ≤ lengthPx.
  // Preserve the head's length/width ratio so it stays a recognizable
  // arrowhead. Cap the lower bound on stroke at SHORT_ARROW_STROKE_MIN_PX
  // (2px) — thinner than the normal floor because for short arrows the
  // silhouette is dominated by the head, not the line.
  if (headLengthPx > lengthPx && lengthPx > 0) {
    const scale = lengthPx / headLengthPx;
    headLengthPx = lengthPx; // exactly fills the segment
    headWidthPx *= scale;
    strokeWidthPx = Math.max(SHORT_ARROW_STROKE_MIN_PX, strokeWidthPx * scale);
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

// -- TODO: persist style version per overlay ----------------------
//
// The constants above (`STROKE_DIVISOR`, `STROKE_MIN_PX`,
// `STROKE_MAX_PX`, `HEAD_LENGTH_RATIO`, `HEAD_WIDTH_RATIO`,
// `LENGTH_DIVISOR`, `SHORT_ARROW_STROKE_MIN_PX`) are global —
// changing them retroactively re-renders every historical arrow at
// next load, in both the live editor and library thumbnails. The
// first time we tweaked head proportions (3.5/2.6 → 5/3) we
// accepted that, but it's not a habit we want.
//
// Better: snapshot a `styleVersion: number` on each `ArrowOverlay`
// at commit time, and look up the ratios by version inside
// `computeArrowGeometry`. Legacy rows without the field render at
// v1 (the historical 3.5/2.6 set); newly drawn arrows go in at the
// current version. The same parameter table can later host new
// fields (different stem-stroke curve, alternative head families)
// without invalidating existing captures.
//
// Out of scope for the current visual-fix pass; do this before the
// next ratio change, not as part of it. See ArrowOverlay schema in
// `overlay-schemas.ts`.
