// Bake-path tests for Draw strokes. The bake serializes the SAME shared
// `strokeGeometry` the editor paints (OverlaySvg's StrokeGlyph), so a
// stroke exports as it previewed. The two properties pinned here are the
// ones a bake can break on its own: scaled exports keep the stroke's
// proportions (the airbrush's bands included — scaled, not re-derived
// at the export size), and "auto" resolves to a real color.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import {
  annotationBasisPx,
  strokeGeometries,
  strokeGeometry,
  strokeSvgElements
} from "@pwrsnap/shared";
import { strokeSvgForV2 } from "../compose";

type Stroke = Extract<OverlayRow["data"], { kind: "stroke" }>;

const W = 800;
const H = 600;
const BASIS = annotationBasisPx(W, H);

const pen: Stroke = {
  kind: "stroke",
  tool: "pen",
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.3, y: 0.35 },
    { x: 0.6, y: 0.3 }
  ],
  color: "#ff5a5a",
  thickness: "medium"
};

describe("strokeSvgForV2 (bake)", () => {
  test("at 1× it is exactly the shared geometry's SVG", () => {
    const expected = strokeSvgElements(strokeGeometry(pen, W, H, BASIS), "#ff5a5a");
    const svg = strokeSvgForV2(pen, W, H, BASIS);
    expect(svg).toContain(expected);
    expect(svg).not.toContain("scale(");
  });

  test("a 2× export scales the 1× geometry rather than re-deriving it", () => {
    const at1 = strokeSvgElements(strokeGeometry(pen, W, H, BASIS), "#ff5a5a");
    const svg = strokeSvgForV2(pen, W * 2, H * 2, BASIS * 2, 2);
    expect(svg).toContain('transform="scale(2)"');
    expect(svg).toContain(at1);
  });

  test("an airbrush bakes the same bands at any export scale", () => {
    const airbrush: Stroke = { ...pen, tool: "airbrush" };
    const at1 = strokeSvgElements(strokeGeometry(airbrush, W, H, BASIS), "#ff5a5a");
    const svg = strokeSvgForV2(airbrush, W * 3, H * 3, BASIS * 3, 3);
    expect(svg).toContain(at1);
    expect(svg).toContain('transform="scale(3)"');
  });

  test('color "auto" bakes the brand accent, never the literal "auto"', () => {
    const svg = strokeSvgForV2({ ...pen, color: "auto" }, W, H, BASIS);
    expect(svg).not.toContain('"auto"');
    expect(svg).toMatch(/stroke="#[0-9a-f]{6}"/i);
  });

  test("a stroke with segments bakes each one as its own element", () => {
    const twoPieces: Stroke = {
      ...pen,
      tool: "marker",
      points: [...pen.points, { x: 0.1, y: 0.8 }, { x: 0.6, y: 0.8 }],
      breaks: [3]
    };
    const svg = strokeSvgForV2(twoPieces, W, H, BASIS);
    for (const geometry of strokeGeometries(twoPieces, W, H, BASIS)) {
      expect(svg).toContain(strokeSvgElements(geometry, "#ff5a5a"));
    }
    // Two translucent paths, each with its own opacity — the look of two
    // separate strokes.
    expect(svg.match(/<path /g)).toHaveLength(2);
  });

  test("the marker bakes translucent with a flat cap", () => {
    const svg = strokeSvgForV2({ ...pen, tool: "marker" }, W, H, BASIS);
    expect(svg).toContain('stroke-linecap="butt"');
    expect(svg).toContain('opacity="0.42"');
  });
});
