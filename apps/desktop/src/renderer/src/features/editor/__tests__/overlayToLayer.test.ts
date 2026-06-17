// Unit tests for the Overlay → BundleLayerNode adapter used by the
// Phase 3.1 dual-format write path. Mirrors the mapping rules in
// `apps/desktop/src/main/persistence/v1-to-v2-doctor.ts`'s
// `synthesizeV2DocumentFromV1Overlays`, applied to ONE overlay at a
// time.

import { describe, expect, test } from "vitest";
import { BundleLayerNode as BundleLayerNodeSchema } from "@pwrsnap/shared";
import type { Overlay } from "@pwrsnap/shared";
import {
  findRootGroupId,
  overlayToBundleLayerNode
} from "../overlayToLayer";

const CANVAS = { width: 800, height: 600 };

describe("overlayToBundleLayerNode", () => {
  test("arrow → vector layer carries shape verbatim + zod-valid", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0.25, y: 0.5 },
      to: { x: 0.75, y: 0.5 },
      color: "#ff5f57",
      endStyle: "open-triangle",
      stemStyle: "dashed",
      doubleEnded: true
    };
    const result = overlayToBundleLayerNode(arrow, CANVAS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.layer.kind).toBe("vector");
    if (result.layer.kind !== "vector") throw new Error("kind");
    // Verbatim shape preservation is the load-bearing invariant —
    // any subtle drop (color, endStyle, etc.) would silently
    // regress the user's popover choices.
    expect(result.layer.shape).toEqual(arrow);
    expect(result.layer.parent_id).toBeNull();
    expect(result.layer.name).toBe("Arrow");
    // Round-trip through zod to guarantee the layer is a legal write.
    expect(() => BundleLayerNodeSchema.parse(result.layer)).not.toThrow();
  });

  test("rect / text / step become vector layers", () => {
    const cases: Array<{ overlay: Overlay; expectedName: string }> = [
      {
        overlay: { kind: "shape", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, color: "auto" },
        expectedName: "Rectangle"
      },
      {
        overlay: {
          kind: "text",
          point: { x: 0.5, y: 0.5 },
          body: "hello",
          size: "small",
          color: "#abcdef"
        },
        expectedName: "Text"
      },
      {
        overlay: { kind: "step", point: { x: 0.5, y: 0.5 }, index: 3 },
        expectedName: "Step"
      }
    ];
    for (const { overlay, expectedName } of cases) {
      const result = overlayToBundleLayerNode(overlay, CANVAS);
      expect(result.ok, `kind=${overlay.kind}`).toBe(true);
      if (!result.ok) continue;
      expect(result.layer.kind).toBe("vector");
      expect(result.layer.name).toBe(expectedName);
      if (result.layer.kind === "vector") {
        expect(result.layer.shape).toEqual(overlay);
      }
      expect(() => BundleLayerNodeSchema.parse(result.layer)).not.toThrow();
    }
  });

  test("highlight → effect layer with absolute canvas-px clip_rect", () => {
    const highlight: Overlay = {
      kind: "highlight",
      rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
      color: "#ff8a1f",
      opacity: 0.5,
      blend: "overlay"
    };
    const result = overlayToBundleLayerNode(highlight, CANVAS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.layer.kind).toBe("effect");
    if (result.layer.kind !== "effect") throw new Error("kind");
    expect(result.layer.name).toBe("Highlight");
    expect(result.layer.effect).toEqual({
      type: "highlight",
      tint_hex: "#ff8a1f",
      opacity: 0.5
    });
    expect(result.layer.clip_rect).toEqual({
      x: 0.1 * 800,
      y: 0.2 * 600,
      w: 0.5 * 800,
      h: 0.4 * 600
    });
    expect(() => BundleLayerNodeSchema.parse(result.layer)).not.toThrow();
  });

  test("blur → effect layer with absolute canvas-px clip_rect", () => {
    const blur: Overlay = {
      kind: "blur",
      rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
      style: "gaussian"
    };
    const result = overlayToBundleLayerNode(blur, CANVAS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.layer.kind).toBe("effect");
    if (result.layer.kind !== "effect") throw new Error("kind");
    expect(result.layer.effect.type).toBe("blur");
    expect(result.layer.clip_rect).not.toBeNull();
    expect(result.layer.clip_rect).toEqual({
      x: 0.1 * 800,
      y: 0.2 * 600,
      w: 0.5 * 800,
      h: 0.4 * 600
    });
    if (result.layer.effect.type === "blur") {
      // 1.5% of short-side (600) = 9, floored at 8 then rounded.
      expect(result.layer.effect.radius_px).toBeGreaterThanOrEqual(8);
      expect(result.layer.effect.radius_px).toBeLessThanOrEqual(200);
    }
    expect(() => BundleLayerNodeSchema.parse(result.layer)).not.toThrow();
  });

  test("crop projects to a VectorLayer with shape.kind === 'crop'", () => {
    // Pre-#110 this overlay kind was refused with
    // `crop_not_supported_on_v2`. Post-#110 the v2 crop dispatcher
    // ALSO records the crop in the layer tree (alongside the canvas-
    // dim shrink) so Reset and any future layer-panel surface can
    // see it. The compose pipeline still no-ops on the crop layer
    // (canvas-dim shrink is what actually clips); this layer's job
    // is to RECORD the crop in the tree.
    const crop: Overlay = {
      kind: "crop",
      rect: { x: 0, y: 0, w: 0.5, h: 0.5 }
    };
    const result = overlayToBundleLayerNode(crop, CANVAS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.layer.kind).toBe("vector");
    if (result.layer.kind === "vector") {
      expect(result.layer.shape.kind).toBe("crop");
      if (result.layer.shape.kind === "crop") {
        expect(result.layer.shape.rect).toEqual({
          x: 0,
          y: 0,
          w: 0.5,
          h: 0.5
        });
      }
      expect(result.layer.name).toBe("Crop");
    }
    expect(() => BundleLayerNodeSchema.parse(result.layer)).not.toThrow();
  });

  test("parentId override is honored on both vector and effect outputs", () => {
    const arrow: Overlay = {
      kind: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      color: "auto"
    };
    const ROOT = "root_group_id_xx"; // 16 chars to satisfy NanoId16 zod
    const arrowOut = overlayToBundleLayerNode(arrow, CANVAS, ROOT);
    expect(arrowOut.ok).toBe(true);
    if (!arrowOut.ok) throw new Error("unreachable");
    expect(arrowOut.layer.parent_id).toBe(ROOT);

    const blur: Overlay = {
      kind: "blur",
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      style: "gaussian"
    };
    const blurOut = overlayToBundleLayerNode(blur, CANVAS, ROOT);
    expect(blurOut.ok).toBe(true);
    if (!blurOut.ok) throw new Error("unreachable");
    expect(blurOut.layer.parent_id).toBe(ROOT);
  });

  test("each adapter call mints a fresh id (no collision risk on rapid clicks)", () => {
    const overlay: Overlay = {
      kind: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      color: "auto"
    };
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const r = overlayToBundleLayerNode(overlay, CANVAS);
      if (!r.ok) throw new Error("unexpected");
      ids.add(r.layer.id);
    }
    expect(ids.size).toBe(50);
  });
});

describe("findRootGroupId", () => {
  test("returns the unique root group's id when one exists", () => {
    const layers = [
      {
        id: "rootgroupid000000",
        parent_id: null,
        kind: "group" as const,
        collapsed: false,
        name: "Root",
        visible: true,
        locked: false,
        opacity: 1,
        blend_mode: "normal" as const,
        transform: [1, 0, 0, 1, 0, 0] as const,
        z_index: 0,
        source: "user" as const,
        ai_run_id: null,
        applied_at: new Date().toISOString(),
        rejected_at: null,
        superseded_by: null,
        created_at: new Date().toISOString()
      }
    ];
    // Cast: tests use loose typing for the layer fixture. The runtime
    // shape matches BundleLayerNode's group variant.
    expect(findRootGroupId(layers as never)).toBe("rootgroupid000000");
  });

  test("returns null on empty list", () => {
    expect(findRootGroupId([])).toBeNull();
  });
});
