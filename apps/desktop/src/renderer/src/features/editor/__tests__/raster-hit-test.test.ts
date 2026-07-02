// Unit tests for raster hit-testing. Pins the canvas-normalized bounds
// math (must match computeRasterLayerStyle) and topmost-wins ordering.

import { describe, expect, test } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";

import { hitTestRasterLayers, rasterLayerBoundsN } from "../raster-hit-test";

type RasterLayer = Extract<BundleLayerNode, { kind: "raster" }>;

function raster(overrides: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: "r1",
    parent_id: "root",
    kind: "raster",
    name: "Pasted Image",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-01-01T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 100,
    natural_height_px: 50,
    ...overrides
  };
}

describe("rasterLayerBoundsN", () => {
  test("identity transform → bounds = natural/canvas at origin", () => {
    const b = rasterLayerBoundsN(raster(), 200, 100);
    expect(b).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 }); // 100/200, 50/100
  });

  test("translation + scale fold into x/y and w/h", () => {
    const b = rasterLayerBoundsN(
      raster({ transform: [2, 0, 0, 2, 40, 20], natural_width_px: 50, natural_height_px: 25 }),
      200,
      100
    );
    expect(b.x).toBe(0.2); // 40/200
    expect(b.y).toBe(0.2); // 20/100
    expect(b.w).toBe(0.5); // 50*2/200
    expect(b.h).toBe(0.5); // 25*2/100
  });

  test("degenerate canvas never divides by zero", () => {
    const b = rasterLayerBoundsN(raster(), 0, 0);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(Number.isFinite(b.w)).toBe(true);
  });
});

describe("hitTestRasterLayers", () => {
  test("hit inside the box returns the layer", () => {
    const hit = hitTestRasterLayers([raster({ id: "A" })], 0.25, 0.25, 200, 100);
    expect(hit).toEqual({ id: "A", zIndex: 1 });
  });

  test("miss outside the box returns null", () => {
    expect(hitTestRasterLayers([raster({ id: "A" })], 0.9, 0.9, 200, 100)).toBeNull();
  });

  test("topmost (last in z-ascending list) wins on overlap", () => {
    // Both cover the whole canvas; B is later in the list (higher z) → wins.
    const A = raster({ id: "A", z_index: 1, transform: [2, 0, 0, 2, 0, 0] });
    const B = raster({ id: "B", z_index: 2, transform: [2, 0, 0, 2, 0, 0] });
    const hit = hitTestRasterLayers([A, B], 0.5, 0.5, 200, 100);
    expect(hit?.id).toBe("B");
  });

  test("padN tolerance lets an edge-adjacent click land", () => {
    // Box right edge at x=0.5; a click just past it misses without pad,
    // hits with a small pad.
    const r = [raster({ id: "A" })];
    expect(hitTestRasterLayers(r, 0.51, 0.25, 200, 100)).toBeNull();
    expect(hitTestRasterLayers(r, 0.51, 0.25, 200, 100, 0.02)?.id).toBe("A");
  });

  test("empty list returns null", () => {
    expect(hitTestRasterLayers([], 0.5, 0.5, 200, 100)).toBeNull();
  });
});
