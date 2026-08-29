// Text-glyph sizing for OverlaySvg — extracted so it's testable in
// isolation. Originally the math lived inline in TextGlyph; pulled out
// during pwrdrvr/PwrSnap#110 when the user reported text overlays
// "shrinking" after a crop (the symptom: more characters visible past
// the text anchor because each char became narrower in source-pixel
// terms).
//
// The fix: `sizePx` (the desired source-pixel text height) MUST be
// derived from the SOURCE raster's dims, which are constant across
// crops, NOT from the CANVAS's dims, which shrink every time the user
// crops. The historical formula did the wrong thing silently — it
// kept fontSize at 1/30 viewBox regardless of crop, which meant a
// "medium" text was always 1/30 of the CURRENT canvas height tall.
// That broke the anchor-to-source-pixel invariant: a text typed at
// "medium" on an uncropped 1920-px-tall canvas was 64 source-px tall,
// but after a crop to canvas-height 1239 the SAME text re-rendered as
// 41 source-px tall (1239/30).
//
// The scale reference itself moved in the 2026-08 recalibration:
// buckets divide `annotationBasisPx(source)` rather than the source's
// raw short side, so wide-short and tall-thin captures stop producing
// sub-UI-text annotations. See `annotation-scale.ts` for the why.

import {
  annotationBasisPx,
  annotationTextSizePx,
  type AnnotationSizePreset
} from "./annotation-scale";

/** Four text-size buckets stored on TextOverlay rows. Mirrors the zod
 *  union in `@pwrsnap/shared/overlay-schemas.ts`. Aliased onto the
 *  shared annotation ladder so text and stroke presets can't drift
 *  into different value spaces. */
export type TextSizeBucket = AnnotationSizePreset;

/** Every bucket, in ascending size order. Exported so UI + tests can
 *  iterate the ladder without re-declaring it. */
export const TEXT_SIZE_BUCKETS: readonly TextSizeBucket[] = [
  "small",
  "medium",
  "large",
  "x-large"
];

export interface TextGlyphSizeArgs {
  /** "small" / "medium" / "large" / "x-large" from the stored row. */
  size: TextSizeBucket;
  /** SOURCE raster's natural pixel width — invariant across crops.
   *  v1 captures (no layer tree, no separate source) pass the same
   *  value as `canvasWidthPx`. */
  sourceWidthPx: number;
  /** SOURCE raster's natural pixel height. v1 mirrors canvas. */
  sourceHeightPx: number;
  /** CANVAS pixel width — `record.width_px`. Shrinks after a crop. */
  canvasWidthPx: number;
  /** CANVAS pixel height — `record.height_px`. */
  canvasHeightPx: number;
  /** Persisted absolute text height from `TextOverlay.sizePx`, in
   *  source/canvas pixels (same scale in v2). When present this is
   *  the source of truth — `size` is ignored for sizing math (it's
   *  still the UI intent the popover renders to highlight the right
   *  bucket button). Legacy rows without sizePx fall back to the
   *  bucket × annotation-basis formula below. See
   *  pwrdrvr/PwrSnap#110 for the design.
   *
   *  Explicitly `| undefined` (not just `?`) so callers under
   *  `exactOptionalPropertyTypes: true` can pass `data.sizePx`
   *  through directly without a guard. */
  storedSizePx?: number | undefined;
}

export interface TextGlyphSize {
  /** Desired text height in CANVAS pixels (= source pixels in v2 —
   *  canvas pixel space and source pixel space share the same scale;
   *  a crop is purely a viewport change, not a resampling). Stays
   *  constant across crops. */
  sizePx: number;
  /** SVG viewBox fontSize — `sizePx / canvasShortSide`. The viewBox
   *  is `0 0 1 1` per OverlaySvg, so a fontSize of F renders at
   *  `F × canvasCssH` CSS px tall after the SVG's non-uniform stretch
   *  to canvas display dims. As `canvasShortSide` shrinks with crops,
   *  `fontSize` GROWS to keep the on-screen text size proportional to
   *  the source raster — matching what the image content shows. */
  fontSize: number;
}

export function computeTextGlyphSize(args: TextGlyphSizeArgs): TextGlyphSize {
  const {
    size,
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx,
    canvasHeightPx,
    storedSizePx
  } = args;
  // Defensive: zero dims would crash the divisions. Fall back to 1
  // so the helper never throws (caller might have a transient state
  // mid-load). The fallback is wrong-looking but non-fatal.
  const safeCanvasShort = Math.max(1, Math.min(canvasWidthPx, canvasHeightPx));
  // When the row carries an explicit sizePx, that's the source of
  // truth — bucket math is bypassed entirely. Renderers + popover
  // still read `size` for the UI bucket highlight (and for "Custom"
  // detection when sizePx doesn't match any bucket for the current
  // canvas), but the rendered glyph height is whatever sizePx says.
  // Legacy rows fall through to the bucket × annotation-basis
  // formula.
  const resolvedSizePx =
    storedSizePx !== undefined && Number.isFinite(storedSizePx) && storedSizePx > 0
      ? storedSizePx
      : bucketSizePxForCanvas(size, sourceWidthPx, sourceHeightPx);
  const fontSize = resolvedSizePx / safeCanvasShort;
  return { sizePx: resolvedSizePx, fontSize };
}

/** Per-bucket source-pixel value for the CURRENT canvas. The popover
 *  uses this to decide whether a row's stored `sizePx` is "in bucket"
 *  (matches one of these within tolerance) or "Custom" (between
 *  buckets after a crop). Source dims are constant across crops, so
 *  the same canvas → same bucket values regardless of capture
 *  history. */
export function bucketSizePxForCanvas(
  bucket: TextSizeBucket,
  sourceWidthPx: number,
  sourceHeightPx: number
): number {
  return annotationTextSizePx(
    bucket,
    annotationBasisPx(sourceWidthPx, sourceHeightPx)
  );
}

/** Returns the bucket whose pixel value matches `sizePx`, or `null`
 *  when none match (Custom state — the popover surfaces this as a
 *  non-clickable label).
 *
 *  The default tolerance is RELATIVE (2% of the bucket, floored at 1
 *  source px) rather than a flat pixel count. Two reasons:
 *
 *    • A flat 1 px was unforgiving at high resolution. On a 5K capture
 *      the medium bucket is ~98 px, so a row 1.5 px off — a rounding
 *      difference, or a row written before a small retune of the
 *      ladder — read as "Custom" even though it is visually identical
 *      to Medium.
 *    • It cannot cause cross-bucket confusion: rungs sit ~1.66× apart,
 *      which is two orders of magnitude wider than the window.
 *
 *  Callers that want the old exact behavior pass `tolerancePx`. */
export function matchBucket(
  sizePx: number,
  sourceWidthPx: number,
  sourceHeightPx: number,
  tolerancePx?: number
): TextSizeBucket | null {
  for (const bucket of TEXT_SIZE_BUCKETS) {
    const bucketPx = bucketSizePxForCanvas(bucket, sourceWidthPx, sourceHeightPx);
    const tolerance = tolerancePx ?? Math.max(1, bucketPx * 0.02);
    if (Math.abs(sizePx - bucketPx) < tolerance) return bucket;
  }
  return null;
}
