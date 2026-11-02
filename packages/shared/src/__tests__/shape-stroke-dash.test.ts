import { describe, expect, test } from "vitest";
import {
  computeShapeStrokeDash,
  computeStemDashArray,
  shapeOutlineEdgesPx,
  shapeOutlinePerimeterPx,
  shapeStripeDash,
  type ShapeKind,
  type ShapeStrokeDash
} from "../index";

function values(pattern: ShapeStrokeDash): number[] {
  return pattern.dasharray.split(" ").map(Number);
}

function total(pattern: ShapeStrokeDash): number {
  return values(pattern).reduce((sum, v) => sum + v, 0);
}

/** How far a path position sits inside a dash: the distance to the
 *  nearer end of the dash covering it, or a negative number when it
 *  falls in a gap. */
function insideDash(pattern: ShapeStrokeDash, pathPosition: number): number {
  const list = values(pattern);
  const length = total(pattern);
  let at = (((pathPosition + pattern.dashoffset) % length) + length) % length;
  for (let i = 0; i < list.length; i += 1) {
    const segment = list[i]!;
    if (at <= segment) {
      return i % 2 === 0 ? Math.min(at, segment - at) : -1;
    }
    at -= segment;
  }
  return -1;
}

function vertexPositions(edges: number[]): number[] {
  const positions = [0];
  for (const edge of edges.slice(0, -1)) positions.push(positions.at(-1)! + edge);
  return positions;
}

const STROKE = 4;
const CASES: ReadonlyArray<[ShapeKind, number, number, number]> = [
  ["rect", 400, 300, 0],
  ["rect", 1234.5, 97.25, 0],
  ["square", 250, 250, 0],
  ["parallelogram", 400, 300, 15],
  ["parallelogram", 300, 120, -30],
  // Short edges: one cycle per side, so every side is half + gap + half.
  ["rect", 20, 12, 0]
];

describe("shapeOutlineEdgesPx / shapeOutlinePerimeterPx", () => {
  test("rect and square are top, right, bottom, left from the top-left corner", () => {
    expect(shapeOutlineEdgesPx("rect", 300, 100, 15)).toEqual([300, 100, 300, 100]);
    expect(shapeOutlinePerimeterPx("square", 100, 100, 15)).toBe(400);
  });

  test("a parallelogram's slanted edges grow with the skew; skew only applies to it", () => {
    expect(shapeOutlinePerimeterPx("parallelogram", 300, 100, 0)).toBe(800);
    // shear = 50 each side ⇒ slanted edge spans 100 × 100.
    expect(shapeOutlinePerimeterPx("parallelogram", 300, 100, 45)).toBeCloseTo(
      2 * (300 + Math.hypot(100, 100)),
      6
    );
    expect(shapeOutlinePerimeterPx("rect", 300, 100, 45)).toBe(800);
  });

  test("an ellipse has no corners and a near-exact perimeter", () => {
    expect(shapeOutlineEdgesPx("oval", 300, 100, 0)).toBeNull();
    expect(shapeOutlinePerimeterPx("circle", 200, 200, 0)).toBeCloseTo(Math.PI * 200, 6);
    // a = 150, b = 50: the complete elliptic integral gives ≈ 668.2.
    expect(shapeOutlinePerimeterPx("oval", 300, 100, 0)).toBeCloseTo(668.19, 1);
  });
});

