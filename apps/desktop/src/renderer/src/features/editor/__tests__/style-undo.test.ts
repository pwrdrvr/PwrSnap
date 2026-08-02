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
});
