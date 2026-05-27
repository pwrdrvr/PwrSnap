// Shared char-advance constants for text overlay bounding boxes.
// Two callers compute approximate bounding rects from a text
// overlay's row data:
//
//   1. `textBoundsBox` in OverlaySvg.tsx — the SELECTION OUTLINE.
//      A 1px dashed border drawn around the rendered glyph. Wants to
//      hug the visible text closely — too loose looks like a halo,
//      too tight clips the glyph edges.
//
//   2. `hitTestOverlays` in Editor.tsx — the CLICK TARGET. Wants to
//      be MORE generous than the visible glyph so the user can click
//      a few pixels past a character and still register. Matches the
//      affordance other annotation tools (Cleanshot, Skitch) ship.
//
// We could share one constant, but the two surfaces genuinely want
// different sizes: the outline wants tightness (visual cleanliness),
// the hit-test wants forgiveness (UX). Keeping both numbers here,
// named, makes the divergence explicit and reviewable.
//
// Neither value needs to be pixel-perfect — the actual rendered
// glyph width depends on the proportional font's metrics for each
// character (narrow 'i' vs wide 'M' vs even-wider emoji). 0.55 / 0.65
// are reasonable approximations for the system-font stack
// (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`) at
// the sizes we ship. If a future PR adds an OffscreenCanvas-based
// measureText path for true per-character widths, both call sites
// should switch to it together.

/** Char advance for the SELECTION OUTLINE (tight wrap around the
 *  rendered glyph). 0.55 lines up close to the visible extent of the
 *  system-font stack for the buckets we ship. */
export const TEXT_BBOX_CHAR_ADVANCE_OUTLINE = 0.55;

/** Char advance for the HIT TEST (forgiving click target). 0.65 is
 *  ~18% wider than the outline so clicks landing just past the right
 *  edge of the rendered text still register. The hit-test ALSO adds a
 *  small all-around padding (see `hitTestOverlays`) on top of this. */
export const TEXT_BBOX_CHAR_ADVANCE_HIT = 0.65;
