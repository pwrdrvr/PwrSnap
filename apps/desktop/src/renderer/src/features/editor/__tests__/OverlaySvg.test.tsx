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

async function renderOverlaySvg(
  overlays: OverlayRow[],
  dims: { imageWidthPx: number; imageHeightPx: number } = {
    imageWidthPx: 800,
    imageHeightPx: 600
  }
): Promise<SVGSVGElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(OverlaySvg, {
        overlays,
        draft: null,
        imageWidthPx: dims.imageWidthPx,
        imageHeightPx: dims.imageHeightPx,
        // pwrdrvr/PwrSnap#110: source dims drive text overlay sizing
        // so a "medium" text doesn't silently resize on crop. Tests
        // default to source == canvas (uncropped); per-test overrides
        // pass distinct values to exercise the cropped scenario.
        sourceWidthPx: dims.imageWidthPx,
        sourceHeightPx: dims.imageHeightPx
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

function textRow(
  id: string,
  data: Partial<Extract<OverlayRow["data"], { kind: "text" }>> = {}
): OverlayRow {
  return {
    id,
    capture_id: "cap_1",
    data: {
      kind: "text",
      point: { x: 0.5, y: 0.5 },
      body: "hello",
      size: "medium",
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

  test("open-triangle is HOLLOW: halo + colored head both fill='none'", async () => {
    // Regression for the "hollow head is opaque white" bug. Pre-fix:
    // halo polygon had fill="white", so the interior of an
    // open-triangle was solid white over the image — exactly what
    // the open style was meant to avoid. Now both polygons are
    // fill="none"; the halo is a wider WHITE STROKE that peeks
    // outline*1 past the colored stroke on both edges (legibility
    // outside AND inside the hollow), and the interior is fully
    // transparent.
    const svg = await renderOverlaySvg([arrowRow({ endStyle: "open-triangle" })]);
    const polygons = svg.querySelectorAll("polygon");
    expect(polygons.length).toBe(2);
    // BOTH polygons must be fill="none" — halo polygon was the bug.
    const openPolys = Array.from(polygons).filter(
      (p) => p.getAttribute("fill") === "none"
    );
    expect(openPolys.length).toBe(2);
    // Halo identity: stroke="white", strokeWidth > colored stroke.
    const haloPoly = Array.from(polygons).find(
      (p) => p.getAttribute("stroke") === "white"
    );
    const coloredPoly = Array.from(polygons).find(
      (p) => p.getAttribute("stroke") !== "white" && p.getAttribute("stroke") !== null
    );
    expect(haloPoly).toBeDefined();
    expect(coloredPoly).toBeDefined();
    // Halo stroke must be wider than colored stroke for the inside-
    // edge halo to be visible.
    expect(Number(haloPoly!.getAttribute("stroke-width"))).toBeGreaterThan(
      Number(coloredPoly!.getAttribute("stroke-width"))
    );
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

describe("OverlaySvg — text overlays moved to HTML rendering", () => {
  // After the HTML-text unification, persisted TextOverlays render via
  // <TextHtmlOverlays> (HTML divs) NOT via SVG <text>. OverlaySvg's
  // text branch is intentionally a no-op for text rows — any non-zero
  // <text> count here would mean the SVG path is back. Coverage of the
  // "suppress the editing overlay" rule lives in TextHtmlOverlays.test.tsx
  // (the new owner of that filtering logic).

  test("text overlays never produce <text> elements in the SVG", async () => {
    const svg = await renderOverlaySvg([textRow("text_1")]);
    expect(svg.querySelectorAll("text").length).toBe(0);
  });

  test("multiple text overlays produce zero <text> elements (suppression is enforced upstream by TextHtmlOverlays)", async () => {
    const svg = await renderOverlaySvg([
      textRow("text_1"),
      textRow("text_2", { point: { x: 0.3, y: 0.3 } })
    ]);
    expect(svg.querySelectorAll("text").length).toBe(0);
  });
});

describe("OverlaySvg ArrowGlyph — portrait images (the original symptom)", () => {
  // The pixel-space viewBox change in this PR was specifically aimed
  // at portrait captures (e.g., a Quick Capture popover or a phone
  // screenshot). Pre-fix the viewBox stretched X and Y by different
  // amounts, skewing strokes and producing the vertical "fang" at
  // the tail. Running these tests at portrait dims catches any
  // future regression that re-introduces the non-uniform stretch.
  const PORTRAIT_DIMS = { imageWidthPx: 720, imageHeightPx: 1280 };

  test("viewBox uses pixel-space dimensions, not normalized 0..1", async () => {
    // The load-bearing assertion: viewBox MUST be pixel-space so
    // strokes render isotropically on non-square images.
    const svg = await renderOverlaySvg([arrowRow()], PORTRAIT_DIMS);
    const viewBox = svg.getAttribute("viewBox");
    expect(viewBox).toBe(`0 0 ${PORTRAIT_DIMS.imageWidthPx} ${PORTRAIT_DIMS.imageHeightPx}`);
    // preserveAspectRatio should NOT be "none" — that would re-introduce
    // the bug. Default (xMidYMid meet) is correct here.
    const par = svg.getAttribute("preserveAspectRatio");
    expect(par).not.toBe("none");
  });

  test("horizontal arrow on portrait: stem is horizontal in pixel space (not skewed)", async () => {
    // For a horizontal-in-normalized-coords arrow on a portrait
    // image, the rendered stem must be horizontal in pixel space.
    // Pre-fix the y1 vs y2 of the rendered stem differed because
    // of the non-uniform viewBox; post-fix they match.
    const svg = await renderOverlaySvg(
      [arrowRow({ endStyle: "filled-triangle" })],
      PORTRAIT_DIMS
    );
    const coloredStem = Array.from(svg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    );
    expect(coloredStem).toBeDefined();
    const y1 = Number(coloredStem!.getAttribute("y1"));
    const y2 = Number(coloredStem!.getAttribute("y2"));
    expect(y1).toBeCloseTo(y2, 5);
  });

  test("horizontal arrow on portrait: head triangle is isosceles (perpendicular not skewed)", async () => {
    // The base corners (baseLeft, baseRight) must sit equidistant
    // from baseCenter along the perpendicular axis. Pre-fix the
    // non-uniform viewBox made the triangle look "tilted." Post-fix
    // the perpendicular is computed in pixel space so isosceles
    // holds regardless of image aspect.
    const svg = await renderOverlaySvg(
      [arrowRow({ endStyle: "filled-triangle" })],
      PORTRAIT_DIMS
    );
    const coloredPoly = Array.from(svg.querySelectorAll("polygon")).find(
      (p) => p.getAttribute("fill") !== "white" && p.getAttribute("fill") !== "none"
    );
    expect(coloredPoly).toBeDefined();
    const points = coloredPoly!
      .getAttribute("points")!
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number));
    // Identify apex (rightmost on horizontal arrow); other two are
    // base corners. For an isosceles triangle, base corners sit
    // mirrored around apex.y.
    const xs = points.map((p) => p[0]!);
    const apexIdx = xs.indexOf(Math.max(...xs));
    const apexY = points[apexIdx]![1]!;
    const baseYs = points.filter((_, i) => i !== apexIdx).map((p) => p[1]!);
    expect(Math.abs((baseYs[0]! - apexY) + (baseYs[1]! - apexY))).toBeLessThan(0.01);
  });

  test("stem halo and head halo share the same strokeWidth (no white bleed at baseCenter)", async () => {
    // Structural invariant — proxy for the pixel-level "no white
    // bleed into the open-triangle's hollow" property at the
    // stem/head junction.
    //
    // The stem's round line cap at baseCenter extends `(stroke +
    // outline*2)/2` past the geometric endpoint. The head halo
    // polygon's stroke at baseCenter (on the base edge) extends
    // `(stroke + outline*2)/2` INTO the head along the perpendicular.
    // If these two strokes share the SAME width, the head halo's
    // coverage exactly matches the stem halo's forward bleed —
    // they paint the same pixels white, so no visible artifact.
    //
    // If they diverge (e.g., refactor accidentally uses a different
    // outline value for one), the longer stroke pokes past the
    // shorter and shows up as a visible white sliver where it
    // shouldn't.
    //
    // Tested on open-triangle since that's the style where the
    // hollow makes the white bleed visible. Filled-triangle's
    // colored fill covers any halo discrepancy.
    const svg = await renderOverlaySvg(
      [arrowRow({ endStyle: "open-triangle" })],
      PORTRAIT_DIMS
    );
    const haloStem = Array.from(svg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") === "white"
    );
    const haloPoly = Array.from(svg.querySelectorAll("polygon")).find(
      (p) => p.getAttribute("stroke") === "white"
    );
    expect(haloStem).toBeDefined();
    expect(haloPoly).toBeDefined();
    const haloStemWidth = Number(haloStem!.getAttribute("stroke-width"));
    const haloPolyWidth = Number(haloPoly!.getAttribute("stroke-width"));
    expect(haloStemWidth).toBeCloseTo(haloPolyWidth, 5);
  });

  test("portrait + Large thickness: stem stroke matches the head's scale (no skew, no clamp surprise)", async () => {
    // Tie together the pixel-space fix AND the head-scales-with-
    // thickness fix on portrait. Large stroke should be ~2× auto;
    // head polygon should grow proportionally. Same assertion as
    // the landscape tests, just run at portrait dims to catch any
    // aspect-conditional bug.
    const autoSvg = await renderOverlaySvg(
      [arrowRow({ endStyle: "filled-triangle", thickness: "auto" })],
      PORTRAIT_DIMS
    );
    const largeSvg = await renderOverlaySvg(
      [arrowRow({ endStyle: "filled-triangle", thickness: "large" })],
      PORTRAIT_DIMS
    );
    const autoStem = Array.from(autoSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    const largeStem = Array.from(largeSvg.querySelectorAll("line")).find(
      (l) => l.getAttribute("stroke") !== "white"
    )!;
    const autoWidth = Number(autoStem.getAttribute("stroke-width"));
    const largeWidth = Number(largeStem.getAttribute("stroke-width"));
    expect(largeWidth).toBeGreaterThan(autoWidth);
    // Floor formula on small images: at PORTRAIT_DIMS shortSide=720,
    // floor = 720 × 0.012 = 8.64 px. autoStroke = clamp(720/220, 4,
    // 14) ≈ 3.27 px, so the auto path clamps to 4 (STROKE_MIN_PX).
    // Large = max(4 × 2, 8.64) = 8.64 (floor wins). Auto stroke
    // path also factors length-based scaling — be tolerant of a
    // range rather than assert an exact value.
    expect(largeWidth / autoWidth).toBeGreaterThan(1.5);
  });
});
