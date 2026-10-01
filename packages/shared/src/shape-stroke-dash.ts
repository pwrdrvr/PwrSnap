// Dash pattern for a shape's outline stroke (ShapeOverlay.strokeStyle).
//
// One helper pair, consumed by BOTH the editor's ShapeGlyph and the
// bake's `shapeSvg`, so the preview and the exported PNG cannot drift.
// (The tool bag's 22px glyph reuses it too, with its own pattern unit.)
//
// The rule is the one Illustrator and PowerPoint call "align dashes to
// corners": EVERY CORNER SITS IN THE MIDDLE OF A DASH. A pattern run
// continuously around the perimeter lands corners on dashes, bends and
// gaps at random, and a box whose corner falls in a gap no longer reads
// as a box. So each straight edge is fitted on its own — a half dash at
// each end, whole dash + gap cycles between — and at every vertex the
// two half dashes meet as one dash bent around the corner (round joins
// on the stroke paint the bend). Each edge gets its own stretch, so the
// long and short sides of a rectangle carry slightly different dash
// lengths; the eye forgives that far more easily than an open corner.
//
// Everything is still ONE dasharray on ONE path, so the halo, the
// stripe and the round joins work exactly as on a solid outline. The
// list is long (one pair per dash) and runs exactly once around the
// perimeter; `dashoffset` puts the path's start vertex in the middle of
// the first (corner) dash.
//
// An ellipse has no corners: it keeps a uniform pattern fitted so a
// whole number of dash + gap cycles closes the loop with no seam.
//
// The natural dash/gap lengths are the arrow stem's (`naturalStrokeDash`),
// multiples of a stroke width that comes off `annotationBasisPx`, so a
// dashed box and a dashed arrow share one rhythm and scale together.

import { naturalStrokeDash } from "./arrow";
import type { ShapeKind, ShapeStrokeStyle } from "./overlay-schemas";

/** A patterned stroke: `stroke-dasharray` + `stroke-dashoffset`. */
export interface ShapeStrokeDash {
  dasharray: string;
  dashoffset: number;
}

/** Edge lengths of the outline path the primitive strokes, in path
 *  order from its start vertex — or null for an ellipse (no corners).
 *  Mirrors the primitives in ShapeGlyph and `shapeSvg`:
 *    rect / square → <rect>     starts top-left, runs clockwise:
 *                               top w, right h, bottom w, left h
 *    parallelogram → <polygon>  starts at the sheared top-left:
 *                               top w, slanted side, bottom w,
 *                               slanted side (spans h vertically and
 *                               2 × (h/2)·tan(skew) horizontally) */
export function shapeOutlineEdgesPx(
  shape: ShapeKind,
  wPx: number,
  hPx: number,
  skewDeg: number
): number[] | null {
  const w = Math.abs(wPx);
  const h = Math.abs(hPx);
  switch (shape) {
    case "circle":
    case "oval":
      return null;
    case "parallelogram": {
      const shearPx = (h / 2) * Math.tan((skewDeg * Math.PI) / 180);
      const side = Math.hypot(2 * shearPx, h);
      return [w, side, w, side];
    }
    case "rect":
    case "square":
    default:
      return [w, h, w, h];
  }
}

/** Length of the whole outline path, same pixel space as `wPx` / `hPx`.
 *  An ellipse uses Ramanujan's second approximation (error well under
 *  0.01% at any aspect). */
