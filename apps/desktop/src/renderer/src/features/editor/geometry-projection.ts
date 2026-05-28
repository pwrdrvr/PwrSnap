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
      // Rotation is an OPTIONAL field on the geometry update — present
      // when the rotation handle is in flight, absent for a body drag
      // or a resize. Omitting means "leave the persisted rotation
      // alone"; setting overwrites. Without this branch, dragging the
      // rotation handle of a rect/highlight/blur left the glyph
      // un-rotated until pointerup (the SelectionOutline rotated via
      // its own merged copy, but the rendered glyph snapped back
      // because this helper dropped the rotation field).
      return {
        ...data,
        rect: geometry.rect,
        ...(geometry.rotation !== undefined ? { rotation: geometry.rotation } : {})
      };
    case "text":
      if (data.kind !== "text") return null;
      // Same shape as rect — optional rotation, point always
      // overwritten. The TextHtmlOverlays live-override path depends
      // on this thread-through so the HTML glyph rotates with the
      // user's drag (without it, only the SelectionOutline rotates
      // while the text snaps to the new rotation on pointerup —
      // visible divergence the user reported as "text rotation is
      // not live anymore").
      return {
        ...data,
        point: geometry.point,
        ...(geometry.rotation !== undefined ? { rotation: geometry.rotation } : {})
      };
    case "step":
      if (data.kind !== "step") return null;
      return { ...data, point: geometry.point };
  }
}
