// OverlaySvg rendering tests — focused on the ArrowGlyph variants
// added with the arrow style-fields work. Renders the component with
// crafted OverlayRow inputs and asserts on the resulting DOM (no
// pixel comparison — structural assertions are enough to pin each
// endStyle / stemStyle / doubleEnded variant).
//
// Same bare-react createRoot + act harness as CropTool.test.tsx —
// no @testing-library dep so the test stays inside our existing
// minimal stack.

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

import { OverlaySvg, TransformHandles } from "../OverlaySvg";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Returns the test container element — querySelectors against it
 *  find content across ALL editor SVGs (one mini-SVG per persisted
 *  glyph + one chrome SVG for drafts/selection outlines). Tests
 *  that need to isolate the chrome SVG (selection outlines, drafts)
 *  use `[data-testid='chrome-svg']`; tests that need a specific
 *  persisted glyph's SVG use `[data-testid='persisted-glyph-svg']`.
 *  See the "per-glyph mini-SVGs for cross-kind z-order" comment in
 *  OverlaySvg.tsx for the rationale. */
async function renderOverlaySvg(
  overlays: OverlayRow[],
  dims: { imageWidthPx: number; imageHeightPx: number } = {
    imageWidthPx: 800,
    imageHeightPx: 600
  },
  extraProps: Partial<
    Pick<ComponentProps<typeof OverlaySvg>, "draft" | "draftStyle" | "selectedLayerIds">
  > = {}
): Promise<HTMLDivElement> {
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
        sourceHeightPx: dims.imageHeightPx,
        ...extraProps
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  // Sanity check — at least the chrome SVG must always render (the
  // per-glyph mini-SVGs are conditional on having persisted shapes).
  const anySvg = container.querySelector("svg.editor-svg");
  if (anySvg === null) throw new Error("OverlaySvg did not render any svg element");
  return container;
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
    function headPerpExtent(svg: HTMLDivElement): number {
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
  data: Partial<Extract<OverlayRow["data"], { kind: "shape" }>> = {}
): OverlayRow {
  return {
    id: "rect_test_1",
    capture_id: "cap_1",
    data: {
      kind: "shape",
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

/** Second rect with a distinct id so multi-select tests can exercise
 *  two selected rows without id collision. */
function rectRow2(): OverlayRow {
  return {
    id: "rect_test_2",
    capture_id: "cap_1",
    data: {
      kind: "shape",
      rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
      color: "auto"
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

describe("OverlaySvg ShapeGlyph — filled", () => {
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

describe("OverlaySvg HighlightGlyph — opacity", () => {
  test("live highlight draft uses the active highlight opacity", async () => {
    const svg = await renderOverlaySvg([], undefined, {
      draft: {
        kind: "shape-drag",
        tool: "highlight",
        startXn: 0.1,
        startYn: 0.1,
        curXn: 0.4,
        curYn: 0.3
      },
      draftStyle: {
        color: "#22c55e",
        highlightBlend: "multiply",
        highlightOpacity: 0.3
      }
    });
    const chromeSvg = svg.querySelector("[data-testid='chrome-svg']");
    const highlight = chromeSvg?.querySelector("rect");
    expect(highlight).not.toBeNull();
    expect(highlight!.getAttribute("fill")).toBe("#22c55e");
    expect(highlight!.getAttribute("fill-opacity")).toBe("0.3");
    expect((highlight as SVGRectElement).style.mixBlendMode).toBe("");
  });

  test("live highlight draft clamps stale opaque opacity to marker range", async () => {
    const svg = await renderOverlaySvg([], undefined, {
      draft: {
        kind: "shape-drag",
        tool: "highlight",
        startXn: 0.1,
        startYn: 0.1,
        curXn: 0.4,
        curYn: 0.3
      },
      draftStyle: {
        color: "#22c55e",
        highlightBlend: "multiply",
        highlightOpacity: 1
      }
    });
    const chromeSvg = svg.querySelector("[data-testid='chrome-svg']");
    const highlight = chromeSvg?.querySelector("rect");
    expect(highlight).not.toBeNull();
    expect(highlight!.getAttribute("fill-opacity")).toBe("0.6");
  });
});

describe("OverlaySvg ShapeGlyph — thickness", () => {
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

describe("OverlaySvg — multi-select outlines", () => {
  // Selection outline used to render at most one box (when
  // selectedLayerId !== null). The multi-select migration renders one
  // box per id in `selectedLayerIds`. Tests assert that count tracks
  // the array length and that missing ids are silently skipped (the
  // parent's stale-id cleanup runs on the next render).

  test("renders no selection outline when selectedLayerIds is empty", async () => {
    const svg = await renderOverlaySvg([rectRow()], undefined, {
      selectedLayerIds: []
    });
    expect(svg.querySelectorAll("[data-testid='selection-outline']").length).toBe(0);
  });

  test("renders one outline per id in selectedLayerIds", async () => {
    // Two rects (text overlays' selection outline is now drawn by
    // TextHtmlOverlays, not OverlaySvg, since the HTML-text
    // unification moved text rendering out of the SVG). Arrows get a
    // different shape of outline (endpoint dots, not a dashed bbox)
    // but both kinds still emit a `[data-testid='selection-outline']`
    // root so this count assertion holds across kinds — see the
    // "arrow selection emits endpoint dots" test below for the
    // arrow-specific shape.
    const svg = await renderOverlaySvg(
      [rectRow(), rectRow2()],
      undefined,
      { selectedLayerIds: ["rect_test_1", "rect_test_2"] }
    );
    expect(svg.querySelectorAll("[data-testid='selection-outline']").length).toBe(2);
  });

  test("silently skips ids that don't match any current overlay", async () => {
    const svg = await renderOverlaySvg(
      [rectRow()],
      undefined,
      { selectedLayerIds: ["rect_test_1", "ghost_id_no_overlay"] }
    );
    // One match + one ghost id = exactly one outline. Parent
    // separately handles the stale-id cleanup on the next render.
    expect(svg.querySelectorAll("[data-testid='selection-outline']").length).toBe(1);
  });

  test("arrow selection emits endpoint dots (multi-select affordance)", async () => {
    // Regression for user report: "you can multi-select with Command
    // now but there is no indication of which items are selected as
    // the grippers on the first item disappear and there is no
    // indication that 2 of 100 arrows on the screen are selected".
    //
    // TransformHandles renders only for single-selection, so on
    // multi-select an arrow had ZERO visible feedback — the dashed
    // bbox path was a no-op for arrows because an AABB around a line
    // is the wrong shape. The fix: SelectionOutline for arrows now
    // emits two small accent-colored endpoint dots at `from` and
    // `to`. Stacks cleanly under TransformHandles' larger square
    // handles in the single-select case (dot is decorative; handle
    // is interactive).
    const svg = await renderOverlaySvg([arrowRow()], undefined, {
      selectedLayerIds: ["arrow_test_1"]
    });
    const outline = svg.querySelector(
      "[data-testid='selection-outline'][data-kind='arrow-endpoints']"
    );
    expect(outline).not.toBeNull();
    // 4 circles per endpoint set = 2 endpoints × (halo + fill).
    // This is the bare-minimum-distinguishable count; a future
    // refactor that drops the halo would still leave 2 circles
    // visible to the user but the test would flag the change.
    expect(outline!.querySelectorAll("circle").length).toBe(4);
  });

  test("arrow endpoint dots anchor to from/to in pixel space", async () => {
    // Locks the math so a future refactor that swaps coordinate
    // systems doesn't silently mis-position the dots (which would
    // look like "the indicator drifted off my arrow").
    // Test default canvas is 800×600. arrowRow() returns from
    // (0.2, 0.5) → (0.8, 0.5) — so in pixel space:
    //   from = (160, 300), to = (640, 300)
    const svg = await renderOverlaySvg([arrowRow()], undefined, {
      selectedLayerIds: ["arrow_test_1"]
    });
    const outline = svg.querySelector(
      "[data-testid='selection-outline'][data-kind='arrow-endpoints']"
    );
    const circles = outline!.querySelectorAll("circle");
    // Last two circles are the colored fills (painted after halos).
    const fillFrom = circles[2]!;
    const fillTo = circles[3]!;
    expect(Number(fillFrom.getAttribute("cx"))).toBe(160);
    expect(Number(fillFrom.getAttribute("cy"))).toBe(300);
    expect(Number(fillTo.getAttribute("cx"))).toBe(640);
    expect(Number(fillTo.getAttribute("cy"))).toBe(300);
  });

  test("bounding box bounds the FULL rect even when the rect is dragged off-canvas", async () => {
    // Regression test for "the bounding box is allergic to the canvas
    // edge" — pre-fix, SelectionOutline did Math.max(0, …) +
    // Math.min(1 – xn, …) on the box, which made the dashed outline
    // shrink to only the on-canvas portion when the asset was pushed
    // past the edge. Visually the user reported "the asset changed
    // size" because the bounding box no longer wrapped the visible
    // shape (only its on-canvas portion). The outline must bound the
    // FULL asset wherever it lives — the canvas + svg both run
    // overflow:visible so the off-canvas portion paints.
    //
    // Construct a rect mostly off-canvas: x=0.8, w=0.5 → extends from
    // 0.8 to 1.3 (40% past the right edge). The dashed <rect>'s
    // width attribute should reflect the FULL 0.5 (plus a tiny
    // padding), NOT a clamped 0.2 (which would be `1 - 0.8`).
    const offCanvasRect: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "shape",
        rect: { x: 0.8, y: 0.4, w: 0.5, h: 0.2 },
        color: "auto"
      }
    };
    const svg = await renderOverlaySvg([offCanvasRect], undefined, {
      selectedLayerIds: ["rect_test_1"]
    });
    const outlineGroup = svg.querySelector(
      "[data-testid='selection-outline']"
    );
    expect(outlineGroup).not.toBeNull();
    // The outline group renders two <rect> elements (white halo +
    // colored stroke). They share the same width attribute. Grab the
    // first.
    const outlineRects = outlineGroup!.querySelectorAll("rect");
    expect(outlineRects.length).toBeGreaterThan(0);
    const outlineRect = outlineRects[0]!;
    const outlineW = Number(outlineRect.getAttribute("width"));
    // The visible test canvas is 800×600 (test default dims).
    // Expected width in pixel-space: (rect.w + 2*pad) * canvasW
    //                              = (0.5 + 0.012) * 800
    //                              = 409.6 px
    // Pre-fix (clamped) width would have been: (1 - 0.8 + small pad) *
    // 800 ≈ 160 px. So `> 400` is a generous "did the clamp regress?"
    // assertion that's hard to fail by accident.
    expect(outlineW).toBeGreaterThan(400);
    expect(outlineW).toBeLessThan(420);
    // Same check on the x — the clamp would have pulled it to
    // `Math.max(0, …)` which would be a small positive number; here
    // we expect the unclamped value (0.8 - pad) * 800 ≈ 635.
    const outlineX = Number(outlineRect.getAttribute("x"));
    expect(outlineX).toBeGreaterThan(630);
    expect(outlineX).toBeLessThan(640);
  });

  test("bounding box stays consistent across canvas-edge boundary (dragging off doesn't change its WIDTH)", async () => {
    // Same shape, two positions: ONE that fits entirely on-canvas,
    // and ONE that's been dragged so part of it extends past. The
    // outline's WIDTH attribute must be IDENTICAL — the only thing
    // that changes between the two is the x position. Pre-fix this
    // failed because the clamp made the second outline narrower than
    // the first.
    const onCanvas: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "shape",
        rect: { x: 0.2, y: 0.4, w: 0.5, h: 0.2 },
        color: "auto"
      }
    };
    const partlyOff: OverlayRow = {
      ...rectRow(),
      data: {
        kind: "shape",
        rect: { x: 0.7, y: 0.4, w: 0.5, h: 0.2 },
        color: "auto"
      }
    };
    const svgOn = await renderOverlaySvg([onCanvas], undefined, {
      selectedLayerIds: ["rect_test_1"]
    });
    const svgOff = await renderOverlaySvg([partlyOff], undefined, {
      selectedLayerIds: ["rect_test_1"]
    });
    const widthOn = Number(
      svgOn
        .querySelector("[data-testid='selection-outline'] rect")!
        .getAttribute("width")
    );
    const widthOff = Number(
      svgOff
        .querySelector("[data-testid='selection-outline'] rect")!
        .getAttribute("width")
    );
    // Same source rect width → same outline width regardless of x.
    expect(widthOff).toBeCloseTo(widthOn, 6);
  });
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
    // strokes render isotropically on non-square images. EVERY SVG
    // (per-glyph mini-SVG + chrome SVG) must share this viewBox so
    // glyphs and selection outlines coexist in the same coord space.
    const container = await renderOverlaySvg([arrowRow()], PORTRAIT_DIMS);
    const svgs = Array.from(container.querySelectorAll("svg.editor-svg"));
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) {
      const viewBox = svg.getAttribute("viewBox");
      expect(viewBox).toBe(`0 0 ${PORTRAIT_DIMS.imageWidthPx} ${PORTRAIT_DIMS.imageHeightPx}`);
      // preserveAspectRatio should NOT be "none" — that would re-introduce
      // the bug. Default (xMidYMid meet) is correct here.
      const par = svg.getAttribute("preserveAspectRatio");
      expect(par).not.toBe("none");
    }
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

describe("OverlaySvg — paint order respects z_index across kinds", () => {
  // User repro: "Bring Forward / Bring to Front on a Rect does not
  // bring it above the arrows... ever." Pre-fix, OverlaySvg painted
  // glyphs in fixed KIND BUCKETS: all highlights first, then all
  // rects, then all arrows. So no matter what z_index a rect carried,
  // every arrow always painted on top. Z-order reordering APPEARED
  // to work (the rect's z_index moved in the DB), but the visual
  // outcome was a no-op for cross-kind orderings.
  //
  // The bake (compose.ts + compose-tree.ts) already paints in flat
  // z_index order, so the live preview also DISAGREED with the
  // exported PNG. The fix unifies the SVG to render in array order
  // (overlays arrive z_index-sorted from the projection), bringing
  // live preview and bake into agreement.
  //
  // These tests assert on document order — for two siblings inside
  // the same SVG, later-in-document = painted later = visually on
  // top. We assert via `compareDocumentPosition` so the test
  // doesn't depend on the SVG's internal layout choices (filter
  // wrappers, glyph SVG element type — line vs polygon — etc.).
  function arrowRowAt(id: string, zIndex: number): OverlayRow {
    return {
      id,
      capture_id: "cap_1",
      data: {
        kind: "arrow",
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        color: "auto"
      },
      schema_version: 1,
      created_at: "2026-05-28T00:00:00Z",
      applied_at: "2026-05-28T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      ai_run_id: null,
      source: "user",
      z_index: zIndex
    };
  }
  function rectRowAt(id: string, zIndex: number): OverlayRow {
    return {
      id,
      capture_id: "cap_1",
      data: {
        kind: "shape",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        color: "auto"
      },
      schema_version: 1,
      created_at: "2026-05-28T00:00:00Z",
      applied_at: "2026-05-28T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      ai_run_id: null,
      source: "user",
      z_index: zIndex
    };
  }

  /** Document-order predicate: returns true when `a` comes EARLIER
   *  in the DOM than `b` (= a was rendered first = painted below b
   *  in SVG paint order). Uses `compareDocumentPosition` so the
   *  result is independent of how the test reaches each element. */
  function paintsBefore(a: Element, b: Element): boolean {
    const cmp = a.compareDocumentPosition(b);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4
    return (cmp & 4) !== 0;
  }

  test("rect with HIGHER z_index than arrow paints AFTER the arrow (= visually on top)", async () => {
    // Caller passes overlays in ASCENDING z_index order (matches
    // what the projection produces: ORDER BY z_index ASC). Pre-fix
    // the kind-bucket logic would put the arrow LAST regardless;
    // post-fix the array order wins.
    const svg = await renderOverlaySvg([
      arrowRowAt("arrow_zindex_xa", 1000),
      // Rect has HIGHER z_index — should paint AFTER (= visually
      // on top of) the arrow.
      rectRowAt("recttt_zindex_b", 2000)
    ]);
    // ArrowGlyph uses <line> + <polygon> children; ShapeGlyph uses
    // <rect>. We compare ANY rect element vs ANY line element in
    // the SVG.
    const rectEl = svg.querySelector("rect");
    const arrowEl = svg.querySelector("line");
    expect(rectEl).not.toBeNull();
    expect(arrowEl).not.toBeNull();
    expect(paintsBefore(arrowEl!, rectEl!)).toBe(true);
  });

  test("arrow with HIGHER z_index than rect paints AFTER the rect (= visually on top)", async () => {
    // Symmetric case — the natural "draw rect, then arrow" flow.
    // Arrow has the higher z_index (monotonic-insert) and SHOULD
    // paint on top. This was the only case the pre-fix kind-
    // bucketing accidentally got right (arrows-bucket-last
    // happened to match).
    const svg = await renderOverlaySvg([
      rectRowAt("recttt_zindex_a", 1000),
      arrowRowAt("arrow_zindex_xb", 2000)
    ]);
    const rectEl = svg.querySelector("rect");
    const arrowEl = svg.querySelector("line");
    expect(rectEl).not.toBeNull();
    expect(arrowEl).not.toBeNull();
    expect(paintsBefore(rectEl!, arrowEl!)).toBe(true);
  });

  test("three layers in z_index order render in document order regardless of kind", async () => {
    // Locks the general rule: array order → document order →
    // paint order. Independent of mixing rules between any two
    // adjacent layers' kinds.
    const svg = await renderOverlaySvg([
      arrowRowAt("arrow_zindex_x1", 1000),
      rectRowAt("recttt_zindex_2", 2000),
      arrowRowAt("arrow_zindex_x3", 3000)
    ]);
    const lines = svg.querySelectorAll("line");
    const rectEls = svg.querySelectorAll("rect");
    expect(lines.length).toBeGreaterThan(0);
    expect(rectEls.length).toBeGreaterThan(0);
    // Pick the FIRST line (= first arrow's stem) and the LAST line
    // (= third arrow's stem) — the rect should fall BETWEEN them.
    const firstLine = lines[0]!;
    const lastLine = lines[lines.length - 1]!;
    const rectEl = rectEls[0]!;
    expect(paintsBefore(firstLine, rectEl)).toBe(true);
    expect(paintsBefore(rectEl, lastLine)).toBe(true);
  });
});

describe("OverlaySvg — per-glyph mini-SVG wrappers with CSS z-index", () => {
  // Pre-refactor, OverlaySvg rendered ONE big SVG with all glyphs as
  // siblings inside. SVG document order = paint order within that
  // SVG, but CSS z-index doesn't apply to SVG children — only to
  // SVG elements themselves. That means a glyph inside the SVG
  // couldn't stack against a sibling HTML element (a blur item, a
  // text wrapper) via CSS z-index — they were all in one z-block.
  //
  // To support cross-kind z-order (arrow↔blur, rect↔text, etc.),
  // each persisted SVG glyph now renders in its OWN mini-SVG with
  // CSS z-index = row.z_index. The chrome SVG (drafts + selection
  // outlines) is separate, at a sentinel z-index above all
  // persisted layers.
  //
  // These tests verify the structural change. Cross-kind interaction
  // tests live in the parent (Editor.tsx) layer — here we just check
  // each glyph gets its own positioned SVG with the right z-index.

  function arrowRowAt(id: string, zIndex: number): OverlayRow {
    return {
      id,
      capture_id: "cap_1",
      data: {
        kind: "arrow",
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        color: "auto"
      },
      schema_version: 1,
      created_at: "2026-05-28T00:00:00Z",
      applied_at: "2026-05-28T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      ai_run_id: null,
      source: "user",
      z_index: zIndex
    };
  }
  function rectRowAt(id: string, zIndex: number): OverlayRow {
    return {
      id,
      capture_id: "cap_1",
      data: {
        kind: "shape",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
        color: "auto"
      },
      schema_version: 1,
      created_at: "2026-05-28T00:00:00Z",
      applied_at: "2026-05-28T00:00:00Z",
      rejected_at: null,
      superseded_by: null,
      ai_run_id: null,
      source: "user",
      z_index: zIndex
    };
  }

  test("each persisted glyph renders in its own SVG with CSS z-index = row.z_index", async () => {
    await renderOverlaySvg([
      arrowRowAt("arrow_perglyph_1", 1200),
      rectRowAt("recttt_perglyph_2", 3400),
      arrowRowAt("arrow_perglyph_3", 5600)
    ]);
    // After refactor, each persisted glyph lives in its OWN
    // `<svg>` element. We expect 3 persisted-glyph SVGs plus 1
    // chrome SVG = 4 SVGs total. The persisted ones are tagged
    // with `data-testid="persisted-glyph-svg"` so we can find
    // them without coupling to class names.
    const persistedSvgs = Array.from(
      container!.querySelectorAll<SVGSVGElement>(
        "[data-testid='persisted-glyph-svg']"
      )
    );
    expect(persistedSvgs.length).toBe(3);
    // Each carries its layer's z_index in inline style.
    const zs = persistedSvgs
      .map((s) => Number(s.style.zIndex))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    expect(zs).toEqual([1200, 3400, 5600]);
  });

  test("chrome SVG (drafts + selection outlines) renders at a HIGH sentinel z-index above any layer z_index", async () => {
    // Persisted layer at z_index = 9_000_000 (would-be-absurd but
    // possible after many reorders); chrome must still paint above.
    await renderOverlaySvg(
      [arrowRowAt("arrow_chrome_xx1", 9_000_000)],
      undefined,
      { selectedLayerIds: ["arrow_chrome_xx1"] }
    );
    const chrome = container!.querySelector<SVGSVGElement>(
      "[data-testid='chrome-svg']"
    );
    expect(chrome).not.toBeNull();
    const chromeZ = Number(chrome!.style.zIndex);
    expect(chromeZ).toBeGreaterThan(9_000_000);
  });
});

describe("TransformHandles — body drag rect stroke-reach pad", () => {
  // The transparent body-hit rect that drives drag-to-move grows
  // outward by the shape's stroke reach so a selected shape can be
  // dragged by its visible LINE, not just its interior (mirror of the
  // hit-test pad for selection). The resize/rotate handles still anchor
  // on the un-padded bodyBox. These tests assert the body rect's
  // measured geometry: a square 1000×1000 image keeps px↔normalized 1:1
  // so the expected percentages are easy to reason about — an auto
  // stroke is 8px wide with a 2px halo → outer reach 6px → 0.006
  // normalized → 0.6 percentage points of pad on each side.
  async function renderTransformHandles(
    selectedOverlay: OverlayRow,
    dims = { imageWidthPx: 1000, imageHeightPx: 1000 }
  ): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(TransformHandles, {
          selectedOverlay,
          imageWidthPx: dims.imageWidthPx,
          imageHeightPx: dims.imageHeightPx,
          sourceWidthPx: dims.imageWidthPx,
          sourceHeightPx: dims.imageHeightPx,
          onGeometryChange: () => undefined
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const body = container.querySelector<HTMLElement>(
      "[data-testid='transform-handle-body']"
    );
    if (body === null) throw new Error("body-hit rect did not render");
    return body;
  }

  function shapeRow(
    data: Partial<Extract<OverlayRow["data"], { kind: "shape" }>> = {}
  ): OverlayRow {
    return {
      id: "shape_test_1",
      capture_id: "cap_1",
      data: {
        kind: "shape",
        shape: "rect",
        rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
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

  test("stroked rect: body rect is grown outward by the stroke reach", async () => {
    const body = await renderTransformHandles(shapeRow());
    // bodyBox is (0.2, 0.2, 0.4, 0.4) → 20% / 40%. With 0.6pp of pad on
    // each side the body rect spans 19.4% .. (19.4 + 41.2)%.
    expect(parseFloat(body.style.left)).toBeCloseTo(19.4, 1);
    expect(parseFloat(body.style.top)).toBeCloseTo(19.4, 1);
    expect(parseFloat(body.style.width)).toBeCloseTo(41.2, 1);
    expect(parseFloat(body.style.height)).toBeCloseTo(41.2, 1);
  });

  test("FILLED shape: no stroke line → body rect is the un-padded bbox", async () => {
    const body = await renderTransformHandles(shapeRow({ filled: true }));
    expect(parseFloat(body.style.left)).toBeCloseTo(20, 4);
    expect(parseFloat(body.style.top)).toBeCloseTo(20, 4);
    expect(parseFloat(body.style.width)).toBeCloseTo(40, 4);
    expect(parseFloat(body.style.height)).toBeCloseTo(40, 4);
  });

  test("highlight: filled region → body rect is the un-padded bbox", async () => {
    const highlight: OverlayRow = {
      ...shapeRow(),
      id: "hl_1",
      data: { kind: "highlight", rect: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } }
    };
    const body = await renderTransformHandles(highlight);
    expect(parseFloat(body.style.left)).toBeCloseTo(20, 4);
    expect(parseFloat(body.style.width)).toBeCloseTo(40, 4);
  });
});
