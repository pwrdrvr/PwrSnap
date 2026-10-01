// Where an arrow's label opens, and what it looks like. The label must
// start beyond the TAIL on the side away from the head, grow away from
// the stem while typed, and stay on the canvas.

import { describe, expect, test } from "vitest";
import {
  labelLeftAnchorXn,
  labelSizeForArrowThickness,
  labelStyleForArrow,
  planArrowLabel
} from "../arrow-label";

const W = 1000;
const H = 500;
const FONT = 20; // canvas px → gap 10, half-height 12, estimated width 60

function plan(from: [number, number], to: [number, number]) {
  const p = planArrowLabel({
    from: { x: from[0] / W, y: from[1] / H },
    to: { x: to[0] / W, y: to[1] / H },
    canvasWidthPx: W,
    canvasHeightPx: H,
    fontPx: FONT
  });
  // Back to canvas px so the expectations read as geometry.
  return { x: p.xn * W, y: p.yn * H, align: p.align };
}

describe("planArrowLabel", () => {
  test("arrow pointing right: label ends just left of the tail, centered on it", () => {
    expect(plan([400, 250], [600, 250])).toEqual({ x: 390, y: 250, align: "end" });
  });

  test("arrow pointing left: label starts just right of the tail", () => {
    expect(plan([600, 250], [400, 250])).toEqual({ x: 610, y: 250, align: "start" });
  });

  test("arrow pointing up: label centered below the tail", () => {
    expect(plan([500, 300], [500, 100])).toEqual({ x: 500, y: 322, align: "center" });
  });

  test("arrow pointing down: label centered above the tail", () => {
    expect(plan([500, 200], [500, 400])).toEqual({ x: 500, y: 178, align: "center" });
  });

  test("a 45° arrow counts as horizontal: beside the tail, away from the head", () => {
    expect(plan([400, 200], [500, 300]).align).toBe("end");
    expect(plan([500, 200], [400, 300]).align).toBe("start");
  });

  test("no room beside the tail: moves above or below it instead of off the canvas", () => {
    // Pointing right from x=30 — an end-aligned label would need 60px
    // to the left. Pointing down, so above is "away".
    expect(plan([30, 200], [300, 260])).toEqual({ x: 30, y: 178, align: "center" });
  });

  test("nothing fits (tail in a corner): keeps its side, slid onto the canvas", () => {
    const p = plan([5, 5], [200, 6]);
    expect(p.align).toBe("end");
    // The 60px-wide box ending at the anchor must start at x >= 0, and
    // the 24px-tall box must start at y >= 0.
    expect(p.x - 60).toBeGreaterThanOrEqual(0);
    expect(p.y - 12).toBeGreaterThanOrEqual(0);
  });

  test("a degenerate (zero-length) arrow is treated as pointing right", () => {
    expect(plan([400, 250], [400, 250]).align).toBe("end");
  });
});

describe("labelLeftAnchorXn — the persisted left edge", () => {
  test("converts end and center anchors using the measured width", () => {
    expect(labelLeftAnchorXn(0.5, "start", 0.1)).toBeCloseTo(0.5);
    expect(labelLeftAnchorXn(0.5, "end", 0.1)).toBeCloseTo(0.4);
    expect(labelLeftAnchorXn(0.5, "center", 0.1)).toBeCloseTo(0.45);
  });

  test("keeps a label narrower than the canvas on it", () => {
    expect(labelLeftAnchorXn(0.05, "end", 0.2)).toBe(0);
    expect(labelLeftAnchorXn(0.95, "start", 0.2)).toBeCloseTo(0.8);
  });

  test("an unmeasured width (0 / NaN) leaves the anchor where it was drafted", () => {
    expect(labelLeftAnchorXn(0.5, "end", 0)).toBe(0.5);
    expect(labelLeftAnchorXn(0.5, "center", Number.NaN)).toBe(0.5);
  });
});

describe("label style from the arrow", () => {
  test.each([
    ["small", "small"],
    ["medium", "medium"],
    ["large", "large"],
    ["x-large", "x-large"],
    ["auto", "medium"],
    [0.01, "medium"],
    [undefined, "medium"]
  ] as const)("thickness %s → text %s", (thickness, size) => {
    expect(labelSizeForArrowThickness(thickness)).toBe(size);
  });

  test("takes the arrow's color and Border, bold; a stripe Border becomes Auto", () => {
    expect(labelStyleForArrow({ color: "#ff5f57", thickness: "large", outline: "black" })).toEqual({
      color: "#ff5f57",
      size: "large",
      weight: "bold",
      outline: "black"
    });
    expect(labelStyleForArrow({ color: "auto", outline: "stripe" }).outline).toBe("auto");
    expect(labelStyleForArrow({ color: "auto" }).outline).toBe("auto");
  });
});
