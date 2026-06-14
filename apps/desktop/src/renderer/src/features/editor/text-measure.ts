// Canvas-backed text measurement for overlay bounding boxes.
//
// Both the SELECTION OUTLINE (`textBoundsBox` in OverlaySvg.tsx) and the
// CLICK TARGET (`hitTestOverlays` in Editor.tsx) need the natural width
// of a rendered text overlay so their boxes hug / cover the visible
// glyphs. The pre-existing char-count × fixed-advance approximation
// (`text-bbox-constants.ts`) could not tell `Hi Mom` from `Hi MOm` — it
// only counts characters, and capital glyphs are wider than the ~0.55
// average advance. So the dashed outline under-shot wide-cap text (the
// right edge landed inside the glyph) and over-shot narrow text.
//
// This measures the REAL advance width of the widest line with the same
// font stack + weight + size the glyph renders with, via a cached 2D
// canvas context. `measureText().width` is the glyph-layout advance —
// the same metric Chromium uses to size the rendered `<div>`, so the box
// tracks the text exactly (modulo the small symmetric side-bearings,
// which the existing outline padding absorbs evenly on both edges).
//
// Returns null when a 2D context isn't available — jsdom (the renderer
// unit-test environment) returns null from `getContext("2d")` because
// the optional `canvas` package isn't installed. Callers fall back to
// the char-count approximation, so the existing outline / hit-test unit
// tests keep their behavior unchanged; the real Chromium renderer always
// has a context and gets the accurate measurement.

import { TEXT_OVERLAY_FONT_FAMILY } from "@pwrsnap/shared";

// `undefined` = not yet probed; `null` = probed, unavailable (cached so
// we don't re-probe + re-log jsdom's "not implemented" notice each call).
let cachedCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (cachedCtx !== undefined) return cachedCtx;
  try {
    cachedCtx = document.createElement("canvas").getContext("2d");
  } catch {
    cachedCtx = null;
  }
  return cachedCtx;
}

/** Natural advance width (px) of the WIDEST line in `body`, measured in
 *  the same font the overlay renders with (family + weight + size).
 *
 *  `fontPx` is the font size in whatever pixel space the caller wants the
 *  result in — `measureText` scales linearly with font size, so passing
 *  the image-pixel font size returns an image-pixel width directly (no
 *  separate scale step needed). Newlines split into lines and the widest
 *  line wins, matching `white-space: pre` on the rendered glyph.
 *
 *  Returns null if a 2D canvas context is unavailable so callers can
 *  fall back to the char-count approximation. */
export function measureTextWidthPx(
  body: string,
  fontPx: number,
  weight: number
): number | null {
  if (!Number.isFinite(fontPx) || fontPx <= 0) return null;
  const ctx = getMeasureContext();
  if (ctx === null) return null;
  ctx.font = `${weight} ${fontPx}px ${TEXT_OVERLAY_FONT_FAMILY}`;
  // Match the glyph CSS (`font-kerning: normal`) so the measured advance
  // lines up with the rendered <div>. The glyph's other typographic
  // knobs (`font-feature-settings` / `font-variant-ligatures: normal`)
  // are already the canvas measureText defaults.
  ctx.fontKerning = "normal";
  let max = 0;
  for (const line of body.split("\n")) {
    const w = ctx.measureText(line).width;
    if (w > max) max = w;
  }
  return max;
}
