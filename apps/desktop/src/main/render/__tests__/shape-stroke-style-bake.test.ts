// Bake-path tests for ShapeOverlay.strokeStyle (solid / dashed /
// dotted). Same string-level style as rect-bake.test.ts, plus one real
// rasterization to prove the pattern reaches pixels.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import {
  annotationBasisPx,
  computeShapeStrokeDash,
  shapeStripeDash
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

const offsetsOf = (svg: string): number[] =>
  Array.from(svg.matchAll(/stroke-dashoffset="([^"]+)"/g), (m) => Number(m[1]!));

/** The middle (whole, un-split) dash of the list — the corner dashes
 *  at either end are two halves from different edges. */
const midDash = (dasharray: string): number => Number(dasharray.split(" ")[2]);

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
    const expected = computeShapeStrokeDash("dashed", "rect", 0.5 * W, 0.5 * H, 0, coloredStroke(svg))!;
    expect(dashes[0]).toBe(expected.dasharray);
    // Both strokes start half-way into the corner dash at the top-left.
    expect(offsetsOf(svg)).toEqual([expected.dashoffset, expected.dashoffset]);
    expect(expected.dashoffset).toBeGreaterThan(0);
  });

  test("the dash is a multiple of the ladder's stroke, so it grows with thickness", () => {
    const dashOf = (thickness: "small" | "x-large"): number =>
      midDash(dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed", thickness }), W, H))[0]!);
    const basis = annotationBasisPx(W, H);
    // ≈ 4 × stroke, give or take the whole-cycle fit.
    expect(dashOf("small") / (basis / 160)).toBeCloseTo(4, 0);
    expect(dashOf("x-large") / dashOf("small")).toBeCloseTo(160 / 44, 0);
  });

  test("a scaled bake scales the pattern with the passed basis", () => {
    const basis = annotationBasisPx(W, H);
    const one = dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed" }), W, H, basis))[0]!;
    const two = dashesOf(shapeSvgForV2(shape({ strokeStyle: "dashed" }), W * 2, H * 2, basis * 2))[0]!;
    expect(midDash(two)).toBeCloseTo(2 * midDash(one), 3);
  });

  test("every primitive is patterned by the shared helper, with the editor's geometry", () => {
    for (const kind of ["circle", "oval", "parallelogram", "square"] as const) {
      const svg = shapeSvgForV2(shape({ shape: kind, strokeStyle: "dotted", skewDeg: 20 }), W, H);
      const expected = computeShapeStrokeDash(
        "dotted",
        kind,
        0.5 * W,
        0.5 * H,
        kind === "parallelogram" ? 20 : 0,
        coloredStroke(svg)
      )!;
      expect(dashesOf(svg)[0]).toBe(expected.dasharray);
    }
  });

  test("Border off still patterns the lone colored stroke", () => {
    const svg = shapeSvgForV2(shape({ strokeStyle: "dashed", outline: "none" }), W, H);
    expect(dashesOf(svg)).toHaveLength(1);
    expect(svg).toContain('stroke-linecap="round"');
  });

  test("a striped border stripes WITHIN the dashes, in phase with the halo", () => {
    const svg = shapeSvgForV2(shape({ strokeStyle: "dashed", outline: "stripe" }), W, H);
    const dashes = dashesOf(svg);
    expect(dashes).toHaveLength(3);
    const halo = { dasharray: dashes[0]!, dashoffset: offsetsOf(svg)[0]! };
    expect(dashes[1]).toBe(shapeStripeDash(halo, "dashed").dasharray);
    expect(offsetsOf(svg)).toEqual([halo.dashoffset, halo.dashoffset, halo.dashoffset]);
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

  test("every corner of a dashed / dotted rect and parallelogram is painted", async () => {
    // The corner pixel itself, for every corner: the pattern is aligned
    // so each one sits in the middle of a dash (or a dot).
    const at = (raw: Buffer, x: number, y: number): number =>
      raw[(Math.round(y) * 400 + Math.round(x)) * 4 + 3]!;
    const rect = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    for (const strokeStyle of ["dashed", "dotted"] as const) {
      for (const kind of ["rect", "parallelogram"] as const) {
        const skewDeg = kind === "parallelogram" ? 20 : 0;
        const svg = shapeSvgForV2(
          { ...shape({ shape: kind, strokeStyle, skewDeg, rect }), outline: "none", thickness: "x-large" },
          400,
          300
        );
        const raw = (await rasterizeSvgForV2(svg, 400, 300)).input as Buffer;
        const [x0, y0, w, h] = [rect.x * 400, rect.y * 300, rect.w * 400, rect.h * 300];
        const shear = kind === "parallelogram" ? (h / 2) * Math.tan((skewDeg * Math.PI) / 180) : 0;
        const corners = [
          [x0 + shear, y0],
          [x0 + w + shear, y0],
          [x0 + w - shear, y0 + h],
          [x0 - shear, y0 + h]
        ] as const;
        for (const [x, y] of corners) {
          expect(at(raw, x, y), `${strokeStyle} ${kind} corner ${x},${y}`).toBeGreaterThan(200);
        }
      }
    }
  });
});
