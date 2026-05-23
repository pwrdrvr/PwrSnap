// Region-selector geometry tests. These cover the pure math behind
// the Phase 1.10 state machine — drawing, resizing, drag-to-move,
// arrow-key nudge clamping. No DOM, no React; the tests run under
// the `desktop-renderer` jsdom project but never touch window.

import { describe, expect, test } from "vitest";
import {
  ALL_HANDLES,
  applyResize,
  clampRectToViewport,
  DRAG_ENGAGE_PX,
  exceedsDragThreshold,
  isPointInsideRect,
  rectFromTwoPoints,
  rectIsMeaningful,
  type HandleId,
  type Rect
} from "../region-math";

const VIEWPORT = { width: 1920, height: 1080 };

describe("rectFromTwoPoints", () => {
  test("normalizes a top-left to bottom-right drag", () => {
    expect(rectFromTwoPoints({ x: 100, y: 100 }, { x: 300, y: 250 })).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 150
    });
  });

  test("normalizes a bottom-right to top-left drag (positive area)", () => {
    expect(rectFromTwoPoints({ x: 300, y: 250 }, { x: 100, y: 100 })).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 150
    });
  });

  test("zero-area click produces a 0×0 rect at the click point", () => {
    expect(rectFromTwoPoints({ x: 50, y: 50 }, { x: 50, y: 50 })).toEqual({
      x: 50,
      y: 50,
      w: 0,
      h: 0
    });
  });

  test("handles negative coords (off-screen drag past origin)", () => {
    expect(rectFromTwoPoints({ x: -10, y: -10 }, { x: 10, y: 10 })).toEqual({
      x: -10,
      y: -10,
      w: 20,
      h: 20
    });
  });
});

describe("applyResize — corner handles", () => {
  const start: Rect = { x: 100, y: 100, w: 200, h: 150 };

  test("top-left handle drag moves the top-left corner only", () => {
    expect(applyResize(start, "tl", 10, 20)).toEqual({
      x: 110,
      y: 120,
      w: 190,
      h: 130
    });
  });

  test("bottom-right handle drag extends w/h only", () => {
    expect(applyResize(start, "br", 25, 30)).toEqual({
      x: 100,
      y: 100,
      w: 225,
      h: 180
    });
  });

  test("top-right handle drag adjusts y + w + h independently", () => {
    expect(applyResize(start, "tr", 10, -20)).toEqual({
      x: 100,
      y: 80,
      w: 210,
      h: 170
    });
  });

  test("bottom-left handle drag adjusts x + w + h", () => {
    expect(applyResize(start, "bl", -10, 30)).toEqual({
      x: 90,
      y: 100,
      w: 210,
      h: 180
    });
  });
});

describe("applyResize — edge handles", () => {
  const start: Rect = { x: 100, y: 100, w: 200, h: 150 };

  test("top edge handle adjusts y + h only", () => {
    expect(applyResize(start, "tm", 999, -20)).toEqual({
      x: 100,
      y: 80,
      w: 200,
      h: 170
    });
  });

  test("bottom edge handle adjusts h only", () => {
    expect(applyResize(start, "bm", -999, 30)).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 180
    });
  });

  test("left edge handle adjusts x + w only", () => {
    expect(applyResize(start, "lm", -10, 999)).toEqual({
      x: 90,
      y: 100,
      w: 210,
      h: 150
    });
  });

  test("right edge handle adjusts w only", () => {
    expect(applyResize(start, "rm", 25, -999)).toEqual({
      x: 100,
      y: 100,
      w: 225,
      h: 150
    });
  });
});

