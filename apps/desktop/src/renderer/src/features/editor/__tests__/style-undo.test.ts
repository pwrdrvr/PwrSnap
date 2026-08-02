// Regression coverage for selected-layer style undo. The renderer can
// receive another style click before its layer model refetches, so undo
// must use the update queue's actual predecessor rather than that stale
// render snapshot.

import { describe, expect, test } from "vitest";
import type { BundleLayerNode, Overlay, OverlayRow } from "@pwrsnap/shared";
import { layerStyleUpdate, previousStylePatchFromQueuedUpdate } from "../Editor";

function arrow(color: string): BundleLayerNode {
  return {
    id: "ly_arrow",
    parent_id: null,
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.8, y: 0.8 },
      color
    },
    name: "Arrow",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1000,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-08-02T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-08-02T00:00:00.000Z"
  };
}

function blur(style: "gaussian" | "pixelate" | "redact", radiusPx: number): BundleLayerNode {
  return {
    id: "ly_blur",
    parent_id: null,
    kind: "effect",
    effect: { type: "blur", style, radius_px: radiusPx },
    clip_rect: { x: 20, y: 10, w: 80, h: 40 },
    name: "Blur",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1000,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-08-02T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-08-02T00:00:00.000Z"
  };
}

function blurRow(): OverlayRow {
  return {
    id: "ly_blur",
    capture_id: "cap_1",
    data: {
      kind: "blur",
      rect: { x: 0.02, y: 0.01, w: 0.08, h: 0.04 },
      style: "pixelate",
      radiusPx: 18
    },
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    z_index: 1000,
    rejected_at: null,
    applied_at: "2026-08-02T00:00:00.000Z",
    superseded_by: null,
    created_at: "2026-08-02T00:00:00.000Z"
  };
}

function shapeLayer(
  shape: "rect" | "square" | "circle" | "oval" | "parallelogram",
  rect: { x: number; y: number; w: number; h: number }
): BundleLayerNode {
  return {
    id: "ly_shape",
    parent_id: null,
    kind: "vector",
    shape: {
      kind: "shape",
      shape,
      rect,
      color: "#ff5a5a"
    },
    name: "Shape",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1000,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-08-02T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-08-02T00:00:00.000Z"
  };
}

function shapeRow(rect: { x: number; y: number; w: number; h: number }): OverlayRow {
  return {
    id: "ly_shape",
    capture_id: "cap_1",
    data: {
      kind: "shape",
      shape: "rect",
      rect,
      color: "#ff5a5a"
    },
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    z_index: 1000,
    rejected_at: null,
    applied_at: "2026-08-02T00:00:00.000Z",
    superseded_by: null,
    created_at: "2026-08-02T00:00:00.000Z"
  };
}

describe("previousStylePatchFromQueuedUpdate", () => {
  test("uses the queued predecessor for a rapid repeated color edit", () => {
    const staleFallback: Partial<Overlay> = { kind: "arrow", color: "#28c840" };
    const previousPatch = previousStylePatchFromQueuedUpdate(
      // The first click has already committed red while the renderer still
      // displays the original green arrow. The second click chooses blue.
      arrow("#ff5a5a"),
      "color",
      { kind: "arrow", color: "#2489ff" },
      staleFallback,
      { widthPx: 1600, heightPx: 900 }
    );

    // The first Undo must take blue back to red, not all the way to the
    // stale green row that serviced both click handlers.
    expect(previousPatch).toEqual({ kind: "arrow", color: "#ff5a5a" });
  });

  test("maps blur control fields to persisted fields and preserves their queued undo state", () => {
    const dims = {
      sourceWidthPx: 1600,
      sourceHeightPx: 900,
      canvasWidthPx: 1600,
      canvasHeightPx: 900
    };
    const modeUpdate = layerStyleUpdate(blurRow(), "mode", "redact", dims);
    expect(modeUpdate).toEqual({
      patch: { kind: "blur", style: "redact" },
      fallbackPreviousPatch: { kind: "blur", style: "pixelate" },
      undoField: "style"
    });
    expect(
      previousStylePatchFromQueuedUpdate(
        blur("pixelate", 18),
        modeUpdate!.undoField,
        modeUpdate!.patch,
        modeUpdate!.fallbackPreviousPatch,
        { widthPx: 1600, heightPx: 900 }
      )
    ).toEqual({ kind: "blur", style: "pixelate" });

    const radiusUpdate = layerStyleUpdate(blurRow(), "radius", { mode: "auto" }, dims);
    expect(radiusUpdate).toEqual({
      patch: { kind: "blur", radiusPx: 14 },
      fallbackPreviousPatch: { kind: "blur", radiusPx: 18 },
      undoField: "radiusPx"
    });
    expect(
      previousStylePatchFromQueuedUpdate(
        blur("redact", 24),
        radiusUpdate!.undoField,
        radiusUpdate!.patch,
        radiusUpdate!.fallbackPreviousPatch,
        { widthPx: 1600, heightPx: 900 }
      )
    ).toEqual({ kind: "blur", radiusPx: 24 });
  });

  test("switching a rectangle to Circle atomically stores pixel-square bounds and undo", () => {
    const originalRect = { x: 0.1, y: 0.2, w: 0.6, h: 0.3 };
    // A 2:1 canvas makes equal normalized dimensions visibly wrong. The
    // centered 0.15 × 0.3 rect below is exactly 300 × 300 canvas pixels.
    const dims = {
      sourceWidthPx: 2000,
      sourceHeightPx: 1000,
      canvasWidthPx: 2000,
      canvasHeightPx: 1000
    };

    const circleUpdate = layerStyleUpdate(shapeRow(originalRect), "shape", "circle", dims);
    expect(circleUpdate?.patch.kind).toBe("shape");
    if (circleUpdate?.patch.kind !== "shape" || circleUpdate.patch.rect === undefined) {
      throw new Error("Circle update should include its normalized bounds");
    }
    const constrainedRect = circleUpdate.patch.rect;
    expect(circleUpdate.patch.shape).toBe("circle");
    expect(constrainedRect.x).toBeCloseTo(0.325);
    expect(constrainedRect.y).toBeCloseTo(0.2);
    expect(constrainedRect.w).toBeCloseTo(0.15);
    expect(constrainedRect.h).toBeCloseTo(0.3);
    expect(circleUpdate.fallbackPreviousPatch).toEqual({
      kind: "shape",
      shape: "rect",
      rect: originalRect
    });
    expect(circleUpdate.undoField).toBe("shape");

    // The second click is served by the still-stale rectangular render, but
    // its undo must recover the Circle and its already-normalized geometry
    // from the write queue's actual predecessor.
    const squareUpdate = layerStyleUpdate(shapeRow(originalRect), "shape", "square", dims);
    expect(
      previousStylePatchFromQueuedUpdate(
        shapeLayer("circle", constrainedRect),
        squareUpdate!.undoField,
        squareUpdate!.patch,
        squareUpdate!.fallbackPreviousPatch,
        { widthPx: 2000, heightPx: 1000 }
      )
    ).toEqual({ kind: "shape", shape: "circle", rect: constrainedRect });
  });
});
