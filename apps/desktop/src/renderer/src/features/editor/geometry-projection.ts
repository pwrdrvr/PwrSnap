// Local mirror of `applyGeometryToOverlay` (the useCaptureModel
// dispatcher's authoritative copy) — used to update in-component
// liveData during a TransformHandles drag without round-tripping
// through dispatchEdit, and to project the same in-progress geometry
// onto whatever the parent paints (OverlaySvg, BlurOverlays,
// TextHtmlOverlays) so the dragged glyph follows the cursor live.
//
// Sits in its own leaf module so every consumer imports from a neutral
// location. Pre-extraction this function lived in OverlaySvg.tsx; once
// TextHtmlOverlays needed the same projection (PR landing live-drag
// preview for HTML text), OverlaySvg stopped being a leaf and the
// "neighbor depends on OverlaySvg" pattern would have spread to every
// new overlay-painting surface.
//
// GeometryUpdate is re-exported from here for the same reason — every
// caller that imports `applyGeometryLocally` already needs the type,
// and routing it through this file keeps useCaptureModel imports out
// of the renderer overlay path.

import type { OverlayRow } from "@pwrsnap/shared";
import type { GeometryUpdate } from "./useCaptureModel";

export type { GeometryUpdate };

export function applyGeometryLocally(
  data: OverlayRow["data"],
  geometry: GeometryUpdate
): OverlayRow["data"] | null {
  switch (geometry.kind) {
    case "arrow":
      if (data.kind !== "arrow") return null;
      return { ...data, from: geometry.from, to: geometry.to };
    case "rect":
      if (data.kind !== "rect" && data.kind !== "highlight" && data.kind !== "blur") {
        return null;
      }
      return { ...data, rect: geometry.rect };
    case "text":
      if (data.kind !== "text") return null;
      return { ...data, point: geometry.point };
    case "step":
      if (data.kind !== "step") return null;
      return { ...data, point: geometry.point };
  }
}
