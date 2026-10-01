// Dash pattern for a shape's outline stroke (ShapeOverlay.strokeStyle).
//
// One function pair, consumed by BOTH the editor's ShapeGlyph and the
// bake's `shapeSvg`, so the preview and the exported PNG cannot drift.
//
// An arrow stem is an OPEN path and starts and ends on a dash
// (`computeStemDashArray`: N dashes + N−1 gaps). A shape outline is a
// CLOSED path: its last gap runs into its first dash, so it fits N
// dashes + N gaps exactly — otherwise the seam at the path start shows
// a double-length dash (or a stub). The natural dash/gap lengths are
// the arrow's (`naturalStrokeDash`), so both are multiples of a stroke
// width that comes off `annotationBasisPx`.

import { naturalStrokeDash } from "./arrow";
import type { ShapeKind, ShapeStrokeStyle } from "./overlay-schemas";

/** Length of the outline path the shape primitive actually strokes, in
 *  the same pixel space as `wPx` / `hPx`. Mirrors the primitives in
 *  ShapeGlyph and `shapeSvg`:
 *    rect / square → <rect>     2 × (w + h)
 *    circle / oval → <ellipse>  Ramanujan's second approximation
 *                               (error well under 0.01% at any aspect)
 *    parallelogram → <polygon>  two horizontal edges of w, two slanted
 *                               edges spanning h vertically and
 *                               2 × (h/2)·tan(skew) horizontally */
export function shapeOutlinePerimeterPx(
  shape: ShapeKind,
  wPx: number,
  hPx: number,
  skewDeg: number
): number {
  const w = Math.abs(wPx);
  const h = Math.abs(hPx);
  switch (shape) {
    case "circle":
    case "oval": {
      const a = w / 2;
      const b = h / 2;
      return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    }
    case "parallelogram": {
      const shearPx = (h / 2) * Math.tan((skewDeg * Math.PI) / 180);
      return 2 * (w + Math.hypot(2 * shearPx, h));
    }
    case "rect":
    case "square":
    default:
      return 2 * (w + h);
  }
}

/** `stroke-dasharray` for a shape outline, or null for a solid stroke
 *  (callers emit no attribute then, so legacy rows stay byte-identical).
 *
 *  The pattern is stretched so an integer count of dash+gap cycles
 *  fills the perimeter exactly — the same convention as
 *  `computeStemDashArray`, adjusted for a closed path. Callers stroke
 *  a patterned outline with `stroke-linecap: round`: a dotted dash is
 *  0.01 × stroke long and only reads as a dot through its round cap. */
export function computeShapeStrokeDashArray(
  style: ShapeStrokeStyle,
  perimeterPx: number,
  strokeWidthPx: number
): string | null {
  if (style === "solid") return null;
  const { dash, gap } = naturalStrokeDash(style, strokeWidthPx);
  const cycle = dash + gap;
  // Degenerate (zero-size shape, zero stroke): nothing to pattern.
  if (!(perimeterPx > 0) || !(cycle > 0)) return null;
  const n = Math.max(1, Math.round(perimeterPx / cycle));
  const scale = perimeterPx / (n * cycle);
  return `${dash * scale} ${gap * scale}`;
}