describe("computeShapeStrokeDash — corners always land on a dash", () => {
  test("solid is no pattern at all, so legacy rows emit no attribute", () => {
    expect(computeShapeStrokeDash("solid", "rect", 400, 300, 0, STROKE)).toBeNull();
  });

  for (const style of ["dashed", "dotted"] as const) {
    for (const [shape, w, h, skew] of CASES) {
      test(`${style} ${shape} ${w}×${h}${skew !== 0 ? ` skew ${skew}°` : ""}: every vertex is mid-dash`, () => {
        const pattern = computeShapeStrokeDash(style, shape, w, h, skew, STROKE)!;
        const edges = shapeOutlineEdgesPx(shape, w, h, skew)!;
        // The list runs exactly once round the outline.
        expect(total(pattern)).toBeCloseTo(shapeOutlinePerimeterPx(shape, w, h, skew), 1);
        // Even length: dash/gap pairs, so SVG never flips the phase.
        expect(values(pattern).length % 2).toBe(0);
        for (const at of vertexPositions(edges)) {
          // Inside a dash by (about) half a dash on either side — a
          // dotted dash is 0.01 × stroke long, so allow rounding.
          expect(insideDash(pattern, at)).toBeGreaterThanOrEqual(-1e-6);
        }
        // The path's start vertex and its end (the same point, closing
        // the loop) are both covered.
        expect(insideDash(pattern, total(pattern) - 1e-3)).toBeGreaterThanOrEqual(0);
      });
    }
  }

  test("a vertex sits in the MIDDLE of its dash, not at one end", () => {
    const pattern = computeShapeStrokeDash("dashed", "rect", 400, 300, 0, STROKE)!;
    for (const at of vertexPositions([400, 300, 400, 300])) {
      // Natural dash is 4 × stroke = 16; each half ≈ 8 after fitting.
      expect(insideDash(pattern, at)).toBeGreaterThan(6);
    }
  });

  test("an ellipse keeps a uniform pattern that closes the loop exactly", () => {
    for (const style of ["dashed", "dotted"] as const) {
      const pattern = computeShapeStrokeDash(style, "oval", 300, 100, 0, STROKE)!;
      expect(pattern.dashoffset).toBe(0);
      const [d, g] = values(pattern);
      const cycles = shapeOutlinePerimeterPx("oval", 300, 100, 0) / (d! + g!);
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-3);
    }
  });

  test("keeps the arrow stem's rhythm: dashed 4:2 and dotted 0.01:1.8, in stroke widths", () => {
    const dashed = values(computeShapeStrokeDash("dashed", "oval", 300, 100, 0, STROKE)!);
    expect(dashed[0]! / dashed[1]!).toBeCloseTo(2, 3);
    expect(dashed[0]! / STROKE).toBeCloseTo(4, 0);
    const dotted = values(computeShapeStrokeDash("dotted", "oval", 300, 100, 0, STROKE)!);
    expect(dotted[0]! / dotted[1]!).toBeCloseTo(0.01 / 1.8, 2);
    const stem = computeStemDashArray("dashed", 6000, STROKE)!.split(" ").map(Number);
    expect(stem[0]! / stem[1]!).toBeCloseTo(2, 9);
  });

  test("the pattern scales with the stroke width (and so with annotationBasisPx)", () => {
    const mid = (unit: number): number =>
      values(computeShapeStrokeDash("dashed", "rect", 6000, 6000, 0, unit)!)[2]!;
    expect(mid(9) / mid(3)).toBeCloseTo(3, 1);
  });

  test("a degenerate shape has nothing to pattern", () => {
    expect(computeShapeStrokeDash("dashed", "rect", 0, 0, 0, STROKE)).toBeNull();
    expect(computeShapeStrokeDash("dotted", "rect", 400, 300, 0, 0)).toBeNull();
  });
});

describe("shapeStripeDash", () => {
  test("dashed: black on the first half of every dash, in phase with the halo", () => {
    const pattern = computeShapeStrokeDash("dashed", "rect", 400, 300, 0, STROKE)!;
    const stripe = shapeStripeDash(pattern, "dashed");
    expect(stripe.dashoffset).toBe(pattern.dashoffset);
    expect(total(stripe)).toBeCloseTo(total(pattern), 2);
    const halo = values(pattern);
    const black = values(stripe);
    for (let i = 0; i < halo.length; i += 2) {
      expect(black[i]).toBeCloseTo(halo[i]! / 2, 3);
    }
  });

  test("dotted ellipse: the uniform pattern blackens every other dot, not all of them", () => {
    const pattern = computeShapeStrokeDash("dotted", "oval", 300, 100, 0, STROKE)!;
    const [d, g] = values(pattern);
    const [bd, bg] = values(shapeStripeDash(pattern, "dotted"));
    expect(bd).toBeCloseTo(d!, 4);
    expect(bg).toBeCloseTo(g! + d! + g!, 4);
  });

  test("dotted: black takes whole dots, every other one", () => {
    const pattern = computeShapeStrokeDash("dotted", "rect", 400, 300, 0, STROKE)!;
    const stripe = shapeStripeDash(pattern, "dotted");
    expect(total(stripe)).toBeCloseTo(total(pattern), 2);
    const halo = values(pattern);
    const black = values(stripe);
    expect(black.length).toBe(2 * Math.ceil(halo.length / 4));
    expect(black[0]).toBeCloseTo(halo[0]!, 4);
    expect(black[1]).toBeCloseTo(halo[1]! + halo[2]! + halo[3]!, 3);
  });
});
