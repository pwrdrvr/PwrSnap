// The single source of truth for HOW BIG an annotation is.
//
// Every user-placed mark that has a size — text glyphs, arrow stems +
// heads, shape strokes — derives that size from ONE number: the
// capture's `annotationBasisPx`. Text divides it; strokes divide it.
// Nothing in the app is allowed to invent its own scale reference.
//
// ---------------------------------------------------------------
// Why this module exists (the 2026-08 recalibration)
// ---------------------------------------------------------------
//
// Before this, every annotation sized itself off the image's SHORT
// SIDE, and the arrow/shape stroke additionally passed through
// absolute pixel clamps (`clamp(shortSide / 220, 4, 14)`). Both were
// wrong, and they failed in opposite directions:
//
//   • Short side collapses on wide-short and tall-thin captures.
//     A 777×207 Slack-notification grab has a short side of 207, so a
//     "medium" text overlay rendered at 207/30 ≈ 6.9 px — HALF the
//     height of the 15 px UI text it was annotating. A 473×178 crop
//     got 5.9 px. The annotation was smaller than the content, which
//     is the one thing an annotation may never be.
//
//   • The absolute stroke clamps flatten the whole preset ladder.
//     `clamp(shortSide / 220, 4, 14)` pins the auto stroke to exactly
//     4 px for EVERY capture with a short side under 880 px — i.e.
//     most window grabs. Small and Medium then resolved to 2 px and
//     4 px on a 777×207 grab AND on a 1200×800 one AND on a 473×178
//     one. Two presets, one size, no scaling. Meanwhile Large and
//     X-Large escaped the clamp through short-side floor fractions
//     (1.2% / 2.0%), so the ladder read 3.2 / 4.9 / 13.0 / 21.6 px on
//     1080p — a 1.5× step, then a 2.7× step, then a 1.7× step.
//
// ---------------------------------------------------------------
// The basis
// ---------------------------------------------------------------
//
//     basis = max(FLOOR, shortSide, diagonal / 2)
//
// Three terms, each covering a failure the others can't:
//
//   • `shortSide` — the historical term. Keeps mainstream captures
//     (window grabs, full screens, anything squarer than ~1.73:1)
//     rendering at the sizes they render at today. For a square image
//     it is the largest term; for 16:9 it is within 2% of diagonal/2.
//     This is what makes the recalibration a no-op on the shapes
//     users already had dialed in.
//
//   • `diagonal / 2` — takes over above ~1.73:1 aspect, which is
//     exactly where short side stops describing how big the image
//     "reads". A 2212×249 toolbar strip is a BIG image; its 249 px
//     height says otherwise. diagonal/2 says 1113. Chosen over the
//     geometric mean (√(w·h)) because it corrects extreme aspect
//     ratios harder — √(w·h) only gets that strip to 742, which still
//     under-sizes annotations against retina UI text — and over the
//     raw diagonal because that would SHRINK square captures (a
//     1000×1000 image would drop from 1000 to 707).
//
//   • `FLOOR` — small captures. A 200×80 button crop has no extent to
//     scale from, but the UI text inside it is the same ~15 px (1×) /
//     ~30 px (2×) as in any other screenshot, because UI text size is
//     a property of the DISPLAY, not of the crop rectangle. So below
//     the floor, annotation size stops scaling and goes absolute.
//     This is the term that fixes the reported bug.
//
// The floor value was picked by rendering the ladder over real and
// synthetic captures at 1× and 2× content scale and comparing each
// bucket against the UI text beside it; 900 is the midpoint of the
// band that reads correctly in both. See
// `docs/solutions/2026-08-28-annotation-scale-recalibration.md` for
// the measurements and the contact sheets.
//
// ---------------------------------------------------------------
// What this deliberately does NOT do
// ---------------------------------------------------------------
//
// It does not consult `device_pixel_ratio`. That would be the
// theoretically correct input — annotation size ought to track the
// capture's content scale, and a 2× capture's UI text is twice as
// tall in raster pixels as a 1× capture's. Two things rule it out:
//
//   1. It isn't trustworthy. The 777×207 capture that prompted this
//      work is stamped `device_pixel_ratio = 2.0` while its content
//      is measurably 1× (Slack's 15 px message font occupies 15 raster
//      px). Video records hardcode 1; imports hardcode 1; the region
//      capture handler defaults to 2.
//   2. It isn't portable. `.pwrsnap` bundles carry canvas dimensions
//      but no scale factor, so a bundle opened on another machine
//      would size its annotations differently than the machine that
//      wrote it — a WYSIWYG break in the one place we've worked
//      hardest to guarantee preview == export.
//
// A pure function of (width, height) is deterministic, portable, and
// re-derivable from the bundle alone. That's worth more than the
// accuracy DPR would theoretically buy.

