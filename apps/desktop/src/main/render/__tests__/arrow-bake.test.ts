// Bake-path tests for arrow endStyle / stemStyle / doubleEnded.
// These assertions run against the raw SVG string produced by
// `arrowSvgForV2` (the export alias for the private `arrowSvg`
// helper inside compose.ts) — string-level checks are sufficient
// to pin each variant's structural shape without spinning up a
// full sharp rasterize pass.
//
// The actual rendering (PNG output via sharp/resvg) is covered by
// the existing compose.ts integration paths; here we just verify
// the SVG we hand to sharp encodes the right glyph for each
// (endStyle × stemStyle × doubleEnded) combination.

import { describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";
import { arrowSvgForV2 } from "../compose";

const W = 800;
const H = 600;

function baseArrow(): Extract<OverlayRow["data"], { kind: "arrow" }> {
  return {
    kind: "arrow",
    from: { x: 0.2, y: 0.5 },
    to: { x: 0.8, y: 0.5 },
    color: "auto"
  };
}

describe("arrowSvg (bake) — endStyle variants", () => {
  test("filled-triangle (default for legacy rows) renders one filled polygon for the head", () => {
    const svg = arrowSvgForV2(baseArrow(), W, H);
    // Two polygons total: the white halo (with stroke="white") and
    // the colored fill polygon underneath.
    expect(svg).toMatch(/<polygon points=".+?" fill="white" stroke="white"/);
    expect(svg).toMatch(/<polygon points=".+?" fill="#ff8a1f"\s*\/>/);
    // No circle / line-cap-bar head primitives for the default style.
    expect(svg).not.toMatch(/<circle/);
  });

  test("filled-triangle explicit matches the legacy-default output", () => {
    const legacy = arrowSvgForV2(baseArrow(), W, H);
    const explicit = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle" },
      W,
      H
    );
    expect(explicit).toBe(legacy);
  });

  test("open-triangle renders a stroked-only polygon (fill='none', stroke=color)", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "open-triangle" },
      W,
      H
    );
    // Halo is still a filled white polygon.
    expect(svg).toMatch(/<polygon points=".+?" fill="white" stroke="white"/);
    // Colored head: fill="none", stroke=accent.
    expect(svg).toMatch(/<polygon points=".+?" fill="none" stroke="#ff8a1f"/);
    expect(svg).not.toMatch(/<circle/);
  });

  test("line endStyle renders a perpendicular bar at the apex, no head polygon", () => {
    const svg = arrowSvgForV2({ ...baseArrow(), endStyle: "line" }, W, H);
    // Two extra line elements (halo + colored) for the cross-bar at
    // the head — plus the two stem lines (halo + colored). 4 total.
    const lineCount = (svg.match(/<line\s/g) ?? []).length;
    expect(lineCount).toBe(4);
    // No head polygons at all.
    expect(svg).not.toMatch(/<polygon/);
    expect(svg).not.toMatch(/<circle/);
  });

  test("dot endStyle renders concentric halo+fill circles, no head polygon", () => {
    const svg = arrowSvgForV2({ ...baseArrow(), endStyle: "dot" }, W, H);
    // Two circles: white halo + colored fill.
    const circleCount = (svg.match(/<circle\s/g) ?? []).length;
    expect(circleCount).toBe(2);
    expect(svg).toMatch(/<circle cx=".+?" cy=".+?" r=".+?" fill="white"/);
    expect(svg).toMatch(/<circle cx=".+?" cy=".+?" r=".+?" fill="#ff8a1f"/);
    expect(svg).not.toMatch(/<polygon/);
  });

  test("explicit hex color overrides the auto accent for filled-triangle", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), color: "#ff0000", endStyle: "filled-triangle" },
      W,
      H
    );
    expect(svg).toMatch(/fill="#ff0000"/);
    expect(svg).not.toMatch(/fill="#ff8a1f"/);
  });

  test("explicit hex color also flows to dot / line / open-triangle heads", () => {
    for (const endStyle of ["dot", "line", "open-triangle"] as const) {
      const svg = arrowSvgForV2(
        { ...baseArrow(), color: "#00ff00", endStyle },
        W,
        H
      );
      expect(svg).toContain("#00ff00");
      expect(svg).not.toContain("#ff8a1f");
    }
  });
});

