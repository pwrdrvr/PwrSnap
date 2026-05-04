// Tests for the occlusion-aware visible-region math used by the
// region selector. Three layers covered:
//
//   - subtractRect / subtractAll / boundingBox: pure rectangle
//     algebra. Easy to reason about, easy to break.
//   - computeVisibility: walks z-order and produces visible-region
//     bounding boxes. Dropping fully-occluded windows + tightening
//     visible-bounds is what makes the snap UX correct.
//   - pickWindowAt: the hit-test the renderer (conceptually) does
//     when the cursor moves. Locks in the "topmost-at-point wins,
//     blockers return null" contract.

import { describe, expect, test } from "vitest";
import {
  boundingBox,
  computeVisibility,
  largestFragment,
  pickWindowAt,
  pointInRect,
  rectsIntersect,
  subtractAll,
  subtractRect,
  type Rect
} from "../capture/visibility";

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

type W = { id: number; bounds: { x: number; y: number; width: number; height: number } };
const W = (id: number, x: number, y: number, width: number, height: number): W => ({
  id,
  bounds: { x, y, width, height }
});

describe("rectsIntersect", () => {
  test("overlapping rects intersect", () => {
    expect(rectsIntersect(R(0, 0, 100, 100), R(50, 50, 100, 100))).toBe(true);
  });
  test("edge-touching rects do NOT intersect (half-open semantics)", () => {
    // We treat right/bottom edges as exclusive — two rects sharing
    // an edge but no area don't intersect. This matches how
    // subtractRect would treat them (no carving needed).
    expect(rectsIntersect(R(0, 0, 100, 100), R(100, 0, 50, 100))).toBe(false);
  });
  test("disjoint rects don't intersect", () => {
    expect(rectsIntersect(R(0, 0, 50, 50), R(100, 100, 50, 50))).toBe(false);
  });
});

describe("subtractRect", () => {
  test("non-overlapping returns the original rect", () => {
    expect(subtractRect(R(0, 0, 50, 50), R(100, 100, 50, 50))).toEqual([R(0, 0, 50, 50)]);
  });
  test("full cover returns empty", () => {
    expect(subtractRect(R(10, 10, 20, 20), R(0, 0, 100, 100))).toEqual([]);
  });
  test("center cutout produces a 4-rect frame", () => {
    // 100×100 box with a 20×20 cutout in the middle (40,40)→(60,60).
    // Frame: top, bottom, left, right strips.
    const frags = subtractRect(R(0, 0, 100, 100), R(40, 40, 20, 20));
    expect(frags).toHaveLength(4);
    const totalArea = frags.reduce((acc, r) => acc + r.w * r.h, 0);
    expect(totalArea).toBe(100 * 100 - 20 * 20);
  });
  test("top-left corner cut leaves an L-shape (2 rects)", () => {
    const frags = subtractRect(R(0, 0, 100, 100), R(0, 0, 40, 40));
    // bottom strip + right strip in the upper band.
    expect(frags).toHaveLength(2);
    const totalArea = frags.reduce((acc, r) => acc + r.w * r.h, 0);
    expect(totalArea).toBe(100 * 100 - 40 * 40);
  });
  test("right strip cut leaves left rectangle", () => {
    const frags = subtractRect(R(0, 0, 100, 100), R(80, 0, 100, 100));
    expect(frags).toEqual([R(0, 0, 80, 100)]);
  });
});

describe("subtractAll", () => {
  test("collapses to empty when occluders fully cover", () => {
    const result = subtractAll([R(0, 0, 100, 100)], [R(0, 0, 50, 100), R(50, 0, 50, 100)]);
    expect(result).toEqual([]);
  });
  test("multiple occluders chain correctly", () => {
    // Box minus left strip minus top strip = bottom-right rectangle.
    const result = subtractAll([R(0, 0, 100, 100)], [R(0, 0, 30, 100), R(0, 0, 100, 30)]);
    // After subtracting left strip: right rectangle (30, 0, 70, 100).
    // After subtracting top strip from THAT: (30, 30, 70, 70).
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(R(30, 30, 70, 70));
  });
});

describe("largestFragment", () => {
  // Picks the biggest rect by area. Used to tighten the snap rect
  // for L-shape / multi-fragment visible regions: instead of the
  // over-approximating bounding box we draw a single rect over the
  // biggest meaningful piece.
  test("empty returns null", () => {
    expect(largestFragment([])).toBeNull();
  });
  test("single rect returns itself", () => {
    expect(largestFragment([R(10, 20, 30, 40)])).toEqual(R(10, 20, 30, 40));
  });
  test("biggest rect by area wins", () => {
    const small = R(0, 0, 10, 10);
    const big = R(50, 50, 100, 100);
    const medium = R(200, 0, 30, 30);
    expect(largestFragment([small, big, medium])).toEqual(big);
  });
  test("ties resolve to first-seen", () => {
    const a = R(0, 0, 50, 50);
    const b = R(100, 0, 50, 50); // same area
    expect(largestFragment([a, b])).toEqual(a);
    expect(largestFragment([b, a])).toEqual(b);
  });
  test("L-shape fragments resolve to the bigger arm", () => {
    // Bottom strip (5000) vs right strip (2500) — the L from the
    // computeVisibility test above. Tightens the snap rect.
    const bottomStrip = R(0, 50, 100, 50);
    const rightStrip = R(50, 0, 50, 50);
    expect(largestFragment([bottomStrip, rightStrip])).toEqual(bottomStrip);
  });
});

