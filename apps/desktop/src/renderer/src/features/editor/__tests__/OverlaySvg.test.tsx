// OverlaySvg rendering tests — focused on the ArrowGlyph variants
// added with the arrow style-fields work. Renders the component with
// crafted OverlayRow inputs and asserts on the resulting DOM (no
// pixel comparison — structural assertions are enough to pin each
// endStyle / stemStyle / doubleEnded variant).
//
// Same bare-react createRoot + act harness as CropTool.test.tsx —
// no @testing-library dep so the test stays inside our existing
// minimal stack.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import { OverlaySvg } from "../OverlaySvg";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderOverlaySvg(overlays: OverlayRow[]): Promise<SVGSVGElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(OverlaySvg, {
        overlays,
        draft: null,
        imageWidthPx: 800,
        imageHeightPx: 600
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  const svg = container.querySelector("svg.editor-svg");
  if (svg === null) throw new Error("OverlaySvg did not render an svg element");
  return svg as SVGSVGElement;
}

function arrowRow(
  data: Partial<Extract<OverlayRow["data"], { kind: "arrow" }>> = {}
): OverlayRow {
  return {
    id: "arrow_test_1",
    capture_id: "cap_1",
    data: {
      kind: "arrow",
      from: { x: 0.2, y: 0.5 },
      to: { x: 0.8, y: 0.5 },
      color: "auto",
      ...data
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("OverlaySvg ArrowGlyph — endStyle", () => {
  test("legacy arrow (no endStyle) renders a filled triangle head", async () => {
    const svg = await renderOverlaySvg([arrowRow()]);
    // Halo polygon (white fill+stroke) + colored polygon (no stroke).
    const polygons = svg.querySelectorAll("polygon");
    expect(polygons.length).toBe(2);
    // No circle or head-bar primitives.
    expect(svg.querySelectorAll("circle").length).toBe(0);
  });

  test("filled-triangle explicit matches legacy", async () => {
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "filled-triangle" })]);
    expect(svg.querySelectorAll("polygon").length).toBe(2);
  });

  test("open-triangle renders fill='none' on the colored polygon", async () => {
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "open-triangle" })]);
    const polygons = svg.querySelectorAll("polygon");
    expect(polygons.length).toBe(2);
    // One of them should be the colored open polygon — fill="none".
    const openPolys = Array.from(polygons).filter(
      (p) => p.getAttribute("fill") === "none"
    );
    expect(openPolys.length).toBe(1);
  });

  test("line endStyle renders no polygon and uses head-bar lines", async () => {
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "line" })]);
    expect(svg.querySelectorAll("polygon").length).toBe(0);
    expect(svg.querySelectorAll("circle").length).toBe(0);
    // 2 stem lines (halo + colored) + 2 head-bar lines (halo + colored) = 4.
    expect(svg.querySelectorAll("line").length).toBe(4);
  });

  test("dot endStyle renders two concentric circles (halo + fill)", async () => {
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "dot" })]);
    expect(svg.querySelectorAll("polygon").length).toBe(0);
    expect(svg.querySelectorAll("circle").length).toBe(2);
  });
});

describe("OverlaySvg ArrowGlyph — stemStyle", () => {
  test("solid stem has no stroke-dasharray on the colored stem", async () => {
    const svg = await renderOverlaySvg([arrowRow({ stemStyle: "solid" })]);
    const dashedLines = Array.from(svg.querySelectorAll("line")).filter(
      (l) => l.hasAttribute("stroke-dasharray")
    );
    expect(dashedLines.length).toBe(0);
  });

  test("dashed stem applies the same stroke-dasharray to halo AND colored stem", async () => {
    // Bug fix: previously the halo was solid while the colored stem
    // was dashed; the gaps showed the solid-white halo through, which
    // looked like white dashes against the background. Halo now
    // mirrors the colored dash so gaps stay transparent.
    const svg = await renderOverlaySvg([arrowRow({ stemStyle: "dashed" })]);
    const dashedLines = Array.from(svg.querySelectorAll("line")).filter(
      (l) => l.hasAttribute("stroke-dasharray")
    );
    // Two: the white halo stem + the colored stem. They share the
    // same dasharray.
    expect(dashedLines.length).toBe(2);
    const haloDashed = dashedLines.find((l) => l.getAttribute("stroke") === "white");
    const coloredDashed = dashedLines.find((l) => l.getAttribute("stroke") !== "white");
    expect(haloDashed).toBeDefined();
    expect(coloredDashed).toBeDefined();
    expect(haloDashed!.getAttribute("stroke-dasharray")).toBe(
      coloredDashed!.getAttribute("stroke-dasharray")
    );
  });

  test("dotted stem applies stroke-dasharray with a tiny on-pattern, mirrored to halo", async () => {
    const svg = await renderOverlaySvg([arrowRow({ stemStyle: "dotted" })]);
    const dashedLines = Array.from(svg.querySelectorAll("line")).filter(
      (l) => l.hasAttribute("stroke-dasharray")
    );
    // Halo + colored stem both carry the dot pattern.
    expect(dashedLines.length).toBe(2);
    const pattern = dashedLines[0]!.getAttribute("stroke-dasharray")!;
    const [onStr, offStr] = pattern.split(/\s+/);
    const on = Number(onStr);
    const off = Number(offStr);
    expect(on).toBeLessThan(off);
    expect(on / off).toBeLessThan(0.05);
    // Halo + colored share the exact same pattern.
    expect(dashedLines[1]!.getAttribute("stroke-dasharray")).toBe(pattern);
  });
});

