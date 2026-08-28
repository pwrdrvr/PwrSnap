// Auto contrast-border spec tests — the decision math + sample-point
// generators the editor's sampler and the renderers share.

import { describe, expect, test } from "vitest";
import {
  decideOutlineAutoColor,
  OUTLINE_AUTO_LUMA_THRESHOLD,
  OUTLINE_AUTO_SAMPLE_COUNT,
  outlineAutoLuma,
  outlineSamplePointsForOverlay,
  outlineSamplePointsForRectPerimeter,
  outlineSamplePointsForSegment,
  outlineStripeDashArray,
  outlineStripeDashArrayForStemDash,
  readOverlayOutline,
  readTextOverlayOutline
} from "../index";

describe("outlineAutoLuma", () => {
  test("BT.601 weights: white=255, black=0, pure green heavier than pure blue", () => {
    expect(outlineAutoLuma(255, 255, 255)).toBeCloseTo(255);
    expect(outlineAutoLuma(0, 0, 0)).toBe(0);
    expect(outlineAutoLuma(0, 255, 0)).toBeGreaterThan(outlineAutoLuma(0, 0, 255));
  });
});

describe("decideOutlineAutoColor", () => {
  test("light background (median above threshold) → black border", () => {
    expect(decideOutlineAutoColor([240, 245, 250])).toBe("black");
  });

  test("dark background → white border", () => {
    expect(decideOutlineAutoColor([10, 20, 30])).toBe("white");
  });

  test("mid-gray stays on the historical white halo (threshold above 128)", () => {
    expect(OUTLINE_AUTO_LUMA_THRESHOLD).toBeGreaterThan(128);
    expect(decideOutlineAutoColor([128, 128, 128])).toBe("white");
  });

  test("median (not mean): one bright outlier can't flip a dark majority", () => {
    const lumas = [10, 12, 14, 16, 255];
    // Mean would be ~61 (still white here), so pin the median property
    // with a case where the mean crosses the threshold but the median
    // doesn't: mostly-dark with several bright outliers.
    const skewed = [20, 22, 24, 255, 255];
    expect(decideOutlineAutoColor(lumas)).toBe("white");
    expect(decideOutlineAutoColor(skewed)).toBe("white");
  });

  test("empty input degrades to white (the legacy halo)", () => {
    expect(decideOutlineAutoColor([])).toBe("white");
  });
});

