import { describe, expect, test } from "vitest";

import type { AffineTransform } from "@pwrsnap/shared";

import { isCornerHandle, resizeRasterTransform } from "../raster-resize";

// Start box: transform [1,0,0,1,100,50], natural 200×100 → on-canvas box
// { left: 100, top: 50, w: 200, h: 100 }.
const START: AffineTransform = [1, 0, 0, 1, 100, 50];
const NAT_W = 200;
const NAT_H = 100;

function resize(
  handle: Parameters<typeof resizeRasterTransform>[0]["handle"],
  dxPx: number,
  dyPx: number,
  lockAspect = false
): AffineTransform {
  return resizeRasterTransform({
    handle,
    dxPx,
    dyPx,
    startTransform: START,
    naturalWidthPx: NAT_W,
    naturalHeightPx: NAT_H,
    lockAspect
  });
}

describe("resizeRasterTransform", () => {
  test("SE corner grows w+h, pins the NW anchor (left/top unchanged)", () => {
    // box 200×100 + (50,30) → 250×130 at the same origin.
    expect(resize("se", 50, 30)).toEqual([250 / 200, 0, 0, 130 / 100, 100, 50]);
  });

  test("NW corner shrinks toward the SE anchor (left/top move to keep the SE corner fixed)", () => {
    // Drag NW by (+50,+20): west→ -50 width, north→ -20 height → 150×80.
    // SE corner (300,150) stays: left = 100+200-150 = 150, top = 50+100-80 = 70.
    expect(resize("nw", 50, 20)).toEqual([150 / 200, 0, 0, 80 / 100, 150, 70]);
  });

  test("east edge scales width only; the y-delta is ignored", () => {
    expect(resize("e", 40, 999)).toEqual([240 / 200, 0, 0, 1, 100, 50]);
  });

  test("south edge scales height only; the x-delta is ignored", () => {
    expect(resize("s", 999, 25)).toEqual([1, 0, 0, 125 / 100, 100, 50]);
  });

  test("aspect lock on a corner preserves the start ratio, driven by the larger delta", () => {
    // aspect = 2. dx dominates (0.5 vs 0.1) → dy = dx/2 = 50 → 300×150 (ratio 2).
    const t = resize("se", 100, 10, true);
    expect(t).toEqual([300 / 200, 0, 0, 150 / 100, 100, 50]);
    expect((t[0] * NAT_W) / (t[3] * NAT_H)).toBeCloseTo(2, 6); // ratio preserved
  });

  test("aspect lock on an east edge drives height from width", () => {
    // dx=+50 → dy = 50/2 = 25 → 250×125 (ratio 2).
    expect(resize("e", 50, 0, true)).toEqual([250 / 200, 0, 0, 125 / 100, 100, 50]);
  });

  test("clamps to the minimum size instead of inverting", () => {
    // SE dragged far past zero → width floored at 8 (default min).
    const t = resize("se", -500, -500);
    expect(t[0]).toBe(8 / 200);
    expect(t[3]).toBe(8 / 100);
    // Still anchored at the NW corner.
    expect(t[4]).toBe(100);
    expect(t[5]).toBe(50);
  });

  test("isCornerHandle distinguishes corners from edges", () => {
    expect((["nw", "ne", "se", "sw"] as const).every(isCornerHandle)).toBe(true);
    expect((["n", "e", "s", "w"] as const).some(isCornerHandle)).toBe(false);
  });
});
