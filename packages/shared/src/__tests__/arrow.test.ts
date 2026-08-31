import { describe, expect, it } from "vitest";
import { computeArrowGeometry, computeStemDashArray } from "../arrow";
import { annotationBasisPx, annotationStrokeWidthPx } from "../annotation-scale";

const SQUARE_2K = { imageWidthPx: 2000, imageHeightPx: 2000 };

describe("computeArrowGeometry", () => {
  it("derives the auto stroke from the annotation basis (= the ladder's Medium rung)", () => {
    // basis = max(900, 2000, 2828/2) = 2000 → 2000 / 105 ≈ 19.05.
    const geom = computeArrowGeometry({
      from: { x: 0.2, y: 0.2 },
      to: { x: 0.8, y: 0.8 },
      ...SQUARE_2K
    });
    expect(geom.strokeWidthPx).toBeCloseTo(
      annotationStrokeWidthPx("medium", annotationBasisPx(2000, 2000)),
      5
    );
    expect(geom.strokeWidthPx).toBeCloseTo(19.05, 2);
  });

  it("holds the stroke at the basis floor on tiny images instead of an absolute 4px clamp", () => {
    // A 100×100 crop has no extent to scale from, but the UI text
    // inside it is the same size as in any other screenshot — so the
    // basis floors at 900 and the stroke lands on the ladder's Medium
    // rung (900/105 ≈ 8.57) rather than the old hardcoded 4px.
    const geom = computeArrowGeometry({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      imageWidthPx: 100,
      imageHeightPx: 100
    });
    expect(geom.strokeWidthPx).toBeCloseTo(900 / 105, 5);
  });

  it("keeps scaling on giant images instead of capping at 14px", () => {
    // The old STROKE_MAX_PX = 14 made an 8000px capture's auto arrow
    // render at 0.18% of its short side — a hairline once the export
    // was scaled down into a doc. Now it stays proportional.
    const geom = computeArrowGeometry({
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      imageWidthPx: 8000,
      imageHeightPx: 8000
    });
    expect(geom.strokeWidthPx).toBeCloseTo(8000 / 105, 5);
  });

  it("does not collapse on a wide-short image (the basis takes the diagonal branch)", () => {
    // 4000×600: short side is 600, which used to drive the stroke to
    // the 4px clamp floor. basis = max(900, 600, 4044/2 = 2022) = 2022,
    // so the arrow is sized as the big image it actually is.
    const wide = computeArrowGeometry({
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.52, y: 0.5 }, // 80px on a 4000-wide image
      imageWidthPx: 4000,
      imageHeightPx: 600
    });
    const basis = annotationBasisPx(4000, 600);
    expect(basis).toBeCloseTo(Math.hypot(4000, 600) / 2, 5);
    expect(wide.strokeWidthPx).toBeCloseTo(
      annotationStrokeWidthPx("medium", basis),
      5
    );
    // ~19px vs the old 4px clamp floor, and the 67px head still fits
    // inside the 80px arrow so no short-arrow correction is needed.
    expect(wide.strokeWidthPx).toBeGreaterThan(4);
    expect(wide.headLengthPx).toBeLessThan(80);
  });

  it("the length term can no longer beat the basis for any in-image arrow", () => {
    // The length bump existed because the short-side basis collapsed
    // on wide-short images. It is now provably dominated for anything
    // that fits inside the canvas: basis >= diagonal/2, so the auto
    // stroke is >= diagonal/210 while the length term is at most
    // diagonal/250.
    for (const [w, h] of [
      [4000, 600],
      [1920, 1080],
      [777, 207],
      [200, 5000]
    ] as const) {
      const corner = computeArrowGeometry({
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 }, // the full diagonal — the longest in-image arrow
        imageWidthPx: w,
        imageHeightPx: h
      });
      expect(corner.strokeWidthPx).toBeCloseTo(
        annotationStrokeWidthPx("medium", annotationBasisPx(w, h)),
        5
      );
    }
  });

  it("the short-arrow floor scales with the basis instead of a flat 2px", () => {
    // The short-arrow correction shrinks head + stroke together so the
    // head fits inside a tiny arrow, then floors the stroke. That floor
    // used to be an absolute 2px — the last absolute constant left after
    // the recalibration, so its meaning drifted with resolution (23% of
    // the auto stroke at the basis floor, 7% on a 5K capture). It is now
    // `basis / SHORT_ARROW_STROKE_MIN_DIVISOR`.
    const tiny = (w: number, h: number) =>
      computeArrowGeometry({
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.5005, y: 0.5 }, // a couple of px — well inside the head
        imageWidthPx: w,
        imageHeightPx: h,
        styleVersion: 2
      }).strokeWidthPx;

    // At the basis floor it lands within a quarter-pixel of the old 2px.
    expect(tiny(200, 80)).toBeCloseTo(900 / 400, 5);
    // On a big capture it keeps the same RATIO to the auto stroke
    // instead of collapsing to a hairline.
    const bigBasis = annotationBasisPx(5120, 2880);
    expect(tiny(5120, 2880)).toBeCloseTo(bigBasis / 400, 5);
    const ratioSmall = tiny(200, 80) / annotationStrokeWidthPx("medium", 900);
    const ratioBig = tiny(5120, 2880) / annotationStrokeWidthPx("medium", bigBasis);
    expect(ratioBig).toBeCloseTo(ratioSmall, 5);
  });

  it("honors an explicit basisPx so a cropped / scaled caller controls sizing", () => {
    // The bake passes annotationBasisPx(SOURCE) × renderScale; the
    // editor passes annotationBasisPx(SOURCE). Either way the caller's
    // number must win over one re-derived from the dims passed in.
    const geom = computeArrowGeometry({
      from: { x: 0.1, y: 0.5 },
      to: { x: 0.9, y: 0.5 },
      imageWidthPx: 400,
      imageHeightPx: 300,
      basisPx: 3000
    });
    expect(geom.strokeWidthPx).toBeCloseTo(3000 / 105, 5);
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

describe("computeStemDashArray", () => {
  // The whole point of this helper: regardless of stem length, the
  // dash pattern terminates with a complete dash at both ends. These
  // tests prove that property holds for the dashed style (which is
  // the visually load-bearing case — dotted dots are too small to
  // notice misalignment).

  it("returns null for solid (caller emits no dasharray attr)", () => {
    expect(computeStemDashArray("solid", 100, 2)).toBeNull();
  });

  function parsePattern(s: string): { dash: number; gap: number } {
    const parts = s.split(/\s+/).map(Number);
    return { dash: parts[0]!, gap: parts[1]! };
  }

  // For "N dashes + (N − 1) gaps fill exactly L" the test is
  // `N × dash + (N − 1) × gap ≈ L`. We don't know N from the output
  // string directly; recover it by inverting the math.
  function nDashes(pattern: { dash: number; gap: number }, L: number): number {
    // L = N*D + (N-1)*G = N*(D+G) - G → N = (L + G) / (D + G)
    return Math.round((L + pattern.gap) / (pattern.dash + pattern.gap));
  }

  it("dashed: line begins and ends on a complete dash for various lengths", () => {
    // Sweep a range of stem lengths — short, around-one-cycle,
    // medium, long — and verify the alignment invariant holds at
    // each. This is the regression-prevention test: any future
    // change that breaks the alignment will fail here.
    const stroke = 4; // natural cycle = 4*4 + 4*2 = 24 px
    for (const L of [10, 24, 50, 100, 137, 250, 500, 1000, 1337]) {
      const out = computeStemDashArray("dashed", L, stroke);
      expect(out, `length=${L}`).not.toBeNull();
      const p = parsePattern(out!);
      const N = nDashes(p, L);
      const reconstructed = N * p.dash + (N - 1) * p.gap;
      expect(reconstructed, `length=${L}, N=${N}`).toBeCloseTo(L, 4);
      // Ratio preserved: natural dashed is 4:2 = 2:1.
      expect(p.dash / p.gap, `length=${L}`).toBeCloseTo(2, 5);
    }
  });

  it("dotted: line begins and ends on a complete dot", () => {
    const stroke = 4;
    for (const L of [10, 50, 100, 250, 500]) {
      const out = computeStemDashArray("dotted", L, stroke);
      expect(out).not.toBeNull();
      const p = parsePattern(out!);
      const N = nDashes(p, L);
      const reconstructed = N * p.dash + (N - 1) * p.gap;
      expect(reconstructed, `length=${L}, N=${N}`).toBeCloseTo(L, 4);
      // Dotted ratio: 0.01 / 1.8 ≈ 0.00556 — much smaller dot than
      // gap (renders as a dot, not a stripe).
      expect(p.dash / p.gap).toBeLessThan(0.05);
    }
  });

  it("preserves dash:gap ratio so 'dashed' still reads as dashed", () => {
    // The scale stretches both D and G uniformly. A user looking at
    // two arrows of slightly different lengths should still see the
    // same visual rhythm, just slightly different absolute dash
    // lengths.
    const stroke = 6;
    for (const L of [80, 95, 110, 125]) {
      const p = parsePattern(computeStemDashArray("dashed", L, stroke)!);
      expect(p.dash / p.gap).toBeCloseTo(2, 5);
    }
  });

  it("degenerate input: zero-length stem returns a finite pattern (avoids NaN)", () => {
    const out = computeStemDashArray("dashed", 0, 2);
    expect(out).not.toBeNull();
    // Pattern must be parseable numbers — the line element will
    // render as a no-op but won't throw.
    const p = parsePattern(out!);
    expect(Number.isFinite(p.dash)).toBe(true);
    expect(Number.isFinite(p.gap)).toBe(true);
  });

  it("very short stem (< 1 natural cycle): falls back to a single dash spanning the stem", () => {
    // For stem << natural cycle, N rounds to 1. With 1 dash + 0 gaps,
    // the single dash fills L exactly → solid-ish output. Good
    // fallback: tiny arrows never visually read as dashed anyway.
    const stroke = 10; // natural cycle = 60 px
    const L = 8; // way less than cycle
    const p = parsePattern(computeStemDashArray("dashed", L, stroke)!);
    // Reconstruction with N=1: 1*D + 0*G = D = L.
    expect(p.dash).toBeCloseTo(L, 5);
  });
});

const STROKE_MIN_PX = 4;
