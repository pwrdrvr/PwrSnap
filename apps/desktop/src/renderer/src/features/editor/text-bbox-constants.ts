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
// FALLBACK-ONLY as of the canvas-measure path. Both call sites now
// measure the real per-character advance width with `measureTextWidthPx`
// (text-measure.ts) — char count alone can't tell `Hi Mom` from
// `Hi MOm`, since capital glyphs are wider than the average advance, so
// the count-based box under-shot wide-cap text. These constants are kept
// as the fallback for environments without a 2D canvas context (the
// jsdom unit-test environment) — they're never hit in the real Chromium
// renderer. They remain reasonable approximations for the system-font
// stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`) at
// the sizes we ship.

/** FALLBACK char advance for the SELECTION OUTLINE (tight wrap around
 *  the rendered glyph) when canvas measurement is unavailable. 0.55
 *  lines up close to the visible extent of the system-font stack for
 *  the buckets we ship. */
export const TEXT_BBOX_CHAR_ADVANCE_OUTLINE = 0.55;

/** FALLBACK char advance for the HIT TEST (forgiving click target) when
 *  canvas measurement is unavailable. 0.65 is ~18% wider than the
 *  outline so clicks landing just past the right edge of the rendered
 *  text still register. The hit-test ALSO adds a small all-around
 *  padding (see `hitTestOverlays`) on top of this. */
export const TEXT_BBOX_CHAR_ADVANCE_HIT = 0.65;

/** Generosity factor applied to the MEASURED hit-test width so the click
 *  target stays more forgiving than the (tight) selection outline — the
 *  same ~18% relationship the fallback advances encode (0.65 / 0.55),
 *  now applied to the accurate measured advance instead of a char count.
 *  Clicks landing just past the right edge of the rendered text still
 *  register; the hit-test's all-around padding stacks on top. */
export const TEXT_BBOX_HIT_WIDTH_SLOP = 1.18;