describe("arrowSvg (bake) — stemStyle variants", () => {
  test("solid stem omits stroke-dasharray", () => {
    const svg = arrowSvgForV2(baseArrow(), W, H);
    expect(svg).not.toContain("stroke-dasharray");
  });

  test("dashed stem emits stroke-dasharray with dash pattern (~4×stroke / 2×stroke)", () => {
    const svg = arrowSvgForV2({ ...baseArrow(), stemStyle: "dashed" }, W, H);
    expect(svg).toMatch(/stroke-dasharray="[^"]+"/);
    // Pattern is `${stroke*4} ${stroke*2}` — assert the two numbers
    // are in a 2:1 ratio.
    const match = svg.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
    expect(match).not.toBeNull();
    const on = Number(match![1]);
    const off = Number(match![2]);
    expect(on / off).toBeCloseTo(2, 1);
  });

  test("dotted stem emits a tiny on / longer off pattern (renders as dots with round caps)", () => {
    const svg = arrowSvgForV2({ ...baseArrow(), stemStyle: "dotted" }, W, H);
    expect(svg).toMatch(/stroke-dasharray="[^"]+"/);
    const match = svg.match(/stroke-dasharray="([\d.]+) ([\d.]+)"/);
    expect(match).not.toBeNull();
    const on = Number(match![1]);
    const off = Number(match![2]);
    // dotted = `${stroke*0.01} ${stroke*1.8}` → on << off.
    expect(on).toBeLessThan(off);
    expect(on / off).toBeLessThan(0.05);
  });

  test("halo stem mirrors the colored stem's dash pattern when dashed", () => {
    // The halo MUST carry the same dash pattern as the colored stem.
    // A solid halo with a dashed colored stem shows solid-white
    // "ghost" dashes through the gaps — looks like white dashes
    // against the background and defeats the dashed visual.
    const svg = arrowSvgForV2({ ...baseArrow(), stemStyle: "dashed" }, W, H);
    const lines = svg.match(/<line[^/]+\/>/g) ?? [];
    const haloLine = lines.find((l) => l.includes('stroke="white"'));
    const coloredLine = lines.find((l) => !l.includes('stroke="white"'));
    expect(haloLine).toBeDefined();
    expect(coloredLine).toBeDefined();
    const haloDash = haloLine!.match(/stroke-dasharray="([^"]+)"/);
    const coloredDash = coloredLine!.match(/stroke-dasharray="([^"]+)"/);
    expect(haloDash).not.toBeNull();
    expect(coloredDash).not.toBeNull();
    expect(haloDash![1]).toBe(coloredDash![1]);
  });

  test("halo stem mirrors the colored stem's dash pattern when dotted", () => {
    const svg = arrowSvgForV2({ ...baseArrow(), stemStyle: "dotted" }, W, H);
    const lines = svg.match(/<line[^/]+\/>/g) ?? [];
    const haloLine = lines.find((l) => l.includes('stroke="white"'));
    const coloredLine = lines.find((l) => !l.includes('stroke="white"'));
    const haloDash = haloLine!.match(/stroke-dasharray="([^"]+)"/);
    const coloredDash = coloredLine!.match(/stroke-dasharray="([^"]+)"/);
    expect(haloDash).not.toBeNull();
    expect(coloredDash).not.toBeNull();
    expect(haloDash![1]).toBe(coloredDash![1]);
  });

  test("halo stem stays solid when the colored stem is solid", () => {
    // Sanity — no spurious dasharray gets stamped on the halo when
    // there's no dash pattern to mirror.
    const svg = arrowSvgForV2(baseArrow(), W, H);
    const lines = svg.match(/<line[^/]+\/>/g) ?? [];
    const haloLine = lines.find((l) => l.includes('stroke="white"'));
    expect(haloLine).toBeDefined();
    expect(haloLine).not.toContain("stroke-dasharray");
  });
});

