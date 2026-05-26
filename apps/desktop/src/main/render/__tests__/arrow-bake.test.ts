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

  test("open-triangle is HOLLOW: both polygons fill='none', halo stroke wider than colored", () => {
    // Regression for the "hollow head is filled with white" bug.
    // Pre-fix the halo had fill="white", making the interior solid
    // white. Now both polygons are fill="none"; halo is a wider
    // white stroke that peeks past the colored stroke on both edges.
    // Mirrors OverlaySvg.test.tsx's renderer-side test — bake + live
    // editor have to stay in sync.
    const svg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "open-triangle" },
      W,
      H
    );
    // Halo polygon: fill="none", stroke="white", widened to halo
    // both edges of the colored stroke.
    expect(svg).toMatch(/<polygon points="[^"]+" fill="none" stroke="white" stroke-width="[\d.]+"/);
    // Colored head: fill="none", stroke=accent.
    expect(svg).toMatch(/<polygon points="[^"]+" fill="none" stroke="#ff8a1f" stroke-width="[\d.]+"/);
    // No solid-white polygon — that'd be the bug returning.
    expect(svg).not.toMatch(/<polygon[^>]+fill="white"/);
    expect(svg).not.toMatch(/<circle/);
    // Halo stroke must be wider than colored stroke (otherwise the
    // halo can't peek out on either edge).
    const haloMatch = svg.match(/<polygon points="[^"]+" fill="none" stroke="white" stroke-width="([\d.]+)"/);
    const coloredMatch = svg.match(/<polygon points="[^"]+" fill="none" stroke="#ff8a1f" stroke-width="([\d.]+)"/);
    expect(haloMatch).not.toBeNull();
    expect(coloredMatch).not.toBeNull();
    expect(Number(haloMatch![1])).toBeGreaterThan(Number(coloredMatch![1]));
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

  test("thickness 'x-large' lifts past auto × 3 on Retina-scale captures (floor wins)", () => {
    // X-Large's whole purpose: on high-DPI captures the auto stroke
    // clamps at STROKE_MAX_PX = 14, so multiplier-only XL caps at 42.
    // The floor-fraction formula `max(auto × 3, shortSide × 0.020)`
    // lifts that on 4K+ images. At W=800, shortSide=600 → floor
    // wins on this test image: 600 × 0.020 = 12 px which is below
    // the multiplier (auto × 3 ≈ a much bigger number) — so this
    // test image isn't dramatic enough to show the floor. Use a
    // bigger image to demonstrate.
    const bigW = 4000;
    const bigH = 2800;
    const xlSvg = arrowSvgForV2({ ...baseArrow(), thickness: "x-large" }, bigW, bigH);
    const xlStroke = Number(
      xlSvg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    // shortSide × 0.020 = 2800 × 0.020 = 56. auto × 3 = 14 × 3 = 42.
    // Floor wins → expect ≈ 56.
    expect(xlStroke).toBeGreaterThan(50);
    expect(xlStroke).toBeLessThan(60);
  });

  test("numeric thickness: 0.02 fraction expands to ≈ 0.02 × shortSide pixels", () => {
    // Regression for the previously-broken numeric path. Pre-fix the
    // bake passed pixel autoStroke into readOverlayThickness's
    // numeric branch (which expected a fraction) — silent
    // unit-mismatch bug. Now we go through the three-arg form so
    // numeric thickness expands cleanly to pixels.
    const svg = arrowSvgForV2({ ...baseArrow(), thickness: 0.02 }, W, H);
    const stroke = Number(
      svg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    // shortSide = 600 (min of 800 × 600). 0.02 × 600 = 12.
    expect(stroke).toBeCloseTo(12, 1);
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

describe("arrowSvg (bake) — head scales with thickness override", () => {
  // Regression for the same bug the renderer caught in
  // OverlaySvg.test.tsx — the bake's `arrowSvg` mirrors the
  // renderer's ArrowGlyph two-step thickness resolution, and if
  // someone updates one side without the other the bake will
  // silently produce fat-stem-tiny-head arrows in library
  // thumbnails. Asserts the head polygon's perpendicular extent
  // (y-range of vertices on a horizontal arrow) ~doubles with
  // Large.

  function headPerpExtent(svg: string): number {
    // Match the FIRST colored polygon (skip the white halo). The
    // polygon points attr is `x1,y1 x2,y2 x3,y3` for the head
    // triangle.
    const coloredPolyMatch = svg.match(
      /<polygon points="([^"]+)" fill="#[0-9a-f]{6}"\s*\/>/i
    );
    if (coloredPolyMatch === null) {
      throw new Error("colored head polygon not found in bake SVG");
    }
    const ys = coloredPolyMatch[1]!
      .trim()
      .split(/\s+/)
      .map((pair) => Number(pair.split(",")[1]));
    return Math.max(...ys) - Math.min(...ys);
  }

  test("thickness 'large' scales the head ~2× alongside the stem", () => {
    const autoSvg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle", thickness: "auto" },
      W,
      H
    );
    const largeSvg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle", thickness: "large" },
      W,
      H
    );
    expect(headPerpExtent(largeSvg) / headPerpExtent(autoSvg)).toBeCloseTo(2, 1);
  });

  test("thickness 'small' scales the head ~0.5× alongside the stem", () => {
    const autoSvg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle", thickness: "auto" },
      W,
      H
    );
    const smallSvg = arrowSvgForV2(
      { ...baseArrow(), endStyle: "filled-triangle", thickness: "small" },
      W,
      H
    );
    expect(headPerpExtent(smallSvg) / headPerpExtent(autoSvg)).toBeCloseTo(0.5, 1);
  });
});

