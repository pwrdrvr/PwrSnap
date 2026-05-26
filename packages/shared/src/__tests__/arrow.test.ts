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

  it("image-derived stroke floor uses the SHORT side (the floor, not the cap)", () => {
    // Wide image with a SHORT arrow: short side = 600 → image-derived
    // base = 4. The arrow is small (~80px) so the length-derived stroke
    // (80/250 = 0.32) is below the floor, and the image-derived 4 wins.
    const wide = computeArrowGeometry({
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.52, y: 0.5 }, // 80px on a 4000-wide image
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
    // Length:width = 5:3 ≈ golden ratio. PowerPoint / Word /
    // Keynote default annotation arrows live in the same zone, which
    // is the visual grammar PwrSnap viewers have already learned.
    // Pre-2026-05 this was 3.5/2.6 (≈1.35:1) — too squat, especially
    // at Large where the head was visibly stubby vs the doubled stem.
    expect(geom.headLengthPx).toBeCloseTo(geom.strokeWidthPx * 5, 5);
    expect(geom.headWidthPx).toBeCloseTo(geom.strokeWidthPx * 3, 5);
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

  // ------- Reported pathologies (each is a failing case before fix) -------

  describe("short arrow regression cases", () => {
    it("baseCenter never lands behind `from` (no inverted head)", () => {
      // 20px arrow on a 2000px image. Normal head length would be ~32px,
      // which is longer than the arrow itself — without guarding,
      // baseCenter ends up at to.x - headLength = behind `from`, and
      // the head triangle appears to render backwards.
      const geom = computeArrowGeometry({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.51, y: 0.5 }, // 20px
        ...SQUARE_2K
      });
      const fromXPx = geom.from.x * 2000;
      const toXPx = geom.to.x * 2000;
      const baseXPx = geom.baseCenter.x * 2000;
      // baseCenter must sit between from and to (inclusive on `to`), never
      // behind `from`. For horizontal arrows that means fromX <= baseX <= toX.
      expect(baseXPx).toBeGreaterThanOrEqual(fromXPx);
      expect(baseXPx).toBeLessThanOrEqual(toXPx);
    });

    it("head triangle fits inside the arrow's bounding span (no head past `to` or behind `from`)", () => {
      const geom = computeArrowGeometry({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.51, y: 0.5 },
        ...SQUARE_2K
      });
      const fromXPx = geom.from.x * 2000;
      const toXPx = geom.to.x * 2000;
      const leftPx = geom.baseLeft.x * 2000;
      const rightPx = geom.baseRight.x * 2000;
      // The base corners' projection onto the arrow axis (x) must sit
      // between from and to. Perpendicular corner offsets are OK; only
      // the along-axis position is constrained.
      expect(leftPx).toBeGreaterThanOrEqual(fromXPx - 0.01);
      expect(leftPx).toBeLessThanOrEqual(toXPx + 0.01);
      expect(rightPx).toBeGreaterThanOrEqual(fromXPx - 0.01);
      expect(rightPx).toBeLessThanOrEqual(toXPx + 0.01);
    });

    it("head remains visible (non-degenerate triangle) for short arrows", () => {
      const geom = computeArrowGeometry({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.515, y: 0.5 }, // 30px
        ...SQUARE_2K
      });
      // Triangle area must be > 0 — not collapsed to a line or point.
      const ax = geom.to.x * 2000,
        ay = geom.to.y * 2000;
      const bx = geom.baseLeft.x * 2000,
        by = geom.baseLeft.y * 2000;
      const cx = geom.baseRight.x * 2000,
        cy = geom.baseRight.y * 2000;
      const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      expect(area).toBeGreaterThan(4); // at least a few square pixels
    });
  });

  describe("long arrow stroke scaling", () => {
    it("stroke scales up for very long arrows on a short-side-small image (no hairline)", () => {
      // 4000×600 image. Short side = 600 → base stroke clamps to 4px (the
      // floor). An arrow that traverses 3000px of the image looks like a
      // hairline at 4px (0.13% of arrow length). The smart algorithm
      // should scale the stroke up for long arrows.
      const geom = computeArrowGeometry({
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 }, // 3200px on a 4000-wide image
        imageWidthPx: 4000,
        imageHeightPx: 600
      });
      // Stroke must be at least ~1% of the arrow length so it doesn't look
      // hair-thin. 3200 * 0.01 = 32, clamped by STROKE_MAX_PX → expect ≥10px.
      expect(geom.strokeWidthPx).toBeGreaterThanOrEqual(10);
    });

    it("stroke is bounded above for monstrous arrows (no crayola)", () => {
      // Full-image arrow on a 4000×600 image: 3960px. We don't want stroke
      // to blow past STROKE_MAX_PX.
      const geom = computeArrowGeometry({
        from: { x: 0.0, y: 0.5 },
        to: { x: 1.0, y: 0.5 },
        imageWidthPx: 4000,
        imageHeightPx: 600
      });
      expect(geom.strokeWidthPx).toBeLessThanOrEqual(20);
    });
  });

  describe("head/stroke proportion stability", () => {
    it("head width never falls below stroke width (head must be visible against the line)", () => {
      const cases = [
        { from: { x: 0.5, y: 0.5 }, to: { x: 0.52, y: 0.5 } }, // very short
        { from: { x: 0.5, y: 0.5 }, to: { x: 0.6, y: 0.5 } }, // medium
        { from: { x: 0.1, y: 0.5 }, to: { x: 0.9, y: 0.5 } }, // long
        { from: { x: 0.1, y: 0.1 }, to: { x: 0.9, y: 0.9 } } // diagonal
      ];
      for (const c of cases) {
        const geom = computeArrowGeometry({ ...c, ...SQUARE_2K });
        expect(geom.headWidthPx, JSON.stringify(c)).toBeGreaterThanOrEqual(
          geom.strokeWidthPx
        );
      }
    });
  });

  describe("strokeWidthOverridePx", () => {
    // Pre-fix: callers (renderer + bake) applied the user's "Large"
    // multiplier ONLY to the stem stroke they drew, while the head
    // triangle was sized from the un-multiplied geometry. Result on a
    // Large arrow: fat stem + tiny head, and open-triangle's hollow
    // filled in with the now-thick outline stroke. The override
    // parameter pushes thickness resolution into the geometry function
    // so head + stem scale together through one source of truth.
    it("treats the override as the basis for head sizing", () => {
      const base = {
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        ...SQUARE_2K
      };
      const auto = computeArrowGeometry(base);
      const doubled = computeArrowGeometry({
        ...base,
        strokeWidthOverridePx: auto.strokeWidthPx * 2
      });
      expect(doubled.strokeWidthPx).toBeCloseTo(auto.strokeWidthPx * 2, 5);
      // Head dims cascade from strokeWidthPx via HEAD_LENGTH_RATIO /
      // HEAD_WIDTH_RATIO — both should ~2× with the doubled stroke.
      expect(doubled.headLengthPx).toBeCloseTo(auto.headLengthPx * 2, 5);
      expect(doubled.headWidthPx).toBeCloseTo(auto.headWidthPx * 2, 5);
    });

    it("short-arrow correction still applies when override is too big for the arrow", () => {
      // 0.02 normalized × 2000 px = 40 px arrow. Force a 50-px stroke
      // override → head length would be 50 × 5 = 250 px, way past
      // the arrow's 40-px length. The correction must shrink head +
      // stroke together so the head fits.
      const geom = computeArrowGeometry({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.52, y: 0.5 },
        strokeWidthOverridePx: 50,
        ...SQUARE_2K
      });
      expect(geom.headLengthPx).toBeLessThanOrEqual(geom.lengthPx);
      // Stroke shrinks proportionally with the head.
      expect(geom.strokeWidthPx).toBeLessThan(50);
    });

    it("ignores override when undefined (auto-derivation path)", () => {
      const a = computeArrowGeometry({
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        ...SQUARE_2K
      });
      const b = computeArrowGeometry({
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        ...SQUARE_2K
      });
      expect(b.strokeWidthPx).toBeCloseTo(a.strokeWidthPx, 5);
      expect(b.headWidthPx).toBeCloseTo(a.headWidthPx, 5);
    });
  });
});

const STROKE_MIN_PX = 4;
