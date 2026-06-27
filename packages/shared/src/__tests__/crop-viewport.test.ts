// Contract tests for resolveCropViewport — the pure helper that turns a
// hidden crop layer into a full-image render viewport WITHOUT mutating
// stored coords. The headline property is stability: toggling the crop's
// visibility must be bit-stable (annotations never "walk"), because the
// projection reads only frozen storage and is never re-persisted.

import { describe, it, expect } from "vitest";
import type { BundleLayerNode } from "../bundle-manifest-schema-v2";
import {
  resolveCropViewport,
  inverseTransformOverlayByCrop,
  inverseCropRect,
  type CropRect
} from "../crop-viewport";

// --- Fixture builders ------------------------------------------------
// resolveCropViewport operates on already-typed nodes (no zod parsing),
// so these minimal builders just need the fields the math reads.

function common(over: Partial<BundleLayerNode> = {}): Record<string, unknown> {
  return {
    id: "0123456789abcdef",
    parent_id: "root000000000000",
    name: "layer",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1000,
    source: "user",
    ai_run_id: null,
    applied_at: null,
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

/** 800×600 source, translated by (tx,ty) so a crop window aligns to the
 *  canvas origin. */
function raster(tx: number, ty: number): BundleLayerNode {
  return {
    ...common({ id: "raster0000000000", transform: [1, 0, 0, 1, tx, ty] }),
    kind: "raster",
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 800,
    natural_height_px: 600
  } as unknown as BundleLayerNode;
}

/** A rectangle (shape) overlay at normalized cropped-canvas coords. */
function rectVector(id: string, x: number, y: number, w: number, h: number): BundleLayerNode {
  return {
    ...common({ id }),
    kind: "vector",
    shape: { kind: "shape", shapeKind: "rectangle", rect: { x, y, w, h }, style: {} }
  } as unknown as BundleLayerNode;
}

function cropLayer(visible: boolean): BundleLayerNode {
  return {
    ...common({ id: "crop000000000000", visible }),
    kind: "vector",
    shape: { kind: "crop", rect: { x: 0, y: 0, w: 1, h: 1 } }
  } as unknown as BundleLayerNode;
}

function effect(id: string, x: number, y: number, w: number, h: number): BundleLayerNode {
  return {
    ...common({ id }),
    kind: "effect",
    effect: { type: "highlight", tint_hex: "#ffee00", opacity: 0.4 },
    clip_rect: { x, y, w, h }
  } as unknown as BundleLayerNode;
}

// Centered horizontal crop: keep source x∈[0.2,0.8] (480px of 800),
// full height. Canvas origin shows source pixel 160 → raster tx = -160.
const CROPPED_W = 480;
const CROPPED_H = 600;
const RASTER = raster(-160, 0);
const EXPECTED_RECT: CropRect = { x: 0.2, y: 0, w: 0.6, h: 1 };

describe("resolveCropViewport — identity when crop is visible or absent", () => {
  it("crop visible → identity (cropped dims, same layer refs)", () => {
    const layers = [RASTER, rectVector("rect000000000000", 0.5, 0.5, 0.2, 0.2), cropLayer(true)];
    const vp = resolveCropViewport({ layers, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    expect(vp.uncropped).toBe(false);
    expect(vp.widthPx).toBe(CROPPED_W);
    expect(vp.heightPx).toBe(CROPPED_H);
    expect(vp.rect).toBeNull();
    // Same node references — nothing re-projected.
    expect(vp.layers[0]).toBe(RASTER);
    expect(vp.layers[1]).toBe(layers[1]);
  });

  it("no crop layer → identity", () => {
    const layers = [RASTER, rectVector("rect000000000000", 0.5, 0.5, 0.2, 0.2)];
    const vp = resolveCropViewport({ layers, canvasWidthPx: 800, canvasHeightPx: 600 });
    expect(vp.uncropped).toBe(false);
    expect(vp.widthPx).toBe(800);
  });
});

describe("resolveCropViewport — hidden crop reveals the full source", () => {
  const layers = [
    RASTER,
    rectVector("rect000000000000", 0.5, 0.3, 0.2, 0.2), // center of cropped canvas
    rectVector("margin0000000000", -0.3, 0.3, 0.1, 0.1), // in the cut-away LEFT margin
    effect("fx00000000000000", 100, 50, 40, 30),
    cropLayer(false)
  ];

  const vp = resolveCropViewport({ layers, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });

  it("reports the natural source dims + the source window rect", () => {
    expect(vp.uncropped).toBe(true);
    expect(vp.widthPx).toBe(800);
    expect(vp.heightPx).toBe(600);
    expect(vp.rect).toEqual(EXPECTED_RECT);
  });

  it("resets the raster's crop translate to the origin", () => {
    const r = vp.layers[0] as Extract<BundleLayerNode, { kind: "raster" }>;
    expect(r.transform[4]).toBe(0);
    expect(r.transform[5]).toBe(0);
  });

  it("maps a centered overlay to the source center (0.5*0.6+0.2 = 0.5)", () => {
    const v = vp.layers[1] as Extract<BundleLayerNode, { kind: "vector" }>;
    const shape = v.shape as Extract<typeof v.shape, { kind: "shape" }>;
    expect(shape.rect.x).toBeCloseTo(0.5, 10);
    expect(shape.rect.w).toBeCloseTo(0.12, 10); // 0.2 * 0.6
  });

  it("brings a margin overlay (stored x=-0.3) back into [0,1]: -0.3*0.6+0.2 = 0.02", () => {
    const v = vp.layers[2] as Extract<BundleLayerNode, { kind: "vector" }>;
    const shape = v.shape as Extract<typeof v.shape, { kind: "shape" }>;
    expect(shape.rect.x).toBeCloseTo(0.02, 10);
  });

  it("offsets an effect clip_rect by the crop origin in px (x: 100 + 0.2*800 = 260)", () => {
    const fx = vp.layers[3] as Extract<BundleLayerNode, { kind: "effect" }>;
    expect(fx.clip_rect?.x).toBeCloseTo(260, 6);
    expect(fx.clip_rect?.y).toBeCloseTo(50, 6); // y crop origin is 0
    expect(fx.clip_rect?.w).toBe(40); // sizes unchanged (no scale)
  });

  it("leaves the crop marker layer untouched (it paints nothing)", () => {
    const crop = vp.layers[4] as Extract<BundleLayerNode, { kind: "vector" }>;
    expect(crop.shape.kind).toBe("crop");
  });
});

describe("resolveCropViewport — STABILITY: toggling never makes annotations walk", () => {
  const stored = [
    RASTER,
    rectVector("rect000000000000", 0.5, 0.3, 0.2, 0.2),
    rectVector("margin0000000000", -0.3, 0.3, 0.1, 0.1),
    cropLayer(false)
  ];

  it("does not mutate the input layers", () => {
    const snapshot = JSON.stringify(stored);
    resolveCropViewport({ layers: stored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it("two resolves of the same stored tree are deep-equal (pure, no drift)", () => {
    const a = resolveCropViewport({ layers: stored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    const b = resolveCropViewport({ layers: stored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    expect(a.layers).toEqual(b.layers);
  });

  it("hide → show → hide returns to the exact same projection", () => {
    // Storage is the source of truth; only the crop's visible flag flips.
    const hidden1 = resolveCropViewport({ layers: stored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });

    const shownStored = stored.map((l) => (l.id === "crop000000000000" ? cropLayer(true) : l));
    const shown = resolveCropViewport({ layers: shownStored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    expect(shown.uncropped).toBe(false); // cropped view again

    const hidden2 = resolveCropViewport({ layers: stored, canvasWidthPx: CROPPED_W, canvasHeightPx: CROPPED_H });
    expect(hidden2.layers).toEqual(hidden1.layers);
  });
});

describe("input round-trip — drawing on the full image stores into cropped space", () => {
  it("source-space coords forward-map to stored space and back exactly", () => {
    const rect = EXPECTED_RECT;
    const inv = inverseCropRect(rect)!;
    // An overlay the user draws at source x=0.02 (in the revealed margin).
    const drawn = {
      kind: "shape" as const,
      shapeKind: "rectangle" as const,
      rect: { x: 0.02, y: 0.3, w: 0.1, h: 0.1 },
      style: {}
    };
    // Forward into stored (cropped) space for persistence:
    const stored = inverseTransformOverlayByCrop(drawn as never, rect)!;
    const storedRect = (stored as { rect: { x: number } }).rect;
    expect(storedRect.x).toBeCloseTo(-0.3, 10); // (0.02-0.2)/0.6

    // Re-project for display (what resolveCropViewport does):
    const shown = inverseTransformOverlayByCrop(stored, inv)!;
    const shownRect = (shown as { rect: { x: number; y: number } }).rect;
    expect(shownRect.x).toBeCloseTo(0.02, 10);
    expect(shownRect.y).toBeCloseTo(0.3, 10);
  });
});
