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
  /**
   * Which version of the arrow style table to use. The table holds
   * head proportions + stroke clamps; freezing a version per overlay
   * row lets us tune future arrows without retroactively rewriting
   * historical captures. See `ARROW_STYLE_VERSIONS` below.
   *
   * Defaults to `ARROW_STYLE_VERSION_LEGACY` (1) for back-compat when
   * the field is missing — pre-versioning arrow rows render at the
   * proportions they were drawn with. Newly committed rows should
   * stamp `CURRENT_ARROW_STYLE_VERSION` at creation time.
   *
   * Unknown versions (e.g. a future v3 row read by an older client)
   * fall back to v1 — the conservative choice on a version mismatch.
   * If you need cross-version interop, do it through the schema
   * migration layer, not by silently rendering at the wrong style.
   *
   * Explicitly `| undefined` (not just `?`) so callers can pass
   * `data.styleVersion` directly under `exactOptionalPropertyTypes`.
   */
  styleVersion?: number | undefined;
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

/**
 * One row of the versioned arrow style table. Every parameter that
 * influences arrow geometry lives here, so a single integer on the
 * overlay row pins the entire visual recipe. New rendering knobs
 * (different stem curves, alternative head families) go in by
 * extending this shape and bumping `CURRENT_ARROW_STYLE_VERSION`.
 */
interface ArrowStyleParams {
  /**
   * Auto-stroke divisor against image short-side. `strokeFromShortSide
   * = clamp(shortSidePx / STROKE_DIVISOR, STROKE_MIN_PX, STROKE_MAX_PX)`.
   */
  STROKE_DIVISOR: number;
  /** Lower clamp on auto-derived stroke (px). */
  STROKE_MIN_PX: number;
  /** Upper clamp on auto-derived stroke (px). */
  STROKE_MAX_PX: number;
  /** Head triangle length as a multiple of stroke width. */
  HEAD_LENGTH_RATIO: number;
  /** Head triangle base width as a multiple of stroke width. */
  HEAD_WIDTH_RATIO: number;
  /**
   * Long arrows traversing a large fraction of the image need a
   * thicker stroke to avoid looking like a hair, especially on tall-
   * skinny or wide-short images where the short-side-derived base
   * stroke clamps to STROKE_MIN_PX. Scale the stroke by `lengthPx /
   * LENGTH_DIVISOR`, take the max with the image-derived base, and
   * re-clamp.
   *
   * A 3000px-long arrow → 3000/250 = 12px stroke (capped at MAX 14).
   * A 200px arrow → 200/250 = 0.8 → falls below short-side floor;
   * the image-derived stroke wins.
   */
  LENGTH_DIVISOR: number;
  /**
   * Hard floor for short-arrow strokes after the short-arrow
   * correction shrinks head + stroke together. Smaller than
   * `STROKE_MIN_PX` because for very short arrows we'd rather have
   * a thin-but-proportional silhouette than a normal stroke with a
   * missing head.
   */
  SHORT_ARROW_STROKE_MIN_PX: number;
}

/**
 * Versioned arrow style table.
 *
 * v1 (the historical default — applied to any overlay row with no
 * `styleVersion` field): head length:width ≈ 1.35:1. Read as a squat
 * "modern UI" arrow; visibly different from Office and noticeably
 * worse on Large thickness where the head looked stubby next to the
 * doubled stem.
 *
 * v2: head length:width = 5:3 ≈ 1.67:1 ≈ φ. Same neighborhood as
 * PowerPoint / Word / Keynote default annotation arrows — the visual
 * grammar most users have already internalized from Office. Longer
 * thinner shape also gives the head more room before the stem stroke
 * starts to crowd the open-triangle's hollow.
 *
 * To add a new version: copy v2's entry, change the fields you care
 * about, append at the next integer key, and bump
 * `CURRENT_ARROW_STYLE_VERSION` to match. Historical rows keep
 * rendering at whatever version they were stamped with.
 */
const ARROW_STYLE_VERSIONS: Readonly<Record<number, ArrowStyleParams>> = {
  1: {
    STROKE_DIVISOR: 220,
    STROKE_MIN_PX: 4,
    STROKE_MAX_PX: 14,
    HEAD_LENGTH_RATIO: 3.5,
    HEAD_WIDTH_RATIO: 2.6,
    LENGTH_DIVISOR: 250,
    SHORT_ARROW_STROKE_MIN_PX: 2
  },
  2: {
    STROKE_DIVISOR: 220,
    STROKE_MIN_PX: 4,
    STROKE_MAX_PX: 14,
    HEAD_LENGTH_RATIO: 5,
    HEAD_WIDTH_RATIO: 3,
    LENGTH_DIVISOR: 250,
    SHORT_ARROW_STROKE_MIN_PX: 2
  }
};

