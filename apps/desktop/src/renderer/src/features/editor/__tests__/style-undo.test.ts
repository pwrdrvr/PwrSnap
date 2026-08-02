// Regression coverage for selected-layer style undo. The renderer can
// receive another style click before its layer model refetches, so undo
// must use the update queue's actual predecessor rather than that stale
// render snapshot.

import { describe, expect, test } from "vitest";
import type { BundleLayerNode, Overlay } from "@pwrsnap/shared";
import { previousStylePatchFromQueuedUpdate } from "../Editor";

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
});
