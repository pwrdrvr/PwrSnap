// Tests for forwardOpToStored — the dispatch wrapper that maps a draw/
// move made on the HIDDEN-crop (full-image) view back into stored
// (cropped) coordinate space. The centered crop fixture keeps source
// x∈[0.2,0.8] (rect = {x:0.2,y:0,w:0.6,h:1}); a source coord 0.5 stores
// at (0.5-0.2)/0.6 = 0.5, a source coord 0.02 stores at -0.3.

import { describe, it, expect } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { forwardOpToStored } from "../crop-edit-space";
import type { LayerEditOp } from "../useCaptureModel";

const RECT = { x: 0.2, y: 0, w: 0.6, h: 1 };
const NW = 800;
const NH = 600;

function vectorNode(x: number, y: number, w: number, h: number): BundleLayerNode {
  return {
    id: "0123456789abcdef",
    parent_id: "root000000000000",
    name: "rect",
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
    kind: "vector",
    shape: { kind: "shape", shapeKind: "rectangle", rect: { x, y, w, h }, style: {} }
  } as unknown as BundleLayerNode;
}

describe("forwardOpToStored", () => {
  it("upsert: maps a drawn node's shape coords into stored space", () => {
    const op: LayerEditOp = { kind: "upsert", node: vectorNode(0.5, 0.3, 0.12, 0.2), bumpZIndexToMax: true };
    const out = forwardOpToStored(op, RECT, NW, NH);
    expect(out.kind).toBe("upsert");
    const node = (out as Extract<LayerEditOp, { kind: "upsert" }>).node as Extract<
      BundleLayerNode,
      { kind: "vector" }
    >;
    const shape = node.shape as Extract<typeof node.shape, { kind: "shape" }>;
    expect(shape.rect.x).toBeCloseTo(0.5, 10);
    expect(shape.rect.w).toBeCloseTo(0.2, 10); // 0.12 / 0.6
  });

  it("upsert: a draw in the revealed margin stores out-of-[0,1] (clips when shown)", () => {
    const op: LayerEditOp = { kind: "upsert", node: vectorNode(0.02, 0.3, 0.06, 0.1) };
    const out = forwardOpToStored(op, RECT, NW, NH);
    const node = (out as Extract<LayerEditOp, { kind: "upsert" }>).node as Extract<
      BundleLayerNode,
      { kind: "vector" }
    >;
    const shape = node.shape as Extract<typeof node.shape, { kind: "shape" }>;
    expect(shape.rect.x).toBeCloseTo(-0.3, 10); // (0.02-0.2)/0.6
  });

  it("updateGeometry arrow: both endpoints mapped", () => {
    const op: LayerEditOp = {
      kind: "updateGeometry",
      layerId: "a",
      geometry: { kind: "arrow", from: { x: 0.5, y: 0.5 }, to: { x: 0.8, y: 0.6 } }
    };
    const out = forwardOpToStored(op, RECT, NW, NH) as Extract<
      LayerEditOp,
      { kind: "updateGeometry" }
    >;
    expect(out.geometry.kind).toBe("arrow");
    const g = out.geometry as Extract<typeof out.geometry, { kind: "arrow" }>;
    expect(g.from.x).toBeCloseTo(0.5, 10);
    expect(g.to.x).toBeCloseTo(1.0, 10); // (0.8-0.2)/0.6
  });

  it("updateGeometry rect: rect mapped, rotation preserved", () => {
    const op: LayerEditOp = {
      kind: "updateGeometry",
      layerId: "a",
      geometry: { kind: "rect", rect: { x: 0.5, y: 0.3, w: 0.12, h: 0.2 }, rotation: 0.4 }
    };
    const out = forwardOpToStored(op, RECT, NW, NH) as Extract<
      LayerEditOp,
      { kind: "updateGeometry" }
    >;
    const g = out.geometry as Extract<typeof out.geometry, { kind: "rect" }>;
    expect(g.rect.x).toBeCloseTo(0.5, 10);
    expect(g.rect.w).toBeCloseTo(0.2, 10);
    expect(g.rotation).toBe(0.4);
  });

  it("delete / reorder pass through unchanged (no coords)", () => {
    const del: LayerEditOp = { kind: "delete", id: "x" };
    const reo: LayerEditOp = { kind: "reorder", layerId: "x", zIndex: 3000 };
    expect(forwardOpToStored(del, RECT, NW, NH)).toBe(del);
    expect(forwardOpToStored(reo, RECT, NW, NH)).toBe(reo);
  });
});