describe("boundingBox", () => {
  test("empty returns null", () => {
    expect(boundingBox([])).toBeNull();
  });
  test("single rect bounding box is itself", () => {
    expect(boundingBox([R(10, 20, 30, 40)])).toEqual(R(10, 20, 30, 40));
  });
  test("multiple rects expand to enclosing rect", () => {
    expect(
      boundingBox([R(0, 0, 10, 10), R(50, 50, 10, 10), R(20, 30, 5, 5)])
    ).toEqual(R(0, 0, 60, 60));
  });
});

describe("computeVisibility", () => {
  test("frontmost window has its full raw bounds visible", () => {
    const front = W(1, 0, 0, 200, 200);
    const back = W(2, 100, 100, 200, 200);
    const v = computeVisibility([front, back]);
    expect(v[0]!.visibleArea).toBe(200 * 200);
    expect(v[0]!.visibleBounds).toEqual(R(0, 0, 200, 200));
  });

  test("partially-covered back window has reduced visible area", () => {
    const front = W(1, 0, 0, 100, 100);
    const back = W(2, 50, 50, 200, 200);
    const v = computeVisibility([front, back]);
    expect(v[1]!.visibleArea).toBe(200 * 200 - 50 * 50); // 4×4 corner of front lands on back
    expect(v[1]!.zIndex).toBe(1);
  });

  test("fully-occluded back window has zero visible area", () => {
    const front = W(1, 0, 0, 1000, 1000);
    const back = W(2, 100, 100, 200, 200);
    const v = computeVisibility([front, back]);
    expect(v[1]!.visibleArea).toBe(0);
  });

  test("L-shaped visible region: visibleBounds is largest fragment, not bounding box", () => {
    // back = (0,0,100,100), front = (0,0,50,50) at top-left.
    // back's visible fragments per subtractRect:
    //   - bottom strip: (0, 50, 100, 50)  area 5000
    //   - right strip in upper band: (50, 0, 50, 50)  area 2500
    // Largest = bottom strip. The OLD behavior used the bounding
    // box (0,0,100,100), which over-approximated by including the
    // occluded top-left corner. NEW behavior tightens to the actual
    // largest visible piece — what the user expects to capture.
    const front = W(1, 0, 0, 50, 50);
    const back = W(2, 0, 0, 100, 100);
    const v = computeVisibility([front, back]);
    expect(v[1]!.visibleBounds).toEqual(R(0, 50, 100, 50));
    expect(v[1]!.visibleArea).toBe(100 * 100 - 50 * 50);
  });

  test("center cutout: visibleBounds is the biggest single fragment, not the frame's bbox", () => {
    // Small front in the middle of a larger back → 4-rect frame:
    //   top strip    (0, 0, 100, 40)   area 4000
    //   bottom strip (0, 60, 100, 40)  area 4000
    //   left middle  (0, 40, 40, 20)   area 800
    //   right middle (60, 40, 40, 20)  area 800
    // Top + bottom tie at 4000; subtractRect emits top first so it
    // wins the largest-fragment selection. Either choice is fine
    // visually — the contract is "tight, fully-visible rect" and
    // both qualify.
    const front = W(1, 40, 40, 20, 20);
    const back = W(2, 0, 0, 100, 100);
    const v = computeVisibility([front, back]);
    expect(v[1]!.visibleArea).toBe(100 * 100 - 20 * 20);
    expect(v[1]!.visibleBounds).toEqual(R(0, 0, 100, 40));
  });
});

describe("pickWindowAt", () => {
  test("returns the topmost window whose raw bounds contain the cursor", () => {
    const front = W(1, 0, 0, 100, 100);
    const back = W(2, 50, 50, 100, 100);
    const result = pickWindowAt([front, back], 70, 70, () => false);
    expect(result?.id).toBe(1);
  });

  test("falls through to a back window when the cursor isn't on the front", () => {
    const front = W(1, 0, 0, 50, 50);
    const back = W(2, 0, 0, 100, 100);
    const result = pickWindowAt([front, back], 75, 75, () => false);
    expect(result?.id).toBe(2);
  });

  test("returns null when no window contains the cursor", () => {
    const front = W(1, 0, 0, 50, 50);
    const result = pickWindowAt([front], 200, 200, () => false);
    expect(result).toBeNull();
  });

  test("returns null when the topmost-at-cursor is a blocker — no fall-through", () => {
    // The bug we're fixing: cursor is visually on the blocker (e.g.
    // PwrSnap library window). Naive filter-and-walk would skip the
    // blocker and report a hidden window underneath. With the
    // blocker callback we return null instead — the cursor isn't
    // visually on a snappable window.
    const ours = W(1, 0, 0, 100, 100);
    const theirs = W(2, 0, 0, 100, 100);
    const result = pickWindowAt([ours, theirs], 50, 50, (w) => w.id === 1);
    expect(result).toBeNull();
  });

  test("blocker only blocks where the cursor is actually on it", () => {
    const ours = W(1, 0, 0, 100, 100); // top-left
    const theirs = W(2, 200, 200, 100, 100); // bottom-right
    const result = pickWindowAt([ours, theirs], 250, 250, (w) => w.id === 1);
    expect(result?.id).toBe(2);
  });
});