/**
 * Version stamped on every NEW arrow overlay at commit time. Increment
 * this when you change any entry in `ARROW_STYLE_VERSIONS` so legacy
 * rows freeze at their original proportions while new rows pick up
 * the change.
 */
export const CURRENT_ARROW_STYLE_VERSION = 2 as const;

/**
 * Version used when an overlay row has no `styleVersion` field set
 * (pre-versioning rows from before this table existed). v1 is the
 * historical 3.5/2.6 shape; switching the default here would
 * retroactively re-render every legacy arrow, which is exactly the
 * problem this whole mechanism exists to prevent.
 */
const ARROW_STYLE_VERSION_LEGACY = 1;

function resolveArrowStyleParams(version: number | undefined): ArrowStyleParams {
  const resolved = version ?? ARROW_STYLE_VERSION_LEGACY;
  // Future-proof: an unknown version (e.g., v3 row read by an older
  // client that only knows v1+v2) falls back to legacy. The
  // alternative — silently render at the latest version we do know —
  // would produce DIFFERENT proportions on the same row in different
  // client versions, defeating the whole point of pinning.
  return ARROW_STYLE_VERSIONS[resolved] ?? ARROW_STYLE_VERSIONS[ARROW_STYLE_VERSION_LEGACY]!;
}

/**
 * Compute the smart-arrow geometry for the given inputs. Pure
 * function — no globals, no allocation beyond the returned object.
 */
export function computeArrowGeometry(input: ArrowInput): ArrowGeometry {
  const params = resolveArrowStyleParams(input.styleVersion);
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
      shortSidePx / params.STROKE_DIVISOR,
      params.STROKE_MIN_PX,
      params.STROKE_MAX_PX
    );
    const strokeFromLength = lengthPx / params.LENGTH_DIVISOR;
    strokeWidthPx = clamp(
      Math.max(strokeFromShortSide, strokeFromLength),
      params.STROKE_MIN_PX,
      params.STROKE_MAX_PX
    );
  }

  let headLengthPx = strokeWidthPx * params.HEAD_LENGTH_RATIO;
  let headWidthPx = strokeWidthPx * params.HEAD_WIDTH_RATIO;

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
    strokeWidthPx = Math.max(params.SHORT_ARROW_STROKE_MIN_PX, strokeWidthPx * scale);
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

// -- How to evolve the arrow style table --------------------------
//
// To change ANY arrow rendering parameter (head proportions, stroke
// clamps, length-scaling curve, short-arrow floor) WITHOUT breaking
// historical captures:
//
//  1. Append a new entry to `ARROW_STYLE_VERSIONS` at the next
//     integer key (e.g., 3). Copy the previous version's row and
//     change only the fields you want to evolve — the table is a
//     full snapshot, so leaving a field unchanged is just copying
//     the old value.
//
//  2. Bump `CURRENT_ARROW_STYLE_VERSION` to match. New arrows drawn
//     after this lands get stamped with the new version at commit
//     time (see Editor.tsx's arrow-creation path); existing rows
//     keep their original version field and continue rendering at
//     the proportions they were drawn with.
//
//  3. Add a regression test in arrow.test.ts that creates rows at
//     each version (no field → v1, explicit v2, explicit v3) and
//     asserts the geometry differences you care about. The point of
//     the table is freeze-in-place: a test that demonstrates v1 and
//     v3 produce different output for the same inputs is the proof
//     that pinning works.
//
//  4. Do NOT introduce a "migration" that bumps old rows to the new
//     version. Existing captures should stay frozen — that's the
//     whole contract. If a user explicitly opts in (a future
//     "modernize arrow style" command), that's a separate user-
//     initiated flow, not an implicit upgrade.
//
// What does NOT belong in the version table: anything the user
// controls per-overlay (color, thickness preset, end style, stem
// style). Those are already per-row fields in `ArrowOverlay`. The
// version table is for the SHARED RECIPE — the things that would
// otherwise be hardcoded constants and silently rewrite every
// existing capture if changed.
