import { describe, expect, test } from "vitest";
import {
  computeShapeStrokeDashArray,
  computeStemDashArray,
  shapeOutlinePerimeterPx
} from "../index";

function parse(dash: string | null): { dash: number; gap: number } {
  if (dash === null) throw new Error("expected a dash pattern");
  const [d, g] = dash.split(" ").map(Number);
  return { dash: d!, gap: g! };
}

describe("shapeOutlinePerimeterPx", () => {
  test("rect and square are 2 × (w + h)", () => {
    expect(shapeOutlinePerimeterPx("rect", 300, 100, 15)).toBe(800);
    expect(shapeOutlinePerimeterPx("square", 100, 100, 15)).toBe(400);
  });

  test("a circle is π × diameter", () => {
    expect(shapeOutlinePerimeterPx("circle", 200, 200, 0)).toBeCloseTo(Math.PI * 200, 6);
  });

  test("an oval is close to the exact elliptic perimeter", () => {
    // a = 150, b = 50: the complete elliptic integral gives ≈ 668.2.
    expect(shapeOutlinePerimeterPx("oval", 300, 100, 0)).toBeCloseTo(668.19, 1);
  });

  test("a parallelogram's slanted edges grow with the skew; skew only applies to it", () => {
    expect(shapeOutlinePerimeterPx("parallelogram", 300, 100, 0)).toBe(800);
    const skewed = shapeOutlinePerimeterPx("parallelogram", 300, 100, 45);
    // shear = 50 each side ⇒ slanted edge spans 100 × 100.
    expect(skewed).toBeCloseTo(2 * (300 + Math.hypot(100, 100)), 6);
    expect(shapeOutlinePerimeterPx("rect", 300, 100, 45)).toBe(800);
  });
});

describe("computeShapeStrokeDashArray", () => {
  test("solid is no pattern at all, so legacy rows emit no attribute", () => {
    expect(computeShapeStrokeDashArray("solid", 800, 4)).toBeNull();
  });

  test("a closed outline fits a whole number of dash + gap cycles exactly", () => {
    for (const style of ["dashed", "dotted"] as const) {
      for (const perimeter of [800, 1234.5, 97]) {
        const { dash, gap } = parse(computeShapeStrokeDashArray(style, perimeter, 4));
        const cycles = perimeter / (dash + gap);
        expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-9);
      }
    }
  });

  test("keeps the arrow stem's rhythm: dashed 4:2 and dotted 0.01:1.8, in stroke widths", () => {
    const dashed = parse(computeShapeStrokeDashArray("dashed", 800, 4));
    expect(dashed.dash / dashed.gap).toBeCloseTo(2, 9);
    expect(dashed.dash / 4).toBeCloseTo(4, 0);
    const dotted = parse(computeShapeStrokeDashArray("dotted", 800, 4));
    expect(dotted.dash / dotted.gap).toBeCloseTo(0.01 / 1.8, 9);
    // The stem helper's natural lengths are the same numbers.
    const stem = parse(computeStemDashArray("dashed", 6000, 4));
    expect(stem.dash / stem.gap).toBeCloseTo(2, 9);
  });

  test("the pattern scales with the stroke width (and so with annotationBasisPx)", () => {
    const thin = parse(computeShapeStrokeDashArray("dashed", 6000, 3));
    const thick = parse(computeShapeStrokeDashArray("dashed", 6000, 9));
    expect(thick.dash / thin.dash).toBeCloseTo(3, 1);
  });

  test("a degenerate shape has nothing to pattern", () => {
    expect(computeShapeStrokeDashArray("dashed", 0, 4)).toBeNull();
    expect(computeShapeStrokeDashArray("dotted", 800, 0)).toBeNull();
  });
});