describe("applyResize — flipped drags normalize", () => {
  // The plan calls this out specifically: "dragging the top-left handle
  // past the bottom-right keeps the rect positive-area." Pin it.
  const start: Rect = { x: 100, y: 100, w: 100, h: 100 }; // 100..200 × 100..200

  test("dragging tl past br produces a positive rect on the far side", () => {
    // Drag top-left handle by (+150, +150) → left/top become 250/250,
    // already past right/bottom (200/200). Normalize.
    const result = applyResize(start, "tl", 150, 150);
    expect(result.w).toBeGreaterThan(0);
    expect(result.h).toBeGreaterThan(0);
    expect(result).toEqual({ x: 200, y: 200, w: 50, h: 50 });
  });

  test("dragging br past tl produces a positive rect on the near side", () => {
    const result = applyResize(start, "br", -150, -150);
    expect(result).toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  test("dragging right edge past left collapses correctly", () => {
    const result = applyResize(start, "rm", -150, 0);
    expect(result.w).toBeGreaterThan(0);
    expect(result).toEqual({ x: 50, y: 100, w: 50, h: 100 });
  });
});

describe("applyResize — every handle is exercised", () => {
  // Cheap completeness check — `applyResize` should produce a positive
  // rect for every named handle, no exceptions.
  const start: Rect = { x: 200, y: 200, w: 100, h: 100 };
  test.each(ALL_HANDLES)("handle %s never produces a negative w/h", (handle) => {
    const result = applyResize(start, handle as HandleId, 5, 5);
    expect(result.w).toBeGreaterThanOrEqual(0);
    expect(result.h).toBeGreaterThanOrEqual(0);
  });
});

describe("clampRectToViewport", () => {
  test("a rect well inside the viewport passes through untouched", () => {
    expect(clampRectToViewport({ x: 100, y: 100, w: 200, h: 200 }, VIEWPORT)).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 200
    });
  });

  test("clamps a rect that has slid off the left/top", () => {
    expect(clampRectToViewport({ x: -50, y: -100, w: 300, h: 300 }, VIEWPORT)).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: 300
    });
  });

  test("shrinks w/h when the rect would extend past right/bottom", () => {
    expect(
      clampRectToViewport({ x: 1900, y: 1000, w: 500, h: 500 }, VIEWPORT)
    ).toEqual({
      x: 1900,
      y: 1000,
      w: 20, // 1920 - 1900
      h: 80 // 1080 - 1000
    });
  });

  test("never produces w < 1 or h < 1", () => {
    // Origin clamped past the viewport edge — must still be a usable rect.
    expect(clampRectToViewport({ x: 9999, y: 9999, w: 10, h: 10 }, VIEWPORT)).toEqual({
      x: 1919,
      y: 1079,
      w: 1,
      h: 1
    });
  });

  test("zero-w drag near the edge stays at minimum 1px", () => {
    expect(clampRectToViewport({ x: 50, y: 50, w: 0, h: 0 }, VIEWPORT)).toEqual({
      x: 50,
      y: 50,
      w: 1,
      h: 1
    });
  });
});

