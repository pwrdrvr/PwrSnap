// Live-drag override ("draftGeometry") lifecycle helpers.
//
// When the user drags a layer, the editor paints a live preview by
// overriding the layer's geometry in a `Map<id, GeometryUpdate>`
// ("draftGeometry" / `liveOverride`). On pointer-up the move is
// committed via `dispatchEdit`, but the override is intentionally LEFT
// IN PLACE so the OLD row keeps painting at the NEW geometry until the
// broadcast → refetch lands — otherwise the glyph flashes back to the
// pre-drag position for one frame.
//
// The override must then be dropped once the persisted state has caught
// up. The original cleanup keyed on the dragged row's id DISAPPEARING
// from `overlays` — correct for v1, where a geometry edit was a
// delete-plus-insert that minted a NEW id. But v2's `updateGeometry`
// PRESERVES the layer id (`applyGeometryToLayer` keeps `layer.id`), so
// that signal never fires: the override lingers forever, and the NEXT
// undo/redo is MASKED — the committed data reverts, but the stale
// override keeps painting the dragged position, so the glyph appears
// stuck while the selection outline / handles / hit-test (which read the
// raw persisted data) sit at the reverted position. Repro: move a layer,
// then ⌘Z — the glyph doesn't move back.
//
// The fix: drop an override entry once the persisted geometry MATCHES it
// (the commit landed), independent of whether the id changed. These are
// pure functions so the lifecycle is unit-tested in isolation.

import { readOverlayRotation, type Overlay, type OverlayRow } from "@pwrsnap/shared";
import type { GeometryUpdate } from "./useCaptureModel";

const GEOMETRY_EPSILON = 1e-6;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= GEOMETRY_EPSILON;
}

/** True when a persisted overlay's geometry has caught up to a live-drag
 *  override — i.e. the drag committed AND the refetch landed, so the
 *  override is now a redundant no-op that must be dropped. Compares the
 *  positional fields the override carries, plus rotation when the
 *  override specifies it (a rotation-only drag leaves position equal but
 *  changes the angle, so positions alone would clear the override too
 *  early). */
export function overlayMatchesDraftGeometry(
  data: Overlay,
  geom: GeometryUpdate
): boolean {
  switch (geom.kind) {
    case "arrow":
      return (
        data.kind === "arrow" &&
        near(data.from.x, geom.from.x) &&
        near(data.from.y, geom.from.y) &&
        near(data.to.x, geom.to.x) &&
        near(data.to.y, geom.to.y)
      );
    case "rect": {
      // The `rect` geometry update targets shape / highlight / blur —
      // every overlay that carries a `data.rect`. (crop also has a rect
      // but isn't drag-edited through this path.)
      if (
        data.kind !== "shape" &&
        data.kind !== "highlight" &&
        data.kind !== "blur"
      ) {
        return false;
      }
      if (
        !near(data.rect.x, geom.rect.x) ||
        !near(data.rect.y, geom.rect.y) ||
        !near(data.rect.w, geom.rect.w) ||
        !near(data.rect.h, geom.rect.h)
      ) {
        return false;
      }
      return (
        geom.rotation === undefined ||
        near(readOverlayRotation(data), geom.rotation)
      );
    }
    case "text": {
      if (data.kind !== "text") return false;
      if (!near(data.point.x, geom.point.x) || !near(data.point.y, geom.point.y)) {
        return false;
      }
      return (
        geom.rotation === undefined ||
        near(readOverlayRotation(data), geom.rotation)
      );
    }
    case "step":
      return (
        data.kind === "step" &&
        near(data.point.x, geom.point.x) &&
        near(data.point.y, geom.point.y)
      );
  }
}

/** Prune a live-drag override map to only the entries STILL bridging the
 *  commit→refetch gap. An entry is dropped when:
 *   - its row is gone from `overlays` (v1 delete-plus-insert minted a
 *     new id), OR
 *   - the persisted row's geometry now matches the override (the commit
 *     landed). This is the v2 case the id-presence check missed — v2
 *     PRESERVES the id, so without the geometry check the override would
 *     linger and mask the next undo/redo.
 *  Returns the SAME map reference when nothing was dropped (so the caller
 *  can skip a no-op setState and avoid a render loop), a smaller map, or
 *  null when the map empties. */
export function pruneLandedDraftGeometry(
  draft: ReadonlyMap<string, GeometryUpdate>,
  overlays: readonly OverlayRow[]
): ReadonlyMap<string, GeometryUpdate> | null {
  const byId = new Map(overlays.map((row) => [row.id, row] as const));
  const next = new Map<string, GeometryUpdate>();
  for (const [id, geom] of draft) {
    const row = byId.get(id);
    if (row === undefined) continue; // row gone (v1 id churn)
    if (overlayMatchesDraftGeometry(row.data, geom)) continue; // commit landed
    next.set(id, geom); // still bridging — keep painting the override
  }
  // `pruneLandedDraftGeometry` only ever DROPS entries, so an unchanged
  // size means nothing was pruned — return the original ref to signal
  // "no change" and let the caller short-circuit.
  if (next.size === draft.size) return draft;
  return next.size > 0 ? next : null;
}
