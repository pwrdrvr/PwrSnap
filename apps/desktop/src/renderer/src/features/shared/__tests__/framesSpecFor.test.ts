import { describe, expect, test } from "vitest";
import { framesSpecFor } from "../useVideoTimelineAssets";

describe("framesSpecFor (renderer side of the video:frames request)", () => {
  test("landscape 16:9 at 56 px lanes → ~100 px cells, quantized count + DPR width", () => {
    const spec = framesSpecFor({
      stripWidthPx: 1000,
      laneHeightPx: 56,
      sourceWidthPx: 1920,
      sourceHeightPx: 1080,
      devicePixelRatio: 2
    });
    // cell ≈ 99.6 css px → 1000/99.6 ≈ 10 → 12 (step 4); 199 px @2× → 192 (step 16)
    expect(spec).toEqual({ count: 12, frameWidth: 192 });
  });

  test("portrait sources get many narrow cells, capped at the server max", () => {
    const spec = framesSpecFor({
      stripWidthPx: 1000,
      laneHeightPx: 56,
      sourceWidthPx: 429,
      sourceHeightPx: 936,
      devicePixelRatio: 2
    });
    expect(spec?.count).toBe(40);
    expect(spec?.frameWidth).toBe(48);
    const huge = framesSpecFor({
      stripWidthPx: 8000,
      laneHeightPx: 40,
      sourceWidthPx: 429,
      sourceHeightPx: 936,
      devicePixelRatio: 1
    });
    expect(huge?.count).toBe(96);
  });

  test("null before the strip has been measured", () => {
    expect(
      framesSpecFor({
        stripWidthPx: 0,
        laneHeightPx: 56,
        sourceWidthPx: 1920,
        sourceHeightPx: 1080,
        devicePixelRatio: 1
      })
    ).toBeNull();
  });
});
