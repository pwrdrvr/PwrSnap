// Cursor-capture Phase 3 — placement math contract. The sampled cursor
// arrives in GLOBAL points (CGEvent top-left origin); the captured
// selection rect is GLOBAL logical px (the same space on macOS). The
// placement converts to canvas pixels: sprite top-left =
// (pos − hotspot − regionOrigin)·scale, draw box = pointSize·scale.
// R6: no layer when the HOTSPOT is outside the captured region —
// sprite overhang past an edge is fine (clips at the canvas).

import { describe, expect, test, vi } from "vitest";

vi.mock("../window-list", () => ({
  resolveWindowListHelperPath: () => null
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const { computeCursorPlacement } = await import("../cursor-sample");

const SAMPLE = {
  posX: 500,
  posY: 400,
  hotspotX: 4,
  hotspotY: 2,
  pointWidth: 16,
  pointHeight: 24
};

describe("computeCursorPlacement", () => {
  test("places the sprite at (pos − hotspot − origin)·scale with point-size draw box", () => {
    const p = computeCursorPlacement({
      sample: SAMPLE,
      regionOriginX: 300,
      regionOriginY: 350,
      regionWidth: 400,
      regionHeight: 300,
      scaleFactor: 2
    });
    expect(p).toEqual({
      xPx: (500 - 300 - 4) * 2,
      yPx: (400 - 350 - 2) * 2,
      drawWidthPx: 32,
      drawHeightPx: 48
    });
  });

  test("returns null when the hotspot is outside the region (other display / margin)", () => {
    // Left of the region.
    expect(
      computeCursorPlacement({
        sample: { ...SAMPLE, posX: 299 },
        regionOriginX: 300,
        regionOriginY: 350,
        regionWidth: 400,
        regionHeight: 300,
        scaleFactor: 2
      })
    ).toBeNull();
    // Past the bottom edge (>= is out — the edge pixel itself is in).
    expect(
      computeCursorPlacement({
        sample: { ...SAMPLE, posY: 650 },
        regionOriginX: 300,
        regionOriginY: 350,
        regionWidth: 400,
        regionHeight: 300,
        scaleFactor: 2
      })
    ).toBeNull();
  });

  test("a hotspot just inside the edge stays in, even when the sprite overhangs", () => {
    const p = computeCursorPlacement({
      sample: { ...SAMPLE, posX: 300, posY: 350 },
      regionOriginX: 300,
      regionOriginY: 350,
      regionWidth: 400,
      regionHeight: 300,
      scaleFactor: 1
    });
    // Sprite top-left lands NEGATIVE (hotspot offset) — allowed; the
    // canvas clips the overhang exactly like any raster layer.
    expect(p).toEqual({ xPx: -4, yPx: -2, drawWidthPx: 16, drawHeightPx: 24 });
  });
});
