// Bake-path tests for rect thickness + filled. Same string-level
// assertion style as `arrow-bake.test.ts` — pin each new field's
// effect on the emitted SVG without spinning up sharp.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import { shapeSvgForV2 } from "../compose";

const W = 800;
const H = 600;

function baseRect(): Extract<OverlayRow["data"], { kind: "shape" }> {
  return {
    kind: "shape",
    shape: "rect",
    rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    color: "auto"
  };
}

describe("rectSvg (bake) — filled", () => {
  test("legacy rect (no filled field) renders as outline-only (halo + colored stroke)", () => {
    const svg = shapeSvgForV2(baseRect(), W, H);
    // Two rects: white halo + colored stroke. Both fill="none".
    const rects = svg.match(/<rect[^/]+\/>/g) ?? [];
    expect(rects.length).toBe(2);
    expect(rects.every((r) => r.includes('fill="none"'))).toBe(true);
    expect(svg).toMatch(/stroke="white"/);
    expect(svg).toMatch(/stroke="#ff8a1f"/);
  });

  test("filled:false matches legacy (no behavioral change for unfilled rows)", () => {
    const baseline = shapeSvgForV2(baseRect(), W, H);
    const explicit = shapeSvgForV2({ ...baseRect(), filled: false }, W, H);
    expect(explicit).toBe(baseline);
  });

  test("filled:true renders ONE rect with the resolved color as fill, no stroke", () => {
    const svg = shapeSvgForV2({ ...baseRect(), filled: true }, W, H);
    const rects = svg.match(/<rect[^/]+\/>/g) ?? [];
    expect(rects.length).toBe(1);
    expect(rects[0]).toContain('fill="#ff8a1f"');
    expect(rects[0]).not.toContain('stroke="white"');
    // No halo either.
    expect(svg).not.toMatch(/stroke="white"/);
  });

  test("filled:true with explicit hex uses that color as the fill", () => {
    const svg = shapeSvgForV2(
      { ...baseRect(), color: "#00ff00", filled: true },
      W,
      H
    );
    expect(svg).toContain('fill="#00ff00"');
    expect(svg).not.toContain("#ff8a1f");
  });
});

describe("rectSvg (bake) — thickness", () => {
  test("auto / undefined matches the legacy stroke width", () => {
    const baseline = shapeSvgForV2(baseRect(), W, H);
    const explicit = shapeSvgForV2({ ...baseRect(), thickness: "auto" }, W, H);
    expect(explicit).toBe(baseline);
  });

  test("thickness 'large' renders ~2× the auto stroke width", () => {
    const autoSvg = shapeSvgForV2({ ...baseRect(), thickness: "auto" }, W, H);
    const largeSvg = shapeSvgForV2({ ...baseRect(), thickness: "large" }, W, H);
    const autoStroke = Number(
      autoSvg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    const largeStroke = Number(
      largeSvg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    expect(autoStroke).toBeGreaterThan(0);
    expect(largeStroke / autoStroke).toBeCloseTo(2, 1);
  });

  test("thickness 'small' renders ~0.5× the auto stroke width", () => {
    const autoSvg = shapeSvgForV2({ ...baseRect(), thickness: "auto" }, W, H);
    const smallSvg = shapeSvgForV2({ ...baseRect(), thickness: "small" }, W, H);
    const autoStroke = Number(
      autoSvg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    const smallStroke = Number(
      smallSvg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    expect(smallStroke / autoStroke).toBeCloseTo(0.5, 1);
  });
});


describe("rectSvg (bake) — Border (contrast outline) modes", () => {
  test("legacy stroked rows match outline:'white'; outline:'black' swaps the halo color", () => {
    const legacy = shapeSvgForV2(baseRect(), W, H);
    expect(shapeSvgForV2({ ...baseRect(), outline: "white" }, W, H)).toBe(legacy);
    const black = shapeSvgForV2({ ...baseRect(), outline: "black" }, W, H);
    expect(black).toMatch(/stroke="black"/);
    expect(black).not.toMatch(/stroke="white"/);
  });

  test("outline:'auto' honors the stored pick; unresolved falls back to the white halo", () => {
    expect(
      shapeSvgForV2({ ...baseRect(), outline: "auto", outlineAuto: "black" }, W, H)
    ).toBe(shapeSvgForV2({ ...baseRect(), outline: "black" }, W, H));
    expect(shapeSvgForV2({ ...baseRect(), outline: "auto" }, W, H)).toBe(
      shapeSvgForV2(baseRect(), W, H)
    );
  });

  test("outline:'none' renders the colored stroke only", () => {
    const svg = shapeSvgForV2({ ...baseRect(), outline: "none" }, W, H);
    const rects = svg.match(/<rect[^/]+\/>/g) ?? [];
    expect(rects.length).toBe(1);
    expect(rects[0]).toContain('stroke="#ff8a1f"');
  });

  test("outline:'stripe' layers a black dashed twin under the colored stroke", () => {
    const svg = shapeSvgForV2({ ...baseRect(), outline: "stripe" }, W, H);
    const rects = svg.match(/<rect[^/]+\/>/g) ?? [];
    expect(rects.length).toBe(3);
    expect(rects.some((r) => r.includes('stroke="white"') && !r.includes("stroke-dasharray"))).toBe(true);
    expect(rects.some((r) => r.includes('stroke="black"') && r.includes("stroke-dasharray"))).toBe(true);
    expect(rects.some((r) => r.includes('stroke="#ff8a1f"'))).toBe(true);
  });

  test("FILLED + legacy stays rim-free; FILLED + explicit border draws a contrast rim under the fill", () => {
    const legacyFilled = shapeSvgForV2({ ...baseRect(), filled: true }, W, H);
    expect(legacyFilled).not.toMatch(/stroke="white"/);
    expect(shapeSvgForV2({ ...baseRect(), filled: true, outline: "none" }, W, H)).toBe(
      legacyFilled
    );
    const rimmed = shapeSvgForV2(
      { ...baseRect(), filled: true, outline: "black" },
      W,
      H
    );
    const rects = rimmed.match(/<rect[^/]+\/>/g) ?? [];
    expect(rects.length).toBe(2);
    expect(rects[0]).toContain('stroke="black"');
    expect(rects[1]).toContain('fill="#ff8a1f"');
    const striped = shapeSvgForV2(
      { ...baseRect(), filled: true, outline: "stripe" },
      W,
      H
    );
    expect((striped.match(/<rect[^/]+\/>/g) ?? []).length).toBe(3);
    expect(striped).toMatch(/stroke="black"[^>]+stroke-dasharray/);
  });
});