export function shapeOutlinePerimeterPx(
  shape: ShapeKind,
  wPx: number,
  hPx: number,
  skewDeg: number
): number {
  const edges = shapeOutlineEdgesPx(shape, wPx, hPx, skewDeg);
  if (edges !== null) return edges.reduce((sum, edge) => sum + edge, 0);
  const a = Math.abs(wPx) / 2;
  const b = Math.abs(hPx) / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Short decimal form for a long dasharray. 1e-4 px per entry cannot
 *  add up to anything visible over a loop of a few hundred dashes. */
function fmt(value: number): string {
  return String(Math.round(value * 1e4) / 1e4);
}

/** The pattern for a shape outline, or null for a solid stroke (callers
 *  then emit no attribute, so legacy rows stay byte-identical).
 *
 *  Callers stroke a patterned outline with `stroke-linecap: round`: a
 *  dotted dash is 0.01 × the unit long and only reads as a dot through
 *  its round cap.
 *
 *  @param patternUnitPx  The stroke width the pattern is measured in —
 *                        the painted stroke width for the editor and
 *                        the bake. */
export function computeShapeStrokeDash(
  style: ShapeStrokeStyle,
  shape: ShapeKind,
  wPx: number,
  hPx: number,
  skewDeg: number,
  patternUnitPx: number
): ShapeStrokeDash | null {
  if (style === "solid") return null;
  const natural = naturalStrokeDash(style, patternUnitPx);
  const cycle = natural.dash + natural.gap;
  const perimeter = shapeOutlinePerimeterPx(shape, wPx, hPx, skewDeg);
  // Degenerate (zero-size shape, zero stroke): nothing to pattern.
  if (!(perimeter > 0) || !(cycle > 0)) return null;

  const edges = shapeOutlineEdgesPx(shape, wPx, hPx, skewDeg);
  if (edges === null) {
    // Ellipse: N dash + gap cycles close the loop exactly.
    const n = Math.max(1, Math.round(perimeter / cycle));
    const scale = perimeter / (n * cycle);
    return { dasharray: `${fmt(natural.dash * scale)} ${fmt(natural.gap * scale)}`, dashoffset: 0 };
  }

  // Per edge: half dash + (gap + dash) × (n − 1) + gap + half dash =
  // n × (dash + gap), stretched to the edge's length.
  const fitted = edges.map((length) => {
    const n = Math.max(1, Math.round(length / cycle));
    const scale = length / (n * cycle);
    return { n, dash: natural.dash * scale, gap: natural.gap * scale };
  });
  const last = fitted[fitted.length - 1]!;
  // The list starts with the corner dash at the start vertex: the last
  // edge's closing half, then the first edge's opening half.
  const pairs: number[] = [];
  let dash = last.dash / 2 + fitted[0]!.dash / 2;
  fitted.forEach((edge, k) => {
    const next = fitted[(k + 1) % fitted.length]!;
    for (let i = 0; i < edge.n; i += 1) {
      pairs.push(dash, edge.gap);
      dash = i < edge.n - 1 ? edge.dash : edge.dash / 2 + next.dash / 2;
    }
  });
  return {
    dasharray: pairs.map(fmt).join(" "),
    // Start the path half-way into that first corner dash, so the path's
    // last stretch (the last edge's closing half) runs up to the start
    // vertex and the two halves meet there.
    dashoffset: Number(fmt(last.dash / 2))
  };
}

/** Black twin of a patterned outline for the striped border. The white
 *  halo carries the outline's own pattern, so the black must stay INSIDE
 *  its dashes or it lands in the gaps (the arrow stem's rule, generalised
 *  to a per-dash list):
 *    • dashed — black on the first half of every dash;
 *    • dotted — a half-dot is a full disc at halo width under round
 *      caps (it would turn every dot black), so black takes WHOLE dots
 *      instead, every other one. A loop with an odd dot count ends with
 *      two black dots side by side at the start of the path.
 *  Every rewritten pair keeps its dash + gap length, so the twin stays
 *  in phase with the halo under the same dashoffset. */
export function shapeStripeDash(
  pattern: ShapeStrokeDash,
  style: Exclude<ShapeStrokeStyle, "solid">
): ShapeStrokeDash {
  const values = pattern.dasharray.split(" ").map(Number);
  const out: number[] = [];
  if (style === "dashed") {
    for (let i = 0; i + 1 < values.length; i += 2) {
      const d = values[i]!;
      out.push(d / 2, d / 2 + values[i + 1]!);
    }
  } else if (values.length === 2) {
    // An ellipse's uniform pattern repeats one dot + gap; black on every
    // other dot is one dot + three segments of hole.
    const [d, g] = values as [number, number];
    out.push(d, g + d + g);
  } else {
    for (let i = 0; i + 1 < values.length; i += 4) {
      const d = values[i]!;
      const g = values[i + 1]!;
      const skipped =
        i + 3 < values.length ? values[i + 2]! + values[i + 3]! : 0;
      out.push(d, g + skipped);
    }
  }
  return { dasharray: out.map(fmt).join(" "), dashoffset: pattern.dashoffset };
}