describe("OverlaySvg ArrowGlyph — thickness", () => {
  test("undefined thickness falls back to the auto stroke", async () => {
    const svg = await renderOverlaySvg([arrowRow()]);
    const coloredStem = Array.from(svg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    );
    expect(coloredStem).toBeDefined();
    expect(Number(coloredStem!.getAttribute("stroke-width"))).toBeGreaterThan(0);
  });

  test("thickness 'large' renders ~2× the auto stroke width", async () => {
    const autoSvg = await renderOverlaySvg([arrowRow({ thickness: "auto" })]);
    const largeSvg = await renderOverlaySvg([arrowRow({ thickness: "large" })]);
    const autoStem = Array.from(autoSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    const largeStem = Array.from(largeSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    const autoW = Number(autoStem.getAttribute("stroke-width"));
    const largeW = Number(largeStem.getAttribute("stroke-width"));
    expect(largeW / autoW).toBeCloseTo(2, 1);
  });

  test("thickness 'small' renders ~0.5× the auto stroke width", async () => {
    const autoSvg = await renderOverlaySvg([arrowRow({ thickness: "auto" })]);
    const smallSvg = await renderOverlaySvg([arrowRow({ thickness: "small" })]);
    const autoStem = Array.from(autoSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    const smallStem = Array.from(smallSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    expect(
      Number(smallStem.getAttribute("stroke-width")) /
        Number(autoStem.getAttribute("stroke-width"))
    ).toBeCloseTo(0.5, 1);
  });

  test("thickness 'large' scales the HEAD triangle too, not just the stem", async () => {
    // Pre-fix: callers applied the Large multiplier only to the stem
    // stroke they drew, leaving the head triangle at the un-multiplied
    // size from the auto geometry. Result: fat stem + tiny head.
    // Now the override is pushed into computeArrowGeometry so head
    // dimensions scale with stroke. Assert the head polygon's
    // perpendicular extent (a proxy for headWidthPx) ~doubles with
    // Large.
    function headPerpExtent(svg: SVGSVGElement): number {
      // The arrow runs horizontally in arrowRow() — from (0.2, 0.5)
      // to (0.8, 0.5). The colored head polygon (no halo) is the one
      // with `fill !== "white"`. Its three vertices' y-range equals
      // headWidthPx on a horizontal arrow.
      const polys = Array.from(svg.querySelectorAll("polygon")).filter(
        (p) => p.getAttribute("fill") !== "white"
      );
      const points = polys[0]!.getAttribute("points")!;
      const ys = points
        .trim()
        .split(/\s+/)
        .map((pair) => Number(pair.split(",")[1]));
      return Math.max(...ys) - Math.min(...ys);
    }
    const autoSvg = await renderOverlaySvg([
      arrowRow({ endStyle: "filled-triangle", thickness: "auto" })
    ]);
    const largeSvg = await renderOverlaySvg([
      arrowRow({ endStyle: "filled-triangle", thickness: "large" })
    ]);
    const autoExtent = headPerpExtent(autoSvg);
    const largeExtent = headPerpExtent(largeSvg);
    expect(largeExtent / autoExtent).toBeCloseTo(2, 1);
  });
});

function rectRow(
  data: Partial<Extract<OverlayRow["data"], { kind: "rect" }>> = {}
): OverlayRow {
  return {
    id: "rect_test_1",
    capture_id: "cap_1",
    data: {
      kind: "rect",
      rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      color: "auto",
      ...data
    },
    schema_version: 1,
    created_at: "2026-05-24T00:00:00Z",
    applied_at: "2026-05-24T00:00:00Z",
    rejected_at: null,
    superseded_by: null,
    ai_run_id: null,
    source: "user",
    z_index: 0
  };
}

describe("OverlaySvg RectGlyph — filled", () => {
  test("legacy rect (no filled field) renders outline-only (halo + colored rect)", async () => {
    const svg = await renderOverlaySvg([rectRow()]);
    const rects = svg.querySelectorAll("rect");
    expect(rects.length).toBe(2);
    Array.from(rects).forEach((r) => {
      expect(r.getAttribute("fill")).toBe("none");
    });
  });

  test("filled:true renders ONE rect with the resolved color as fill", async () => {
    const svg = await renderOverlaySvg([rectRow({ filled: true, color: "#00ff00" })]);
    const rects = svg.querySelectorAll("rect");
    expect(rects.length).toBe(1);
    expect(rects[0]!.getAttribute("fill")).toBe("#00ff00");
    expect(rects[0]!.getAttribute("stroke")).toBe("none");
  });
});

describe("OverlaySvg RectGlyph — thickness", () => {
  test("thickness 'large' renders ~2× the auto stroke width", async () => {
    const autoSvg = await renderOverlaySvg([rectRow({ thickness: "auto" })]);
    const largeSvg = await renderOverlaySvg([rectRow({ thickness: "large" })]);
    const autoStroke = Array.from(autoSvg.querySelectorAll("rect")).find(
      (r) => r.getAttribute("stroke") !== "white" && r.getAttribute("stroke") !== "none"
    )!;
    const largeStroke = Array.from(largeSvg.querySelectorAll("rect")).find(
      (r) => r.getAttribute("stroke") !== "white" && r.getAttribute("stroke") !== "none"
    )!;
    const autoW = Number(autoStroke.getAttribute("stroke-width"));
    const largeW = Number(largeStroke.getAttribute("stroke-width"));
    expect(largeW / autoW).toBeCloseTo(2, 1);
  });
});

describe("OverlaySvg ArrowGlyph — doubleEnded", () => {
  test("single-ended (default) draws one head triangle", async () => {
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "filled-triangle" })]);
    expect(svg.querySelectorAll("polygon").length).toBe(2);
  });

  test("doubleEnded:true with filled-triangle draws TWO head triangles", async () => {
    const svg = await renderOverlaySvg([
      arrowRow({ endStyle: "filled-triangle", doubleEnded: true })
    ]);
    // 4 polygons: head end (halo + filled) + tail end (halo + filled).
    expect(svg.querySelectorAll("polygon").length).toBe(4);
  });

  test("doubleEnded:true with dot draws FOUR circles", async () => {
    const svg = await renderOverlaySvg([
      arrowRow({ endStyle: "dot", doubleEnded: true })
    ]);
    expect(svg.querySelectorAll("circle").length).toBe(4);
  });

  test("doubleEnded:true with line draws SIX lines (2 stem + 2 head bars × 2 endpoints)", async () => {
    const svg = await renderOverlaySvg([
      arrowRow({ endStyle: "line", doubleEnded: true })
    ]);
    expect(svg.querySelectorAll("line").length).toBe(6);
  });
});

describe("OverlaySvg ArrowGlyph — combinations", () => {
  // Full matrix smoke: every (endStyle × stemStyle × doubleEnded)
  // combo renders without throwing and produces non-empty markup.
  const endStyles = ["filled-triangle", "open-triangle", "line", "dot"] as const;
  const stemStyles = ["solid", "dashed", "dotted"] as const;
  const doubleEndedValues = [false, true] as const;

  for (const e of endStyles) {
    for (const s of stemStyles) {
      for (const d of doubleEndedValues) {
        test(`renders for endStyle=${e}, stemStyle=${s}, doubleEnded=${d}`, async () => {
          const svg = await renderOverlaySvg([
            arrowRow({ endStyle: e, stemStyle: s, doubleEnded: d })
          ]);
          // Must have at least the colored stem line.
          expect(svg.querySelectorAll("line, polygon, circle").length).toBeGreaterThan(0);
        });
      }
    }
  }
});