describe("exceedsDragThreshold — drag-to-select responsiveness (bug iv)", () => {
  test("a no-move mouseup does not engage drag", () => {
    expect(exceedsDragThreshold(0, 0)).toBe(false);
  });

  test("sub-threshold movement in any direction does NOT engage", () => {
    expect(exceedsDragThreshold(1, 0)).toBe(false);
    expect(exceedsDragThreshold(0, 1)).toBe(false);
    expect(exceedsDragThreshold(2, 2)).toBe(false);
    expect(exceedsDragThreshold(-2, -2)).toBe(false);
  });

  test("threshold-on-the-dot movement DOES engage (>= boundary)", () => {
    // The user described "tiny flicks" as the failure mode — make
    // sure the engage boundary is inclusive, not exclusive.
    expect(exceedsDragThreshold(DRAG_ENGAGE_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(0, DRAG_ENGAGE_PX)).toBe(true);
    expect(exceedsDragThreshold(-DRAG_ENGAGE_PX, 0)).toBe(true);
    expect(exceedsDragThreshold(0, -DRAG_ENGAGE_PX)).toBe(true);
  });

  test("horizontal-only and vertical-only flicks engage equally fast", () => {
    // Regression for the previous Euclidean-distance gate: a 3px
    // horizontal flick had hypot=3 which failed `< 4`, so the user's
    // drag intent was lost. Max-of-axes treats both axes symmetrically.
    expect(exceedsDragThreshold(3, 0)).toBe(true);
    expect(exceedsDragThreshold(0, 3)).toBe(true);
  });

  test("diagonal drag engages at the same axis threshold", () => {
    expect(exceedsDragThreshold(3, 3)).toBe(true);
    expect(exceedsDragThreshold(-3, 3)).toBe(true);
    expect(exceedsDragThreshold(3, -3)).toBe(true);
  });

  test("threshold is low enough for fast wrist flicks (<= 3px)", () => {
    // Anti-regression: if someone bumps DRAG_ENGAGE_PX above 3, this
    // pins the responsiveness contract. The whole point of bug iv
    // was that the threshold was too aggressive — bumping it back
    // up reintroduces the bug.
    expect(DRAG_ENGAGE_PX).toBeLessThanOrEqual(3);
  });

  test("large drags obviously engage", () => {
    expect(exceedsDragThreshold(100, 50)).toBe(true);
    expect(exceedsDragThreshold(-200, 300)).toBe(true);
  });
});

describe("rectIsMeaningful — committed rect acceptance (bug iv)", () => {
  test("zero-area rect is not meaningful", () => {
    expect(rectIsMeaningful({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
    expect(rectIsMeaningful({ x: 100, y: 100, w: 0, h: 50 })).toBe(false);
    expect(rectIsMeaningful({ x: 100, y: 100, w: 50, h: 0 })).toBe(false);
  });

  test("a thin horizontal strip is meaningful (e.g. status bar selection)", () => {
    // Regression for bug iv: previously a 200×2 rect failed `h < 4`
    // and got thrown away as a "tiny drag," so the user couldn't
    // grab a thin strip of UI.
    expect(rectIsMeaningful({ x: 0, y: 0, w: 200, h: 1 })).toBe(true);
    expect(rectIsMeaningful({ x: 0, y: 0, w: 200, h: 2 })).toBe(true);
  });

  test("a thin vertical strip is meaningful", () => {
    expect(rectIsMeaningful({ x: 0, y: 0, w: 1, h: 400 })).toBe(true);
    expect(rectIsMeaningful({ x: 0, y: 0, w: 2, h: 400 })).toBe(true);
  });

  test("a small but non-zero square is meaningful", () => {
    // A 3×3 drag is small but the user committed to it. Don't toss it.
    expect(rectIsMeaningful({ x: 0, y: 0, w: 3, h: 3 })).toBe(true);
  });

  test("a typical full-screen rect is meaningful", () => {
    expect(rectIsMeaningful({ x: 0, y: 0, w: 1920, h: 1080 })).toBe(true);
  });
});

describe("isPointInsideRect", () => {
  const rect: Rect = { x: 100, y: 100, w: 200, h: 150 };

  test("interior point is inside", () => {
    expect(isPointInsideRect(rect, 150, 150)).toBe(true);
  });

  test("border pixels count as inside (inclusive bounds)", () => {
    expect(isPointInsideRect(rect, 100, 100)).toBe(true);
    expect(isPointInsideRect(rect, 300, 250)).toBe(true);
    expect(isPointInsideRect(rect, 100, 250)).toBe(true);
    expect(isPointInsideRect(rect, 300, 100)).toBe(true);
  });

  test("just outside is not inside", () => {
    expect(isPointInsideRect(rect, 99, 150)).toBe(false);
    expect(isPointInsideRect(rect, 301, 150)).toBe(false);
    expect(isPointInsideRect(rect, 150, 99)).toBe(false);
    expect(isPointInsideRect(rect, 150, 251)).toBe(false);
  });
});
