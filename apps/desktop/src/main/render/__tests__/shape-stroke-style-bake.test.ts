// Bake-path tests for ShapeOverlay.strokeStyle (solid / dashed /
// dotted). Same string-level style as rect-bake.test.ts, plus one real
// rasterization to prove the pattern reaches pixels.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import {
  annotationBasisPx,
  computeShapeStrokeDashArray,
  outlineStripeDashArrayForStemDash,
  shapeOutlinePerimeterPx
} from "@pwrsnap/shared";
import { rasterizeSvgForV2, shapeSvgForV2 } from "../compose";

const W = 800;
const H = 600;

type ShapeData = Extract<OverlayRow["data"], { kind: "shape" }>;

function shape(patch: Partial<ShapeData> = {}): ShapeData {
  return {
    kind: "shape",
    shape: "rect",
    rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    color: "auto",
    ...patch
  };
}

const coloredStroke = (svg: string): number =>
  Number(svg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? "");

const dashesOf = (svg: string): string[] =>
  Array.from(svg.matchAll(/stroke-dasharray="([^"]+)"/g), (m) => m[1]!);

describe("shapeSvg (bake) — strokeStyle", () => {
  test("solid is byte-identical to a legacy row with no field", () => {
    const legacy = shapeSvgForV2(shape(), W, H);
    expect(shapeSvgForV2(shape({ strokeStyle: "solid" }), W, H)).toBe(legacy);
    expect(legacy).not.toContain("stroke-dasharray");
    expect(legacy).not.toContain("stroke-linecap");
  });

  test("dashed patterns the halo AND the colored stroke identically, with round caps", () => {
    const svg = shapeSvgForV2(shape({ strokeStyle: "dashed" }), W, H);
    const dashes = dashesOf(svg);
    expect(dashes).toHaveLength(2);
    expect(dashes[0]).toBe(dashes[1]);
    expect(svg).toContain('stroke-linecap="round"');
    const expected = computeShapeStrokeDashArray(
      "dashed",
      shapeOutlinePerimeterPx("rect", 0.5 * W, 0.5 * H, 0),
      coloredStroke(svg)
    );
    expect(dashes[0]).toBe(expected);
  });

  test("the dash is a multiple of the ladder's stroke, so it grows with thickness", () => {
    const dashOf = (thickness: "small" | "x-large"): number =>
      Number(dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed", thickness }), W, H))[0]!.split(" ")[0]);
    const basis = annotationBasisPx(W, H);
    // ≈ 4 × stroke, give or take the whole-cycle fit.
    expect(dashOf("small") / (basis / 160)).toBeCloseTo(4, 0);
    expect(dashOf("x-large") / dashOf("small")).toBeCloseTo(160 / 44, 0);
  });

  test("a scaled bake scales the pattern with the passed basis", () => {
    const basis = annotationBasisPx(W, H);
    const one = dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed" }), W, H, basis))[0]!;
    const two = dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed" }), W * 2, H * 2, basis * 2))[0]!;
    expect(Number(two.split(" ")[0])).toBeCloseTo(2 * Number(one.split(" ")[0]), 6);
  });

  test("every primitive is patterned, fitted to its own perimeter", () => {
    for (const kind of ["circle", "oval", "parallelogram", "square"] as const) {
      const svg = shapeSvgForV2(shape({ shape: kind, strokeStyle: "dotted", skewDeg: 20 }), W, H);
      const perimeter = shapeOutlinePerimeterPx(kind, 0.5 * W, 0.5 * H, kind === "parallelogram" ? 20 : 0);
      expect(dashesOf(svg)[0]).toBe(computeShapeStrokeDashArray("dotted", perimeter, coloredStroke(svg)));
    }
  });

  test("Border off still patterns the lone colored stroke", () => {
    const svg = shapeSvgForV2(shape({ strokeStyle: "dashed", outline: "none" }), W, H);
    expect(dashesOf(svg)).toHaveLength(1);
    expect(svg).toContain('stroke-linecap="round"');
  });

  test("a striped border stripes WITHIN the dashes, the arrow stem's rule", () => {
    const svg = shapeSvgForV2(shape({ strokeStyle: "dashed", outline: "stripe" }), W, H);
    const dashes = dashesOf(svg);
    expect(dashes).toHaveLength(3);
    expect(dashes[1]).toBe(outlineStripeDashArrayForStemDash(dashes[0]!)!.dasharray);
  });

  test("a filled shape has no outline to pattern — strokeStyle is inert", () => {
    for (const outline of [undefined, "white", "stripe"] as const) {
      const base = shape({ filled: true, ...(outline !== undefined ? { outline } : {}) });
      expect(shapeSvgForV2({ ...base, strokeStyle: "dashed" }, W, H)).toBe(shapeSvgForV2(base, W, H));
    }
  });
});

describe("shapeSvg (bake) — strokeStyle rasterizes for real", () => {
  test("a dashed outline leaves transparent gaps along its top edge; a solid one does not", async () => {
    const opaqueRunAlongTop = async (data: ShapeData): Promise<{ on: number; off: number }> => {
      const svg = shapeSvgForV2({ ...data, outline: "none", thickness: "x-large" }, 400, 300);
      const layer = await rasterizeSvgForV2(svg, 400, 300);
      const raw = layer.input as Buffer;
      const y = Math.round(0.1 * 300);
      let on = 0;
      let off = 0;
      // Stay clear of the corners: x from 25% to 55% of the width.
      for (let x = 100; x <= 220; x += 1) {
        const a = raw[(y * 400 + x) * 4 + 3]!;
        if (a > 200) on += 1;
        else if (a < 20) off += 1;
      }
      return { on, off };
    };
    const solid = await opaqueRunAlongTop(shape());
    expect(solid.off).toBe(0);
    const dashed = await opaqueRunAlongTop(shape({ strokeStyle: "dashed" }));
    expect(dashed.on).toBeGreaterThan(10);
    expect(dashed.off).toBeGreaterThan(5);
  });
});
