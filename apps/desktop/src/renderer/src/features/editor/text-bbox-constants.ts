// Shared char-advance constant for text overlay bounding boxes.
//
// Two surfaces derive a box from a text overlay's row data:
//
//   1. `textBoundsBox` in OverlaySvg.tsx — the SELECTION OUTLINE (and,
//      via `bodyBoxForOverlay`, TransformHandles' drag-to-move rect).
//
//   2. `hitTestOverlays` in Editor.tsx — the CLICK TARGET, which also
//      drives the `data-hover-hit` cursor affordance.
//
// Both want the SAME box: the extent of the glyph the user can see.
// The click target's forgiveness — being able to press a few pixels
// past a character and still land on the layer — comes from a
// screen-constant pad `hitTestOverlays` adds on every edge
// (`hitRadiusN * 0.5`, ≈5px), NOT from inflating the box.
//
// It used to come from inflating the box, and that was a bug. The
// hit-test carried its own wider char advance (0.65 vs the outline's
// 0.55) and, once both switched to real measurement, a
// `TEXT_BBOX_HIT_WIDTH_SLOP = 1.18` multiplier over the measured
// width. A multiplier is a percentage OF THE STRING, and the anchor
// (`data.point`) is the glyph's LEFT edge — so the whole inflation
// landed on the right and grew with the sentence. A banner of text
// ~1000 canvas-px wide claimed ~180px of empty canvas past its last
// character: `cursor: move` out in blank space, and a press-drag that
// moved text the pointer was nowhere near. It also shifted the box
// centre, which is the pivot the hit-test inverse-rotates rotated
// text around, so rotated text was grabbable off to one side of where
// it painted. Forgiveness on a click target is a small constant halo;
// it is not a function of how long the sentence is.
//
// FALLBACK-ONLY as of the canvas-measure path. Both call sites measure
// the real per-character advance with `measureTextWidthPx`
// (text-measure.ts) — and, in the real Chromium renderer, prefer the
// live glyph `<div>`'s published box (text-measure-registry.ts) over
// even that. The constant below is the last resort for environments
// without a 2D canvas context (the jsdom unit-test environment); it's
// never hit in the real renderer. It remains a reasonable
// approximation for the system-font stack (`-apple-system,
// BlinkMacSystemFont, 'Segoe UI', sans-serif`) at the sizes we ship.

/** FALLBACK char advance used to approximate a text overlay's glyph
 *  width when canvas measurement is unavailable. 0.55 lines up close
 *  to the visible extent of the system-font stack for the buckets we
 *  ship. Shared by the selection outline and the hit test so the two
 *  never disagree about where the text ends. */
export const TEXT_BBOX_CHAR_ADVANCE = 0.55;
