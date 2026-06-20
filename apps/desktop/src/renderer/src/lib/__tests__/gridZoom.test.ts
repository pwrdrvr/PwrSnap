import { describe, expect, test } from "vitest";
import {
  GRID_ZOOM_DEFAULT,
  GRID_ZOOM_LEVELS,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN
} from "@pwrsnap/shared";
import { clampGridZoom, snapGridZoom, stepGridZoom } from "../gridZoom";

describe("gridZoom — contract sanity", () => {
  test("levels are ascending and the default is one of them", () => {
    for (let i = 1; i < GRID_ZOOM_LEVELS.length; i++) {
      expect(GRID_ZOOM_LEVELS[i]).toBeGreaterThan(GRID_ZOOM_LEVELS[i - 1]);
    }
    expect(GRID_ZOOM_LEVELS).toContain(GRID_ZOOM_DEFAULT);
    expect(GRID_ZOOM_MIN).toBe(GRID_ZOOM_LEVELS[0]);
    expect(GRID_ZOOM_MAX).toBe(GRID_ZOOM_LEVELS[GRID_ZOOM_LEVELS.length - 1]);
  });
});

describe("clampGridZoom", () => {
  test("passes in-band values through", () => {
    expect(clampGridZoom(180)).toBe(180);
    expect(clampGridZoom(205)).toBe(205);
  });
  test("clamps to [MIN, MAX]", () => {
    expect(clampGridZoom(10)).toBe(GRID_ZOOM_MIN);
    expect(clampGridZoom(9999)).toBe(GRID_ZOOM_MAX);
  });
  test("falls back to default for non-finite input", () => {
    expect(clampGridZoom(Number.NaN)).toBe(GRID_ZOOM_DEFAULT);
    expect(clampGridZoom(Number.POSITIVE_INFINITY)).toBe(GRID_ZOOM_DEFAULT);
  });
});

describe("snapGridZoom", () => {
  test("exact levels round-trip", () => {
    for (const level of GRID_ZOOM_LEVELS) {
      expect(snapGridZoom(level)).toBe(level);
    }
  });
  test("snaps to the nearest level", () => {
    expect(snapGridZoom(181)).toBe(180);
    expect(snapGridZoom(205)).toBe(220); // |180-205|=25 > |220-205|=15
    expect(snapGridZoom(130)).toBe(120); // |120-130|=10 < |150-130|=20
  });
  test("ties round down (toward smaller thumbnails / more columns)", () => {
    expect(snapGridZoom(200)).toBe(180); // equidistant 180/220 → 180
  });
  test("clamps out-of-band values to the end levels", () => {
    expect(snapGridZoom(10)).toBe(GRID_ZOOM_MIN);
    expect(snapGridZoom(9999)).toBe(GRID_ZOOM_MAX);
  });
  test("non-finite input snaps to the nearest level to the default", () => {
    expect(snapGridZoom(Number.NaN)).toBe(GRID_ZOOM_DEFAULT);
  });
});

describe("stepGridZoom", () => {
  test("+1 moves to the next-larger level, -1 to the next-smaller", () => {
    expect(stepGridZoom(180, 1)).toBe(220);
    expect(stepGridZoom(180, -1)).toBe(150);
  });
  test("clamps at the ends (no wrap)", () => {
    expect(stepGridZoom(GRID_ZOOM_MAX, 1)).toBe(GRID_ZOOM_MAX);
    expect(stepGridZoom(GRID_ZOOM_MIN, -1)).toBe(GRID_ZOOM_MIN);
  });
  test("steps relative to the nearest level when given an off-ladder value", () => {
    // nearest(200) = 180 (tie → down); +1 → 220
    expect(stepGridZoom(200, 1)).toBe(220);
    // nearest(205) = 220; -1 → 180
    expect(stepGridZoom(205, -1)).toBe(180);
  });
  test("repeated +1 walks the whole ladder and stops at the top", () => {
    let v: number = GRID_ZOOM_MIN;
    const visited: number[] = [v];
    for (let i = 0; i < GRID_ZOOM_LEVELS.length + 2; i++) {
      v = stepGridZoom(v, 1);
      visited.push(v);
    }
    // Ends pinned at MAX, and every level was visited in order.
    expect(v).toBe(GRID_ZOOM_MAX);
    expect(visited.slice(0, GRID_ZOOM_LEVELS.length)).toEqual([...GRID_ZOOM_LEVELS]);
  });
});
