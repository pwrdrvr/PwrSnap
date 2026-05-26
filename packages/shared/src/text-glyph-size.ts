// Text-glyph sizing for OverlaySvg — extracted so it's testable in
// isolation. Originally the math lived inline in TextGlyph; pulled out
// during pwrdrvr/PwrSnap#110 when the user reported text overlays
// "shrinking" after a crop (the symptom: more characters visible past
// the text anchor because each char became narrower in source-pixel
// terms).
//
// The fix: `sizePx` (the desired source-pixel text height) MUST be
// derived from the SOURCE raster's short side, which is constant
// across crops, NOT from the CANVAS's short side, which shrinks every
// time the user crops. The historical formula did the wrong thing
// silently — it kept fontSize at 1/30 viewBox regardless of crop,
// which meant a "medium" text was always 1/30 of the CURRENT canvas
// height tall. That broke the anchor-to-source-pixel invariant: a
// text typed at "medium" on an uncropped 1920-px-tall canvas was 64
// source-px tall, but after a crop to canvas-height 1239 the SAME
// text re-rendered as 41 source-px tall (1239/30).

/** Three text-size buckets stored on TextOverlay rows. Mirrors the
 *  zod union in `@pwrsnap/shared/overlay-schemas.ts`. Kept inline
 *  here so this helper doesn't pull on the schema. */
export type TextSizeBucket = "small" | "medium" | "large";

/** Bucket → source-pixel height divisor. Same numbers as before;
 *  what changed is the denominator we apply them to. */
const DIVISORS: Record<TextSizeBucket, number> = {
  small: 50,
  medium: 30,
  large: 18
};

export interface TextGlyphSizeArgs {
  /** "small" / "medium" / "large" from the stored overlay row. */
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
   *  bucket × source-shortSide formula below. See
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
  const safeSourceShort = Math.max(1, Math.min(sourceWidthPx, sourceHeightPx));
  const safeCanvasShort = Math.max(1, Math.min(canvasWidthPx, canvasHeightPx));
  // When the row carries an explicit sizePx, that's the source of
  // truth — bucket math is bypassed entirely. Renderers + popover
  // still read `size` for the UI bucket highlight (and for "Custom"
  // detection when sizePx doesn't match any bucket for the current
  // canvas), but the rendered glyph height is whatever sizePx says.
  // Legacy rows fall through to the bucket × source-shortSide
  // formula (the post-`881cff0` behavior).
  const resolvedSizePx =
    storedSizePx !== undefined && Number.isFinite(storedSizePx) && storedSizePx > 0
      ? storedSizePx
      : safeSourceShort / DIVISORS[size];
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
  const sourceShortSide = Math.max(1, Math.min(sourceWidthPx, sourceHeightPx));
  return sourceShortSide / DIVISORS[bucket];
}

/** Returns the bucket whose pixel value matches `sizePx` within
 *  `tolerancePx` source pixels, or `null` when none match (Custom
 *  state — the popover surfaces this as a non-clickable label). */
export function matchBucket(
  sizePx: number,
  sourceWidthPx: number,
  sourceHeightPx: number,
  tolerancePx = 1
): TextSizeBucket | null {
  const buckets: TextSizeBucket[] = ["small", "medium", "large"];
  for (const bucket of buckets) {
    const bucketPx = bucketSizePxForCanvas(bucket, sourceWidthPx, sourceHeightPx);
    if (Math.abs(sizePx - bucketPx) < tolerancePx) return bucket;
  }
  return null;
}