describe("arrowSvg (bake) — thickness", () => {
  test("auto / undefined falls back to the legacy geometry stroke", () => {
    const baseline = arrowSvgForV2(baseArrow(), W, H);
    const explicit = arrowSvgForV2({ ...baseArrow(), thickness: "auto" }, W, H);
    expect(explicit).toBe(baseline);
  });

  test("thickness 'large' renders ~2× the auto stroke width", () => {
    const autoSvg = arrowSvgForV2({ ...baseArrow(), thickness: "auto" }, W, H);
    const largeSvg = arrowSvgForV2({ ...baseArrow(), thickness: "large" }, W, H);
    // Pull the colored stem's stroke-width from each (matches
    // `stroke="#ff8a1f"`; the halo is `stroke="white"`).
    const autoStroke = Number(
      autoSvg
        .match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)
        ?.[1] ?? ""
    );
    const largeStroke = Number(
      largeSvg
        .match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)
        ?.[1] ?? ""
    );
    expect(autoStroke).toBeGreaterThan(0);
    expect(largeStroke).toBeGreaterThan(0);
    expect(largeStroke / autoStroke).toBeCloseTo(2, 1);
  });

  test("thickness 'small' renders ~0.5× the auto stroke width", () => {
    const autoSvg = arrowSvgForV2({ ...baseArrow(), thickness: "auto" }, W, H);
    const smallSvg = arrowSvgForV2({ ...baseArrow(), thickness: "small" }, W, H);
    const autoStroke = Number(
      autoSvg
        .match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)
        ?.[1] ?? ""
    );
    const smallStroke = Number(
      smallSvg
        .match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)
        ?.[1] ?? ""
    );
    expect(smallStroke / autoStroke).toBeCloseTo(0.5, 1);
  });
});

describe("arrowSvg (bake) — doubleEnded", () => {
  test("doubleEnded:false (default) renders ONE head", () => {
    const svg = arrowSvgForV2(baseArrow(), W, H);
    // Two polygons (halo + filled) = one head total.
    const polyCount = (svg.match(/<polygon\s/g) ?? []).length;
    expect(polyCount).toBe(2);
  });

  test("doubleEnded:true renders TWO triangle heads (one per endpoint)", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle", doubleEnded: true },
      W,
      H
    );
    // Four polygons total: halo+fill at head end + halo+fill at tail.
    const polyCount = (svg.match(/<polygon\s/g) ?? []).length;
    expect(polyCount).toBe(4);
  });

  test("doubleEnded:true with dot endStyle renders FOUR circles", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "dot", doubleEnded: true },
      W,
      H
    );
    const circleCount = (svg.match(/<circle\s/g) ?? []).length;
    expect(circleCount).toBe(4);
  });

  test("doubleEnded:true with line endStyle renders SIX lines (2 stem + 2 head bars × 2 endpoints)", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "line", doubleEnded: true },
      W,
      H
    );
    // 2 stem (halo + colored) + 2 head bars (halo + colored) at each
    // endpoint × 2 = 6.
    const lineCount = (svg.match(/<line\s/g) ?? []).length;
    expect(lineCount).toBe(6);
  });
});

describe("arrowSvg (bake) — combined variants (matrix smoke)", () => {
  // Sample a handful of combinations to make sure nothing throws and
  // every combo yields a syntactically-plausible SVG (correctly
  // sized, with at least one stem element).
  const combos = [
    { endStyle: "filled-triangle", stemStyle: "solid", doubleEnded: false },
    { endStyle: "filled-triangle", stemStyle: "dashed", doubleEnded: true },
    { endStyle: "open-triangle", stemStyle: "dotted", doubleEnded: false },
    { endStyle: "open-triangle", stemStyle: "solid", doubleEnded: true },
    { endStyle: "line", stemStyle: "dashed", doubleEnded: true },
    { endStyle: "line", stemStyle: "dotted", doubleEnded: false },
    { endStyle: "dot", stemStyle: "solid", doubleEnded: false },
    { endStyle: "dot", stemStyle: "dashed", doubleEnded: true }
  ] as const;

  for (const c of combos) {
    test(`renders for ${c.endStyle} / ${c.stemStyle} / doubleEnded=${c.doubleEnded}`, () => {
      const svg = arrowSvgForV2(
        {
          ...baseArrow(),
          endStyle: c.endStyle,
          stemStyle: c.stemStyle,
          doubleEnded: c.doubleEnded
        },
        W,
        H
      );
      expect(svg).toContain(`width="${W}"`);
      expect(svg).toContain(`height="${H}"`);
      // Must include at least one stem line.
      expect((svg.match(/<line\s/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  }
});