describe("arrowSvg (bake) — styleVersion", () => {
  // The versioned style table is the load-bearing mechanism for
  // freezing historical arrow proportions when the visual recipe
  // changes. These tests prove the bake honors the version field —
  // a regression here would silently rewrite library thumbnails when
  // we add a v3+ in the future.

  function coloredStemStrokeWidth(svg: string): number {
    // The colored stem is the second <line> with stroke="#hex".
    // The default fillColor is `#ff8a1f`; pull its stroke-width.
    const m = svg.match(/stroke="#[0-9a-f]{6}" stroke-width="([\d.]+)"/i);
    if (m === null) throw new Error("colored stem stroke-width not found");
    return Number(m[1]);
  }
  function headLengthPxAlongArrow(svg: string): number {
    // Horizontal arrow → head length = (to.x − baseCenter.x) =
    // (apex x) − (min of base-corner xs). Extract head polygon
    // vertices via the colored fill polygon.
    const polyMatch = svg.match(
      /<polygon points="([^"]+)" fill="#[0-9a-f]{6}"\s*\/>/i
    );
    if (polyMatch === null) throw new Error("colored head polygon not found");
    const xs = polyMatch[1]!
      .trim()
      .split(/\s+/)
      .map((pair) => Number(pair.split(",")[0]));
    return Math.max(...xs) - Math.min(...xs);
  }

  test("no styleVersion → v1 (legacy 3.5/2.6 ratios)", () => {
    const svg = arrowSvgForV2(baseArrow(), W, H);
    const stroke = coloredStemStrokeWidth(svg);
    const headLen = headLengthPxAlongArrow(svg);
    // v1: headLength = 3.5 × stroke.
    expect(headLen / stroke).toBeCloseTo(3.5, 1);
  });

  test("explicit v1 matches the legacy default", () => {
    const a = arrowSvgForV2(baseArrow(), W, H);
    const b = arrowSvgForV2({ ...baseArrow(), styleVersion: 1 }, W, H);
    expect(b).toBe(a);
  });

  test("v2 uses Office-aligned 5/3 ratios", () => {
    const svg = arrowSvgForV2(
      { ...baseArrow(), styleVersion: 2 },
      W,
      H
    );
    const stroke = coloredStemStrokeWidth(svg);
    const headLen = headLengthPxAlongArrow(svg);
    // v2: headLength = 5 × stroke.
    expect(headLen / stroke).toBeCloseTo(5, 1);
  });

  test("v1 and v2 produce visibly different head lengths for the same row", () => {
    // Same row, two version pins → bake produces different SVG.
    // This is the WHOLE POINT of the version table.
    const v1Svg = arrowSvgForV2({ ...baseArrow(), styleVersion: 1 }, W, H);
    const v2Svg = arrowSvgForV2({ ...baseArrow(), styleVersion: 2 }, W, H);
    expect(headLengthPxAlongArrow(v2Svg)).toBeGreaterThan(
      headLengthPxAlongArrow(v1Svg)
    );
  });

  test("unknown future version falls back to v1 (fail-safe)", () => {
    // A v999 row read by this client must NOT silently render at v2.
    // The version table is freeze-in-place; an unknown version gets
    // the legacy recipe, not "the closest known version."
    const v1 = arrowSvgForV2({ ...baseArrow(), styleVersion: 1 }, W, H);
    const future = arrowSvgForV2({ ...baseArrow(), styleVersion: 999 }, W, H);
    expect(future).toBe(v1);
  });
});

