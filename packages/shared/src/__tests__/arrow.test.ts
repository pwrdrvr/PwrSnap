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

  it("scales head dimensions proportionally to stroke (v1 default)", () => {
    // No styleVersion → v1 (legacy proportions: length 3.5×stroke,
    // width 2.6×stroke). Pre-versioning rows render at this recipe
    // forever. v2 (5/3) tested separately below.
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

    it("falls back to auto-derivation when override is missing, explicit undefined, or non-positive", () => {
      // The override branch tests three "no override" shapes:
      //   1. field absent entirely
      //   2. field present with value `undefined` (the JS-only path,
      //      since exactOptionalPropertyTypes makes explicit
      //      undefined inexpressible from TS — but JSON-decoded
      //      inputs and `any`-typed call sites can still hit it)
      //   3. field present with 0 / negative (would otherwise produce
      //      a zero-stroke arrow or a NaN; the `> 0` guard sends it
      //      to auto-derivation)
      // All three must produce the SAME auto geometry. Previously
      // this test called the function twice with identical inputs
      // (no override), which only asserted determinism.
      const base = {
        from: { x: 0.1, y: 0.5 },
        to: { x: 0.9, y: 0.5 },
        ...SQUARE_2K
      };
      const auto = computeArrowGeometry(base);
      const explicitUndefined = computeArrowGeometry({
        ...base,
        strokeWidthOverridePx: undefined
      });
      const zero = computeArrowGeometry({ ...base, strokeWidthOverridePx: 0 });
      const negative = computeArrowGeometry({ ...base, strokeWidthOverridePx: -3 });
      for (const variant of [explicitUndefined, zero, negative]) {
        expect(variant.strokeWidthPx).toBeCloseTo(auto.strokeWidthPx, 5);
        expect(variant.headWidthPx).toBeCloseTo(auto.headWidthPx, 5);
        expect(variant.headLengthPx).toBeCloseTo(auto.headLengthPx, 5);
      }
    });
  });

  describe("styleVersion", () => {
    // The version table is the load-bearing mechanism for keeping
    // historical captures stable when we change the visual recipe.
    // These tests prove three things:
    //   1. Missing styleVersion falls back to v1 (legacy proportions).
    //   2. Explicit v1 matches the missing-field default exactly.
    //   3. v2 produces different proportions for the same inputs —
    //      proof that the table actually swaps recipes.
    //   4. An unknown future version falls back to v1, not silently
    //      "the closest known version" — fail-safe rather than
    //      fail-pretty.
    //
    // When adding v3+ down the line, append a test here that asserts
    // v1 vs vN produce visibly different output for the same inputs.

    const base = {
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      ...SQUARE_2K
    };

    it("defaults to v1 (legacy 3.5/2.6 proportions) when field is missing", () => {
      const geom = computeArrowGeometry(base);
      expect(geom.headLengthPx).toBeCloseTo(geom.strokeWidthPx * 3.5, 5);
      expect(geom.headWidthPx).toBeCloseTo(geom.strokeWidthPx * 2.6, 5);
    });

    it("explicit v1 matches the default", () => {
      const missing = computeArrowGeometry(base);
      const explicit = computeArrowGeometry({ ...base, styleVersion: 1 });
      expect(explicit.headLengthPx).toBeCloseTo(missing.headLengthPx, 5);
      expect(explicit.headWidthPx).toBeCloseTo(missing.headWidthPx, 5);
      expect(explicit.strokeWidthPx).toBeCloseTo(missing.strokeWidthPx, 5);
    });

    it("v2 uses 5/3 proportions (Office-aligned)", () => {
      const v2 = computeArrowGeometry({ ...base, styleVersion: 2 });
      expect(v2.headLengthPx).toBeCloseTo(v2.strokeWidthPx * 5, 5);
      expect(v2.headWidthPx).toBeCloseTo(v2.strokeWidthPx * 3, 5);
    });

    it("v1 and v2 produce different head dimensions for the same inputs", () => {
      const v1 = computeArrowGeometry({ ...base, styleVersion: 1 });
      const v2 = computeArrowGeometry({ ...base, styleVersion: 2 });
      // Same stroke (auto-derived from identical geometry), different
      // ratios → different head dims. This is the WHOLE POINT of the
      // version table — same row, different visual recipe.
      expect(v2.strokeWidthPx).toBeCloseTo(v1.strokeWidthPx, 5);
      expect(v2.headLengthPx).toBeGreaterThan(v1.headLengthPx);
      expect(v2.headWidthPx).toBeGreaterThan(v1.headWidthPx);
    });

    it("unknown future version falls back to v1 (fail-safe)", () => {
      // A v3 row read by an older client that only knows v1+v2 must
      // NOT silently render at v2 — that would produce inconsistent
      // output for the same row across clients. v1 is the legacy
      // anchor; anything we don't recognize gets the legacy recipe.
      const v1 = computeArrowGeometry({ ...base, styleVersion: 1 });
      const future = computeArrowGeometry({ ...base, styleVersion: 999 });
      expect(future.headLengthPx).toBeCloseTo(v1.headLengthPx, 5);
      expect(future.headWidthPx).toBeCloseTo(v1.headWidthPx, 5);
    });
  });
});

const STROKE_MIN_PX = 4;
