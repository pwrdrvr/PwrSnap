// Unit tests for `computeTextGlyphSize`. Pinned by a real user bug
// on pwrdrvr/PwrSnap#110: text overlays "shrink" after a v2 crop —
// the symptom is more chars visible past the text anchor and a
// perception that the text "moves left and up" relative to the
// image content, because each glyph is narrower in source-pixel
// terms after the crop.
//
// Root cause was that the old fontSize formula derived `sizePx`
// from the CANVAS's short side (which shrinks every crop), keeping
// the on-canvas viewBox fontSize constant at 1/30 but silently
// changing the meaning of "1/30 viewBox" — pre-crop it was 64
// source pixels (1920/30); post-crop on a 1239-tall canvas it
// became 41 source pixels (1239/30).
//
// The contract we pin: `sizePx` is in CANVAS/SOURCE pixels (= same
// thing in v2 — a crop is a viewport change, not a resampling) and
// MUST stay constant across crops. `fontSize` is in viewBox units
// and GROWS as the canvas shrinks, so the on-screen text matches
// what the underlying image content shows.

import { describe, expect, test } from "vitest";
import { computeTextGlyphSize } from "../text-glyph-size";

describe("computeTextGlyphSize storedSizePx override (TextOverlay.sizePx → render)", () => {
  // pwrdrvr/PwrSnap#110: when a row carries an explicit sizePx, that
  // value wins — the bucket math is bypassed. This is the load-
  // bearing path for the new "Custom" UX: a row whose sizePx doesn't
  // match any bucket for the current canvas renders at its stored
  // size; the popover then surfaces "Custom" to signal the mismatch.
  test("storedSizePx wins over the bucket math when present", () => {
    const result = computeTextGlyphSize({
      size: "medium", // would resolve to 1920/30 = 64 normally
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2880,
      canvasHeightPx: 1920,
      storedSizePx: 100 // explicit override
    });
    expect(result.sizePx).toBe(100); // NOT 64
    expect(result.fontSize).toBeCloseTo(100 / 1920, 5);
  });

  test("storedSizePx absent → falls back to bucket × source shortSide", () => {
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2880,
      canvasHeightPx: 1920
      // no storedSizePx
    });
    expect(result.sizePx).toBeCloseTo(64, 5); // bucket fallback
  });

  test("storedSizePx with cropped canvas: stored value stays, fontSize scales to current canvas", () => {
    // The Custom-state scenario: row was placed at sizePx=64 on the
    // uncropped capture, user then cropped to a smaller canvas. The
    // stored sizePx doesn't change (it's row-level data). fontSize
    // (viewBox unit) scales by canvasShortSide so the on-screen text
    // height stays proportional to the source raster.
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2294,
      canvasHeightPx: 1239,
      storedSizePx: 64
    });
    expect(result.sizePx).toBe(64); // unchanged across crops
    expect(result.fontSize).toBeCloseTo(64 / 1239, 5); // bigger viewBox value
  });
});

describe("computeTextGlyphSize", () => {
  test("uncropped capture (canvas == source): sizePx = sourceShortSide/30 for medium", () => {
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2880,
      canvasHeightPx: 1920
    });
    expect(result.sizePx).toBeCloseTo(1920 / 30, 5); // = 64 source/canvas px
    expect(result.fontSize).toBeCloseTo(64 / 1920, 5); // = 1/30 = 0.0333 viewBox
  });

  test("cropped capture: sizePx STAYS at sourceShortSide/30 (NOT canvasShortSide/30) — the load-bearing fix", () => {
    // User's exact case from PR #110 diagnostic:
    //   source raster 2880×1920 → after crop, canvas is 2294×1239.
    //   Pre-fix sizePx = canvasShortSide/30 = 1239/30 = 41.3 (text
    //   shrinks 35% in source-pixel terms). Post-fix sizePx stays
    //   at sourceShortSide/30 = 1920/30 = 64 (unchanged).
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2294,
      canvasHeightPx: 1239
    });
    expect(
      result.sizePx,
      "sizePx must derive from SOURCE short side (constant across crops), not canvas short side (shrinks). Otherwise text overlays silently re-render at a smaller source-pixel size after every crop."
    ).toBeCloseTo(1920 / 30, 5); // = 64, NOT 41.3
    // fontSize is viewBox units = sizePx / canvasShortSide.
    // As canvasShortSide shrinks (1920 → 1239), fontSize must GROW
    // (0.0333 → 0.0517) so the on-screen text height stays
    // proportional to the source raster.
    expect(result.fontSize).toBeCloseTo(64 / 1239, 5); // ≈ 0.0517
  });

  test("portrait canvas: sourceShortSide is the WIDTH, not the height", () => {
    // A portrait-oriented capture (e.g., from a phone screenshot).
    // Source shortSide = min(width, height) = width.
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 1080,
      sourceHeightPx: 2400,
      canvasWidthPx: 1080,
      canvasHeightPx: 2400
    });
    expect(result.sizePx).toBeCloseTo(1080 / 30, 5); // = 36
    expect(result.fontSize).toBeCloseTo(36 / 1080, 5); // = 1/30
  });

  test("small / medium / large at the canonical ratios", () => {
    const args = {
      sourceWidthPx: 2880,
      sourceHeightPx: 1920,
      canvasWidthPx: 2880,
      canvasHeightPx: 1920
    } as const;
    expect(computeTextGlyphSize({ ...args, size: "small" }).sizePx).toBeCloseTo(
      1920 / 50,
      5
    ); // 38.4
    expect(computeTextGlyphSize({ ...args, size: "medium" }).sizePx).toBeCloseTo(
      1920 / 30,
      5
    ); // 64
    expect(computeTextGlyphSize({ ...args, size: "large" }).sizePx).toBeCloseTo(
      1920 / 18,
      5
    ); // 106.67
  });

  test("zero canvas / source dims don't divide by zero (pre-measurement frame)", () => {
    const result = computeTextGlyphSize({
      size: "medium",
      sourceWidthPx: 0,
      sourceHeightPx: 0,
      canvasWidthPx: 0,
      canvasHeightPx: 0
    });
    expect(Number.isFinite(result.sizePx)).toBe(true);
    expect(Number.isFinite(result.fontSize)).toBe(true);
  });
});