/**
 * Below this basis, annotations stop scaling with the image and go
 * absolute. See the module header — this is the term that keeps a
 * small crop's annotations legible against UI text that doesn't get
 * smaller just because the crop rectangle did.
 *
 * Roughly: "annotate anything smaller than a ~900-px-tall window as if
 * it were one". Not exactly a 1600×900 window — that shape resolves to
 * 918 via the diagonal/2 term, just above the floor; the floor binds
 * only below it.
 */
export const ANNOTATION_BASIS_FLOOR_PX = 900;

/**
 * The scale reference for every sized annotation on a capture.
 *
 * Pure, deterministic, and derived only from raster dimensions, so
 * the live editor, the bake, and a `.pwrsnap` opened on another
 * machine all agree by construction.
 *
 * ALWAYS pass the SOURCE raster's natural dims, not the canvas dims.
 * Crop is a viewport change in v2 (pwrdrvr/PwrSnap#110), so canvas
 * dims shrink with every crop while source dims don't — sizing off
 * the canvas would make a text overlay physically shrink each time
 * the user cropped around it.
 */
export function annotationBasisPx(widthPx: number, heightPx: number): number {
  // Defensive: a transient zero/NaN dim mid-load must not poison the
  // divisions downstream. Clamping to 1 yields a wrong-looking but
  // finite basis, and the floor swallows it anyway.
  const w = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 1;
  const h = Number.isFinite(heightPx) && heightPx > 0 ? heightPx : 1;
  return Math.max(ANNOTATION_BASIS_FLOOR_PX, Math.min(w, h), Math.hypot(w, h) / 2);
}

/**
 * The four size steps every annotation control offers. Shared by the
 * text popover's font-size row and the arrow/shape thickness row so
 * "Large" means the same rung of the same ladder everywhere.
 */
export type AnnotationSizePreset = "small" | "medium" | "large" | "x-large";

/**
 * Stroke width as `basis / divisor`, for arrow stems + heads and
 * shape outlines.
 *
 * A ~1.53× step between rungs. Uniform on purpose: the pre-
 * recalibration ladder stepped 1.5× / 2.7× / 1.7×, which is what made
 * Small and Medium feel like they were "on a scale all by themselves"
 * — the jump to Large skipped a whole rung's worth of width.
 *
 * `medium` is also what `thickness: "auto"` resolves to, so Auto and
 * M are the same stroke by construction rather than by coincidence.
 */
export const ANNOTATION_STROKE_DIVISORS: Readonly<
  Record<AnnotationSizePreset, number>
> = {
  small: 160,
  medium: 105,
  large: 68,
  "x-large": 44
};

/** Resolve a stroke preset against a capture's annotation basis. */
export function annotationStrokeWidthPx(
  preset: AnnotationSizePreset,
  basisPx: number
): number {
  return basisPx / ANNOTATION_STROKE_DIVISORS[preset];
}

/**
 * Text glyph height as `basis / divisor`.
 *
 * A ~1.66× step between rungs — wider than the stroke ladder because
 * font size needs a bigger delta than stroke width to read as a
 * different size at a glance. The `small` / `medium` / `large`
 * divisors are UNCHANGED from the pre-recalibration values (50 / 30 /
 * 18); only the number they divide moved, which is what keeps
 * mainstream captures rendering the same text they render today.
 *
 * `x-large` (11) is new — it continues the same geometric ladder
 * instead of inventing a separate curve.
 */
export const ANNOTATION_TEXT_DIVISORS: Readonly<
  Record<AnnotationSizePreset, number>
> = {
  small: 50,
  medium: 30,
  large: 18,
  "x-large": 11
};

/** Resolve a text bucket against a capture's annotation basis. */
export function annotationTextSizePx(
  bucket: AnnotationSizePreset,
  basisPx: number
): number {
  return basisPx / ANNOTATION_TEXT_DIVISORS[bucket];
}