describe("outlineSamplePointsForSegment", () => {
  test("endpoints included, evenly spaced, default count", () => {
    const pts = outlineSamplePointsForSegment({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(pts).toHaveLength(OUTLINE_AUTO_SAMPLE_COUNT);
    expect(pts[0]).toEqual({ xn: 0, yn: 0 });
    expect(pts[pts.length - 1]).toEqual({ xn: 1, yn: 1 });
    // Every point sits on the diagonal.
    for (const p of pts) expect(p.xn).toBeCloseTo(p.yn);
  });
});

describe("outlineSamplePointsForRectPerimeter", () => {
  const dims = { canvasWidthPx: 1000, canvasHeightPx: 500 };

  test("all points lie exactly on the rect's edges", () => {
    const rect = { x: 0.1, y: 0.2, w: 0.4, h: 0.4 };
    const pts = outlineSamplePointsForRectPerimeter(rect, dims);
    expect(pts).toHaveLength(OUTLINE_AUTO_SAMPLE_COUNT);
    for (const p of pts) {
      const onVertical =
        Math.abs(p.xn - rect.x) < 1e-9 || Math.abs(p.xn - (rect.x + rect.w)) < 1e-9;
      const onHorizontal =
        Math.abs(p.yn - rect.y) < 1e-9 || Math.abs(p.yn - (rect.y + rect.h)) < 1e-9;
      expect(onVertical || onHorizontal).toBe(true);
      expect(p.xn).toBeGreaterThanOrEqual(rect.x - 1e-9);
      expect(p.xn).toBeLessThanOrEqual(rect.x + rect.w + 1e-9);
      expect(p.yn).toBeGreaterThanOrEqual(rect.y - 1e-9);
      expect(p.yn).toBeLessThanOrEqual(rect.y + rect.h + 1e-9);
    }
  });

  test("uniform in PIXEL space: a wide flat rect puts more samples on the long edges", () => {
    // 800px wide × 50px tall — the long edges carry ~89% of the
    // perimeter, so they should carry ~89% of the samples.
    const rect = { x: 0.1, y: 0.4, w: 0.8, h: 0.1 };
    const pts = outlineSamplePointsForRectPerimeter(rect, dims, 100);
    const onHorizontalEdges = pts.filter(
      (p) =>
        Math.abs(p.yn - rect.y) < 1e-9 || Math.abs(p.yn - (rect.y + rect.h)) < 1e-9
    ).length;
    expect(onHorizontalEdges).toBeGreaterThan(80);
  });

  test("degenerate zero-size rect returns the anchor point", () => {
    const pts = outlineSamplePointsForRectPerimeter(
      { x: 0.3, y: 0.3, w: 0, h: 0 },
      dims
    );
    expect(pts).toEqual([{ xn: 0.3, yn: 0.3 }]);
  });
});

describe("outlineSamplePointsForOverlay", () => {
  const dims = { canvasWidthPx: 1000, canvasHeightPx: 500 };

  test("arrow samples along the stem", () => {
    const pts = outlineSamplePointsForOverlay(
      {
        kind: "arrow",
        from: { x: 0.2, y: 0.5 },
        to: { x: 0.8, y: 0.5 },
        color: "auto"
      },
      dims
    );
    expect(pts).not.toBeNull();
    for (const p of pts ?? []) expect(p.yn).toBeCloseTo(0.5);
  });

  test("shape samples the rect perimeter", () => {
    const pts = outlineSamplePointsForOverlay(
      {
        kind: "shape",
        rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        color: "auto"
      },
      dims
    );
    expect(pts).not.toBeNull();
    expect(pts!.length).toBe(OUTLINE_AUTO_SAMPLE_COUNT);
  });

  test("text samples a body-box ring around the anchor", () => {
    const pts = outlineSamplePointsForOverlay(
      {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        body: "hello",
        size: "medium",
        color: "auto",
        sizePx: 40
      },
      dims
    );
    expect(pts).not.toBeNull();
    // Single line: box height = sizePx, centered on the anchor →
    // top = 0.5 − (40/2)/500 = 0.46.
    const minY = Math.min(...pts!.map((p) => p.yn));
    expect(minY).toBeCloseTo(0.5 - 20 / 500, 5);
    // Box starts at the anchor's x (left edge).
    const minX = Math.min(...pts!.map((p) => p.xn));
    expect(minX).toBeCloseTo(0.5, 5);
  });

  test("multi-line text ring centers the FULL block on the anchor", () => {
    // The rendered text (TextHtml + HTML bake) centers the whole
    // multi-line block on the anchor via translateY(-50%); the ring
    // must bracket that block symmetrically, not hang below it
    // (first-line-centered was the old SVG-fallback model).
    const pts = outlineSamplePointsForOverlay(
      {
        kind: "text",
        point: { x: 0.5, y: 0.5 },
        body: "one\ntwo\nthree\nfour",
        size: "medium",
        color: "auto",
        sizePx: 40
      },
      dims
    );
    expect(pts).not.toBeNull();
    const minY = Math.min(...pts!.map((p) => p.yn));
    const maxY = Math.max(...pts!.map((p) => p.yn));
    // Symmetric around the anchor.
    expect((minY + maxY) / 2).toBeCloseTo(0.5, 5);
    // Estimated height = 40 × (4×1.2 − 0.2) = 184px on a 500px canvas.
    expect(maxY - minY).toBeCloseTo(184 / 500, 5);
  });

  test("kinds without an outline return null", () => {
    expect(
      outlineSamplePointsForOverlay(
        { kind: "blur", rect: { x: 0, y: 0, w: 1, h: 1 } },
        dims
      )
    ).toBeNull();
    expect(
      outlineSamplePointsForOverlay(
        { kind: "step", point: { x: 0.5, y: 0.5 }, index: 1 },
        dims
      )
    ).toBeNull();
  });
});

describe("readOverlayOutline", () => {
  test("missing field resolves to legacy", () => {
    expect(readOverlayOutline({}, "white")).toEqual({ kind: "legacy" });
  });

  test("explicit modes resolve directly", () => {
    expect(readOverlayOutline({ outline: "none" }, "white")).toEqual({ kind: "none" });
    expect(readOverlayOutline({ outline: "white" }, "black")).toEqual({
      kind: "solid",
      color: "white"
    });
    expect(readOverlayOutline({ outline: "black" }, "white")).toEqual({
      kind: "solid",
      color: "black"
    });
    expect(readOverlayOutline({ outline: "stripe" }, "white")).toEqual({
      kind: "stripe"
    });
  });

  test("auto uses the stored pick, falling back to the caller's default", () => {
    expect(
      readOverlayOutline({ outline: "auto", outlineAuto: "black" }, "white")
    ).toEqual({ kind: "solid", color: "black" });
    expect(readOverlayOutline({ outline: "auto" }, "white")).toEqual({
      kind: "solid",
      color: "white"
    });
    expect(readOverlayOutline({ outline: "auto" }, "black")).toEqual({
      kind: "solid",
      color: "black"
    });
  });
});

describe("readTextOverlayOutline", () => {
  test("black auto fallback + stripe coerced to solid black", () => {
    expect(readTextOverlayOutline({ outline: "auto" })).toEqual({
      kind: "solid",
      color: "black"
    });
    expect(readTextOverlayOutline({ outline: "stripe" })).toEqual({
      kind: "solid",
      color: "black"
    });
    expect(readTextOverlayOutline({})).toEqual({ kind: "legacy" });
  });
});

describe("stripe dash helpers", () => {
  test("outlineStripeDashArray scales with halo width, floored at 4", () => {
    expect(outlineStripeDashArray(1)).toBe("4 4");
    expect(outlineStripeDashArray(10)).toBe("17.5 17.5");
  });

  test("dash-like stems (D >= G) split each dash in half, no offset", () => {
    // Stem pattern "20 10": black covers the first 10px of every
    // 20px dash, then holes through the back half + the 10px gap.
    expect(outlineStripeDashArrayForStemDash("20 10")).toEqual({
      dasharray: "10 20",
      dashoffset: 0
    });
  });

  test("dot-like stems (D < G) alternate WHOLE dots via a dashoffset", () => {
    // Dotted stems have near-zero dashes; a half-dash black twin would
    // render as a round-cap disc exactly covering the white dot. The
    // alternate-dot pattern doubles the cycle and offsets the black
    // dash onto every second dot: dasharray "D (2C−D)" with
    // dashoffset C paints dots 1, 3, 5… black and leaves 0, 2, 4…
    // white.
    expect(outlineStripeDashArrayForStemDash("0.06 10.8")).toEqual({
      dasharray: `0.06 ${2 * (0.06 + 10.8) - 0.06}`,
      dashoffset: 0.06 + 10.8
    });
  });

  test("unparseable stem dash returns null (caller skips the black pass)", () => {
    expect(outlineStripeDashArrayForStemDash("")).toBeNull();
    expect(outlineStripeDashArrayForStemDash("abc def")).toBeNull();
    expect(outlineStripeDashArrayForStemDash("1 2 3")).toBeNull();
    expect(outlineStripeDashArrayForStemDash("0 5")).toBeNull();
  });
});
