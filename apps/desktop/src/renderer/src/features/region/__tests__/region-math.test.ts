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
  occludedFrame,
  rectFromTwoPoints,
  rectIsMeaningful,
  subtractRects,
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

/** Total area of a set of rects — equal to the covered area only when
 *  they are disjoint, which is what `subtractRects` promises. */
function area(rects: readonly Rect[]): number {
  return rects.reduce((sum, r) => sum + r.w * r.h, 0);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("subtractRects", () => {
  const base: Rect = { x: 100, y: 100, w: 400, h: 300 };

  test("a cutter that misses, or only touches an edge, cuts nothing", () => {
    expect(subtractRects(base, [{ x: 600, y: 100, w: 50, h: 50 }])).toEqual([base]);
    expect(subtractRects(base, [{ x: 500, y: 100, w: 50, h: 50 }])).toEqual([base]);
  });

  test("a covering cutter leaves nothing", () => {
    expect(subtractRects(base, [{ x: 0, y: 0, w: 1000, h: 1000 }])).toEqual([]);
  });

  test("a hole in the middle leaves four disjoint bands around it", () => {
    const pieces = subtractRects(base, [{ x: 200, y: 200, w: 100, h: 100 }]);
    expect(pieces).toHaveLength(4);
    expect(area(pieces)).toBe(400 * 300 - 100 * 100);
  });

  test("overlapping cutters are subtracted as a union, not twice", () => {
    // Two cutters overlapping each other inside `base`. An even-odd or
    // winding-cancel approach would bring their intersection back.
    const a: Rect = { x: 150, y: 150, w: 200, h: 100 };
    const b: Rect = { x: 250, y: 200, w: 200, h: 150 };
    const pieces = subtractRects(base, [a, b]);
    const unionArea = 200 * 100 + 200 * 150 - 100 * 50;
    expect(area(pieces)).toBe(400 * 300 - unionArea);
    for (const p of pieces) {
      expect(overlaps(p, a)).toBe(false);
      expect(overlaps(p, b)).toBe(false);
    }
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        expect(overlaps(pieces[i]!, pieces[j]!)).toBe(false);
      }
    }
  });
});

describe("occludedFrame", () => {
  const base: Rect = { x: 100, y: 100, w: 400, h: 300 };

  test("nothing in front: no clip, badge at the frame's own corner", () => {
    const whole = { hidden: false, clipPath: null, badge: { x: 0, y: 0 } };
    expect(occludedFrame(base, [])).toEqual(whole);
    expect(occludedFrame(base, [{ x: 700, y: 0, w: 10, h: 10 }])).toEqual(whole);
  });

  test("fully covered: the frame is hidden and carries no clip path", () => {
    expect(occludedFrame(base, [{ x: 50, y: 50, w: 500, h: 400 }])).toEqual({
      hidden: true,
      clipPath: null,
      badge: { x: 0, y: 0 }
    });
  });

  test("windows sharing an edge do not clip each other through float noise", () => {
    // The renderer scales rects by innerWidth / displayBounds.width. At
    // 1024/1348, 1*s + 22*s exceeds 23*s by ~3.6e-15 — a window ending
    // at x=23 "overlaps" its neighbour starting there.
    const s = 1024 / 1348;
    const front: Rect = { x: 1 * s, y: 0, w: 22 * s, h: 100 * s };
    const back: Rect = { x: 23 * s, y: 0, w: 50 * s, h: 100 * s };
    expect(front.x + front.w).toBeGreaterThan(back.x);
    expect(occludedFrame(back, [front])).toEqual({
      hidden: false,
      clipPath: null,
      badge: { x: 0, y: 0 }
    });
  });

  test("the clip path is in the frame's own coordinates", () => {
    // Front window covers the bottom-right quarter and past it.
    const { clipPath, badge } = occludedFrame(base, [{ x: 300, y: 250, w: 400, h: 400 }]);
    expect(badge).toEqual({ x: 0, y: 0 });
    // Top band (full width, down to the cut) + left band beside the cut.
    expect(clipPath).toBe('path("M0 0h400v150h-400ZM0 150h200v150h-200Z")');
  });

  test("a covered top-left corner moves the badge to the highest visible piece", () => {
    // Front window covers the top-left corner: the frame keeps an L —
    // a right band starting at the top edge, and a bottom band.
    const { badge } = occludedFrame(base, [{ x: 0, y: 0, w: 250, h: 200 }]);
    expect(badge).toEqual({ x: 150, y: 0 });
    // Rounded like the path: 50.3 - 0.1 is 50.199999999999996.
    const { badge: scaled } = occludedFrame(
      { x: 0.1, y: 0.2, w: 100, h: 100 },
      [{ x: 0, y: 0, w: 50.3, h: 50 }]
    );
    expect(scaled).toEqual({ x: 50.2, y: 0 });
  });

  test("fractional CSS px (scaled displays) are rounded, not printed raw", () => {
    const { clipPath } = occludedFrame(
      { x: 0.1, y: 0.2, w: 100, h: 100 },
      [{ x: 50.3, y: 0, w: 100, h: 100 }]
    );
    // 50.3 - 0.1 is 50.199999999999996 in floating point.
    expect(clipPath).toBe('path("M0 99.8h100v0.2h-100ZM0 0h50.2v99.8h-50.2Z")');
  });
});
