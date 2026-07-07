// Unit tests for the cross-capture paste placement math. The integration
// round-trip in apps/desktop exercises this end-to-end; these pin the pure
// function's contract directly — especially the IDENTITY GUARANTEE that
// keeps same-size paste 1:1.

import { describe, expect, test } from "vitest";

import {
  computePlacement,
  placeLayerIntoTarget,
  type LayerPlacement
} from "../clipboard-placement";
import type { BundleLayerNode } from "../bundle-manifest-schema-v2";

const COMMON = {
  parent_id: null,
  name: "",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal" as const,
  transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
  z_index: 0,
  source: "user" as const,
  ai_run_id: null,
  applied_at: null,
  rejected_at: null,
  superseded_by: null,
  created_at: "2026-01-01T00:00:00.000Z"
};

function raster(transform: [number, number, number, number, number, number]): BundleLayerNode {
  return {
    ...COMMON,
    id: "raaaaaaaaaaaaaaa",
    kind: "raster",
    transform,
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 60,
    natural_height_px: 40
  };
}

describe("computePlacement", () => {
  test("same dims → identity (scale 1, origin 0)", () => {
    const p = computePlacement({ widthPx: 100, heightPx: 80 }, { widthPx: 100, heightPx: 80 });
    expect(p.scale).toBe(1);
    expect(p.originXPx).toBe(0);
    expect(p.originYPx).toBe(0);
    expect(p.targetWidthPx).toBe(100);
    expect(p.targetHeightPx).toBe(80);
  });

  test("smaller source → native size (scale capped at 1), centered", () => {
    const p = computePlacement({ widthPx: 60, heightPx: 40 }, { widthPx: 200, heightPx: 160 });
    expect(p.scale).toBe(1);
    expect(p.targetWidthPx).toBe(60);
    expect(p.targetHeightPx).toBe(40);
    expect(p.originXPx).toBe(70);
    expect(p.originYPx).toBe(60);
  });

  test("larger source → scale-to-fit preserving aspect, centered on the tight axis", () => {
    const p = computePlacement({ widthPx: 400, heightPx: 300 }, { widthPx: 100, heightPx: 80 });
    expect(p.scale).toBeCloseTo(0.25, 6); // min(100/400, 80/300)
    expect(p.targetWidthPx).toBeCloseTo(100, 6);
    expect(p.targetHeightPx).toBeCloseTo(75, 6);
    expect(p.originXPx).toBeCloseTo(0, 6);
    expect(p.originYPx).toBeCloseTo(2.5, 6);
  });

  test("degenerate dims fall back to identity-ish placement (no NaN)", () => {
    const p = computePlacement({ widthPx: 0, heightPx: 40 }, { widthPx: 100, heightPx: 80 });
    expect(p.scale).toBe(1);
    expect(Number.isFinite(p.originXPx)).toBe(true);
  });
});