describe("arrowSvg (bake) — portrait images (the original symptom)", () => {
  // The pixel-space viewBox change in this PR was specifically aimed
  // at portrait captures where the previous "0 0 1 1" + preserve
  // AspectRatio="none" SVG non-uniformly stretched X vs Y, skewing
  // strokes and producing the "fang at the tail" artifact. These
  // tests run at a portrait aspect (720×1280, the rough proportion
  // of a Quick Capture popover) and verify the geometry survives.
  const PORTRAIT_W = 720;
  const PORTRAIT_H = 1280;

  test("filled-triangle head triangle is isosceles on portrait (perpendicular not skewed)", () => {
    // For a horizontal arrow on a portrait image, the head triangle's
    // two base corners should sit equidistant from the geometric
    // base center along the perpendicular axis (Y). Pre-fix the
    // non-uniform viewBox stretch made this asymmetric. computeArrow
    // Geometry now computes perpendicular in pixel space, so the
    // triangle is isosceles regardless of image aspect.
    const svg = arrowSvgForV2(
      {
        kind: "arrow",
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.8, y: 0.5 },
        color: "auto",
        endStyle: "filled-triangle"
      },
      PORTRAIT_W,
      PORTRAIT_H
    );
    // Colored head polygon points: apex + two base corners.
    const poly = svg.match(/<polygon points="([^"]+)" fill="#[0-9a-f]{6}"\s*\/>/i);
    expect(poly).not.toBeNull();
    const points = poly![1]!
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number));
    expect(points.length).toBe(3);
    // For a horizontal arrow, apex.y === arrow center, base corners
    // sit equidistant above and below. Find apex (the point with
    // max x; arrow goes left → right) and verify the other two are
    // mirrored around apex.y.
    const ys = points.map((p) => p[1]!);
    const xs = points.map((p) => p[0]!);
    const apexIdx = xs.indexOf(Math.max(...xs));
    const apexY = ys[apexIdx]!;
    const otherYs = ys.filter((_, i) => i !== apexIdx);
    const dyTop = otherYs[0]! - apexY;
    const dyBottom = otherYs[1]! - apexY;
    // Equidistant: |dyTop + dyBottom| ≈ 0 (one positive, one negative).
    expect(Math.abs(dyTop + dyBottom)).toBeLessThan(0.01);
  });

  test("portrait stem line is the line direction, not aspect-skewed", () => {
    // On a horizontal arrow, the stem's y1 and y2 should be equal
    // (line is horizontal in image pixels). Pre-fix the non-uniform
    // viewBox stretch didn't reach into the bake — the bake was
    // always pixel-space — so this passes pre- and post-fix. The
    // analogous test exists in the renderer where it's more load-
    // bearing.
    const svg = arrowSvgForV2(
      {
        kind: "arrow",
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.8, y: 0.5 },
        color: "auto"
      },
      PORTRAIT_W,
      PORTRAIT_H
    );
    // Colored stem in the bake spans two lines (attr indentation
     // wraps after y2). Match across whitespace including newlines.
    const stemMatch = svg.match(
      /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"[\s\S]*?stroke="#ff8a1f"/
    );
    expect(stemMatch).not.toBeNull();
    const [y1, y2] = [Number(stemMatch![2]), Number(stemMatch![4])];
    expect(y1).toBeCloseTo(y2, 4);
  });

  test("diagonal arrow's head triangle stays proportional on portrait", () => {
    // Diagonal arrow on portrait image — the case where the
    // non-uniform viewBox stretch was most visible (vertical fang
    // at tail). Verify head proportions match the styleVersion's
    // ratios regardless of aspect.
    const svg = arrowSvgForV2(
      {
        kind: "arrow",
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.9, y: 0.9 },
        color: "auto",
        styleVersion: 2
      },
      PORTRAIT_W,
      PORTRAIT_H
    );
    const stroke = Number(
      svg.match(/stroke="#ff8a1f" stroke-width="([\d.]+)"/)?.[1] ?? ""
    );
    expect(stroke).toBeGreaterThan(0);
    // Head extent — compute the polygon's diagonal extent and compare
    // to expected head length (= stroke × 5 for v2). Use the
    // polygon's bounding box diagonal as a proxy.
    const poly = svg.match(/<polygon points="([^"]+)" fill="#[0-9a-f]{6}"\s*\/>/i);
    expect(poly).not.toBeNull();
    const points = poly![1]!
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number));
    const xs = points.map((p) => p[0]!);
    const ys = points.map((p) => p[1]!);
    const diag = Math.hypot(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys)
    );
    // Diagonal of the head's bounding box is approximately the head
    // length (the triangle is elongated along the arrow direction).
    // v2: head length = 5 × stroke. Tolerate some slop since the
    // bbox-diagonal isn't exactly the head length, but assert order
    // of magnitude.
    expect(diag).toBeGreaterThan(stroke * 3);
    expect(diag).toBeLessThan(stroke * 7);
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
