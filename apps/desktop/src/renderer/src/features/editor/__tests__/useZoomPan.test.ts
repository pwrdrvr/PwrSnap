// Pure-function coverage for the pan visibility clamp. The hook wires
// clampPan into every pan-writing path (wheel pan, drag pan,
// cursor-anchored zoom, wrap resize); the invariant under test is that
// at least MIN_VISIBLE_PX of the canvas remains inside the wrap's
// content area on each axis, so the image can never be scrolled fully
// off-screen. Canvas top-left in wrap-content coords is
// `(wrap - canvas) / 2 + pan` (flex centering + translate).

import { describe, expect, test } from "vitest";

import { MIN_VISIBLE_PX, clampPan } from "../useZoomPan";

const topLeft = (wrap: number, canvas: number, pan: number): number =>
  (wrap - canvas) / 2 + pan;

describe("clampPan", () => {
  test("leaves an in-bounds pan untouched", () => {
    const result = clampPan({
      panX: 10,
      panY: -20,
      wrapW: 800,
      wrapH: 600,
      canvasW: 400,
      canvasH: 300
    });
    expect(result).toEqual({ panX: 10, panY: -20 });
  });

  test("clamps a huge positive pan so MIN_VISIBLE_PX stays visible on the left/top", () => {
    const wrapW = 800;
    const wrapH = 600;
    const canvasW = 400;
    const canvasH = 300;
    const result = clampPan({ panX: 5000, panY: 5000, wrapW, wrapH, canvasW, canvasH });
    // Canvas left edge sits at wrapW - MIN_VISIBLE_PX: only the first
    // MIN_VISIBLE_PX columns of the canvas remain inside the wrap.
    expect(topLeft(wrapW, canvasW, result.panX)).toBeCloseTo(wrapW - MIN_VISIBLE_PX);
    expect(topLeft(wrapH, canvasH, result.panY)).toBeCloseTo(wrapH - MIN_VISIBLE_PX);
  });

  test("clamps a huge negative pan so MIN_VISIBLE_PX stays visible on the right/bottom", () => {
    const wrapW = 800;
    const wrapH = 600;
    const canvasW = 400;
    const canvasH = 300;
    const result = clampPan({ panX: -5000, panY: -5000, wrapW, wrapH, canvasW, canvasH });
    // Canvas right edge sits at MIN_VISIBLE_PX from the wrap's left.
    expect(topLeft(wrapW, canvasW, result.panX) + canvasW).toBeCloseTo(MIN_VISIBLE_PX);
    expect(topLeft(wrapH, canvasH, result.panY) + canvasH).toBeCloseTo(MIN_VISIBLE_PX);
  });

  test("zoomed-in canvas (larger than wrap) still keeps a sliver visible", () => {
    const wrapW = 800;
    const wrapH = 600;
    const canvasW = 3200;
    const canvasH = 2400;
    const far = clampPan({ panX: 100000, panY: -100000, wrapW, wrapH, canvasW, canvasH });
    expect(topLeft(wrapW, canvasW, far.panX)).toBeCloseTo(wrapW - MIN_VISIBLE_PX);
    expect(topLeft(wrapH, canvasH, far.panY) + canvasH).toBeCloseTo(MIN_VISIBLE_PX);
    // And a legitimate mid-range pan of the zoomed canvas is untouched.
    const mid = clampPan({ panX: 500, panY: -500, wrapW, wrapH, canvasW, canvasH });
    expect(mid).toEqual({ panX: 500, panY: -500 });
  });

  test("canvas smaller than MIN_VISIBLE_PX must stay fully inside the wrap", () => {
    const wrapW = 800;
    const wrapH = 600;
    const canvasW = 40;
    const canvasH = 30;
    const result = clampPan({ panX: 5000, panY: -5000, wrapW, wrapH, canvasW, canvasH });
    // minVis collapses to the canvas extent: the whole canvas is the
    // minimum visible region, so its edges pin to the wrap edges.
    expect(topLeft(wrapW, canvasW, result.panX)).toBeCloseTo(wrapW - canvasW);
    expect(topLeft(wrapH, canvasH, result.panY)).toBeCloseTo(0);
  });

  test("wrap smaller than MIN_VISIBLE_PX caps the requirement at the wrap extent", () => {
    const wrapW = 48;
    const wrapH = 32;
    const canvasW = 400;
    const canvasH = 300;
    const result = clampPan({ panX: 5000, panY: 5000, wrapW, wrapH, canvasW, canvasH });
    // The canvas can retreat until it covers the whole (tiny) wrap,
    // but no further: its left edge stops at wrap-left.
    expect(topLeft(wrapW, canvasW, result.panX)).toBeCloseTo(0);
    expect(topLeft(wrapH, canvasH, result.panY)).toBeCloseTo(0);
  });

  test("degenerate dimensions pass the pan through unchanged", () => {
    expect(
      clampPan({ panX: 123, panY: -456, wrapW: 0, wrapH: 600, canvasW: 400, canvasH: 300 })
    ).toEqual({ panX: 123, panY: -456 });
    expect(
      clampPan({ panX: 123, panY: -456, wrapW: 800, wrapH: 600, canvasW: 0, canvasH: 300 })
    ).toEqual({ panX: 123, panY: -456 });
  });
});