describe("placeLayerIntoTarget", () => {
  const target = { widthPx: 200, heightPx: 160 };
  const native: LayerPlacement = computePlacement({ widthPx: 60, heightPx: 40 }, target);

  test("raster: scale folds into the matrix, origin offsets the translate", () => {
    const placed = placeLayerIntoTarget(raster([1, 0, 0, 1, 0, 0]), native, target);
    if (placed.kind !== "raster") throw new Error("expected raster");
    expect([...placed.transform]).toEqual([1, 0, 0, 1, 70, 60]);
    // natural dims are untouched — the placement scale lives in the matrix.
    expect(placed.natural_width_px).toBe(60);
    expect(placed.natural_height_px).toBe(40);
  });

  test("raster: scale-down composes onto an existing translate", () => {
    const smallTarget = { widthPx: 100, heightPx: 80 };
    const p = computePlacement({ widthPx: 400, heightPx: 300 }, smallTarget); // scale 0.25, origin (0, 2.5)
    const placed = placeLayerIntoTarget(raster([1, 0, 0, 1, 8, 8]), p, smallTarget);
    if (placed.kind !== "raster") throw new Error("expected raster");
    expect(placed.transform[0]).toBeCloseTo(0.25, 6);
    expect(placed.transform[3]).toBeCloseTo(0.25, 6);
    expect(placed.transform[4]).toBeCloseTo(0 + 8 * 0.25, 6); // 2
    expect(placed.transform[5]).toBeCloseTo(2.5 + 8 * 0.25, 6); // 4.5
  });

  test("vector: normalized coords remap into the placement rect", () => {
    const shape: BundleLayerNode = {
      ...COMMON,
      id: "vaaaaaaaaaaaaaaa",
      kind: "vector",
      shape: { kind: "shape", rect: { x: 0.2, y: 0.25, w: 0.5, h: 0.4 }, color: "auto" }
    };
    const placed = placeLayerIntoTarget(shape, native, target);
    if (placed.kind !== "vector" || placed.shape.kind !== "shape") {
      throw new Error("expected shape vector");
    }
    // placement rect in B-normalized = [0.35, 0.375, 0.3, 0.25]
    expect(placed.shape.rect.x).toBeCloseTo(0.41, 6); // 0.35 + 0.2*0.3
    expect(placed.shape.rect.y).toBeCloseTo(0.4375, 6); // 0.375 + 0.25*0.25
    expect(placed.shape.rect.w).toBeCloseTo(0.15, 6); // 0.5*0.3
    expect(placed.shape.rect.h).toBeCloseTo(0.1, 6); // 0.4*0.25
  });

  test("effect: clip_rect (absolute canvas px) scales + offsets", () => {
    const effect: BundleLayerNode = {
      ...COMMON,
      id: "eaaaaaaaaaaaaaaa",
      kind: "effect",
      transform: [1, 0, 0, 1, 0, 0],
      effect: { type: "blur", radius_px: 8 },
      clip_rect: { x: 10, y: 5, w: 20, h: 12 }
    };
    const smallTarget = { widthPx: 100, heightPx: 80 };
    const p = computePlacement({ widthPx: 400, heightPx: 300 }, smallTarget); // scale 0.25, origin (0, 2.5)
    const placed = placeLayerIntoTarget(effect, p, smallTarget);
    if (placed.kind !== "effect" || placed.clip_rect === null) {
      throw new Error("expected effect with clip_rect");
    }
    expect(placed.clip_rect.x).toBeCloseTo(0 + 10 * 0.25, 6); // 2.5
    expect(placed.clip_rect.y).toBeCloseTo(2.5 + 5 * 0.25, 6); // 3.75
    expect(placed.clip_rect.w).toBeCloseTo(20 * 0.25, 6); // 5
    expect(placed.clip_rect.h).toBeCloseTo(12 * 0.25, 6); // 3
  });

  test("IDENTITY GUARANTEE: same-size placement is a spatial no-op", () => {
    const sameTarget = { widthPx: 100, heightPx: 80 };
    const identity = computePlacement(sameTarget, sameTarget);

    const r = placeLayerIntoTarget(raster([1, 0, 0, 1, 13, 7]), identity, sameTarget);
    if (r.kind !== "raster") throw new Error("expected raster");
    expect([...r.transform]).toEqual([1, 0, 0, 1, 13, 7]);

    const v: BundleLayerNode = {
      ...COMMON,
      id: "vbbbbbbbbbbbbbbb",
      kind: "vector",
      shape: { kind: "text", point: { x: 0.42, y: 0.61 }, body: "x", size: "medium", color: "auto" }
    };
    const pv = placeLayerIntoTarget(v, identity, sameTarget);
    if (pv.kind !== "vector" || pv.shape.kind !== "text") throw new Error("expected text vector");
    expect(pv.shape.point.x).toBeCloseTo(0.42, 9);
    expect(pv.shape.point.y).toBeCloseTo(0.61, 9);
  });

  test("group is returned unchanged (no spatial surface)", () => {
    const group: BundleLayerNode = {
      ...COMMON,
      id: "gaaaaaaaaaaaaaaa",
      kind: "group",
      transform: [1, 0, 0, 1, 0, 0],
      collapsed: false
    };
    const placed = placeLayerIntoTarget(group, native, target);
    expect(placed).toBe(group);
  });
});
