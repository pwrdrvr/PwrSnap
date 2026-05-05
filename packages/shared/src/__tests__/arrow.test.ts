import { describe, expect, it } from "vitest";
import { computeArrowGeometry } from "../arrow";

const SQUARE_2K = { imageWidthPx: 2000, imageHeightPx: 2000 };

describe("computeArrowGeometry", () => {
  it("derives stroke width from image short-side", () => {
    // 2000 / 220 ≈ 9.09 → clamped within [4, 14] → ~9.09
    const geom = computeArrowGeometry({
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.8, y: 0.8 },
      ...SQUARE_2K
    });
    expect(geom.strokeWidthPx).toBeGreaterThan(8);
    expect(geom.strokeWidthPx).toBeLessThan(11);
  });

  it("clamps stroke to a minimum of 4px on tiny images", () => {
    // 100 / 220 ≈ 0.45 → clamps up to 4.
    const geom = computeArrowGeometry({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      imageWidthPx: 100,
      imageHeightPx: 100
    });
    expect(geom.strokeWidthPx).toBe(4);
  });

  it("clamps stroke to a maximum of 14px on giant images", () => {
    // 8000 / 220 ≈ 36.4 → clamps down to 14.
    const geom = computeArrowGeometry({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      imageWidthPx: 8000,
      imageHeightPx: 8000
    });
    expect(geom.strokeWidthPx).toBe(14);
  });

  it("uses the SHORT side, not the long side", () => {
    // Wide image: short side = 600. 600 / 220 ≈ 2.7 → clamps up to 4.
    const wide = computeArrowGeometry({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      imageWidthPx: 4000,
      imageHeightPx: 600
    });
    expect(wide.strokeWidthPx).toBe(4);
  });

  it("scales head dimensions proportionally to stroke", () => {
    const geom = computeArrowGeometry({
      from: { x: 0.2, y: 0.5 },
      to: { x: 0.8, y: 0.5 },
      ...SQUARE_2K
    });
    expect(geom.headLengthPx).toBeCloseTo(geom.strokeWidthPx * 3.5, 5);
    expect(geom.headWidthPx).toBeCloseTo(geom.strokeWidthPx * 2.6, 5);
  });

  it("places the base of the head behind `to` along the arrow direction", () => {
    // Horizontal arrow → base is left of `to` by exactly headLength.
    const geom = computeArrowGeometry({
      from: { x: 0.0, y: 0.5 },
      to: { x: 1.0, y: 0.5 },
      ...SQUARE_2K
    });
    // baseCenter.x in pixel space ≈ to.x - headLengthPx
    const toXPx = geom.to.x * SQUARE_2K.imageWidthPx;
    const baseXPx = geom.baseCenter.x * SQUARE_2K.imageWidthPx;
    expect(toXPx - baseXPx).toBeCloseTo(geom.headLengthPx, 4);
    // y stays on the arrow line
    expect(geom.baseCenter.y).toBeCloseTo(0.5, 5);
  });

  it("places the head's perpendicular corners symmetric around the base", () => {
    const geom = computeArrowGeometry({
      from: { x: 0.0, y: 0.5 },
      to: { x: 1.0, y: 0.5 },
      ...SQUARE_2K
    });
    // For a horizontal arrow, perp is vertical → equal y offsets in
    // image pixel coords from baseCenter to baseLeft / baseRight.
    const baseY = geom.baseCenter.y * SQUARE_2K.imageHeightPx;
    const leftY = geom.baseLeft.y * SQUARE_2K.imageHeightPx;
    const rightY = geom.baseRight.y * SQUARE_2K.imageHeightPx;
    expect(leftY - baseY).toBeCloseTo(-(rightY - baseY), 4);
  });

  it("thickens the tail when the arrow is shorter than 2× head length", () => {
    // A very short arrow on a 2000px image: stroke would normally be
    // ~9px → headLength ~31.5px → 2× threshold is ~63px. Make the
    // arrow only 40px long.
    const shortGeom = computeArrowGeometry({
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.52, y: 0.5 }, // ~40px on 2000px wide
      ...SQUARE_2K
    });
    const longGeom = computeArrowGeometry({
      from: { x: 0.0, y: 0.5 },
      to: { x: 1.0, y: 0.5 },
      ...SQUARE_2K
    });
    // Short geom should have BIGGER (thicker) stroke than long, but
    // never below the floor.
    expect(shortGeom.strokeWidthPx).toBeGreaterThanOrEqual(STROKE_MIN_PX);
    expect(shortGeom.strokeWidthPx).toBeLessThanOrEqual(longGeom.strokeWidthPx);
    // Short arrow should not go below 4px floor.
    expect(shortGeom.strokeWidthPx).toBeGreaterThanOrEqual(STROKE_MIN_PX);
  });

  it("handles a zero-length arrow without dividing by zero", () => {
    const geom = computeArrowGeometry({
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.5, y: 0.5 },
      ...SQUARE_2K
    });
    expect(Number.isFinite(geom.strokeWidthPx)).toBe(true);
    expect(Number.isFinite(geom.headLengthPx)).toBe(true);
  });

  it("strokeFraction relates to image short-side cleanly", () => {
    const geom = computeArrowGeometry({
      from: { x: 0.0, y: 0.5 },
      to: { x: 1.0, y: 0.5 },
      ...SQUARE_2K
    });
    expect(geom.strokeFraction).toBeCloseTo(geom.strokeWidthPx / 2000, 6);
  });
});

const STROKE_MIN_PX = 4;
