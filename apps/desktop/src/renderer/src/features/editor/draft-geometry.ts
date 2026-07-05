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

// Per-axis tolerance in PIXELS. EFFECT layers (highlight / blur) persist
// geometry as a `clip_rect` in absolute canvas pixels, so a committed
// move round-trips through `round(normalized × dim)` and back — the
// persisted normalized value can differ from the override by up to
// ~0.5px, which a unitless epsilon (1e-6) is far tighter than.
//
// This is DEFENSIVE rather than a fix for an observed bug: today an
// effect-layer override also clears via the id-churn branch in
// pruneLandedDraftGeometry. But vector `updateGeometry` already PRESERVES
// the id, and if an effect update ever did the same, the tight epsilon
// would never match and the override would linger (no clip, masked
// undo). 1px of slack absorbs the rounding and is still ~half the no-drag
// threshold (0.002), so it never false-matches a real drag.
const PIXEL_TOLERANCE = 1;

function makeNear(
  canvasWidthPx: number,
  canvasHeightPx: number
): (a: number, b: number, axis: "x" | "y") => boolean {
  const epsX = PIXEL_TOLERANCE / Math.max(1, canvasWidthPx);
  const epsY = PIXEL_TOLERANCE / Math.max(1, canvasHeightPx);
  return (a, b, axis) => Math.abs(a - b) <= (axis === "x" ? epsX : epsY);
}

/** True when a persisted overlay's geometry has caught up to a live-drag
 *  override — i.e. the drag committed AND the refetch landed, so the
 *  override is now a redundant no-op that must be dropped. Compares the
 *  positional fields the override carries (with ~1px tolerance to absorb
 *  the px round-trip of effect-layer clip_rects), plus rotation when the
 *  override specifies it (a rotation-only drag leaves position equal but
 *  changes the angle, so positions alone would clear the override too
 *  early). */
export function overlayMatchesDraftGeometry(
  data: Overlay,
  geom: GeometryUpdate,
  canvasWidthPx: number,
  canvasHeightPx: number
): boolean {
  const near = makeNear(canvasWidthPx, canvasHeightPx);
  switch (geom.kind) {
    case "arrow":
      return (
        data.kind === "arrow" &&
        near(data.from.x, geom.from.x, "x") &&
        near(data.from.y, geom.from.y, "y") &&
        near(data.to.x, geom.to.x, "x") &&
        near(data.to.y, geom.to.y, "y")
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
        !near(data.rect.x, geom.rect.x, "x") ||
        !near(data.rect.y, geom.rect.y, "y") ||
        !near(data.rect.w, geom.rect.w, "x") ||
        !near(data.rect.h, geom.rect.h, "y")
      ) {
        return false;
      }
      return (
        geom.rotation === undefined ||
        Math.abs(readOverlayRotation(data) - geom.rotation) <= 1e-4
      );
    }
    case "text": {
      if (data.kind !== "text") return false;
      if (
        !near(data.point.x, geom.point.x, "x") ||
        !near(data.point.y, geom.point.y, "y")
      ) {
        return false;
      }
      return (
        geom.rotation === undefined ||
        Math.abs(readOverlayRotation(data) - geom.rotation) <= 1e-4
      );
    }
    case "step":
      return (
        data.kind === "step" &&
        near(data.point.x, geom.point.x, "x") &&
        near(data.point.y, geom.point.y, "y")
      );
    case "transform":
      // Raster-only geometry — never carried by an overlay draft
      // override (raster live-drag rides RasterLayers' draftTransforms).
      return false;
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
  overlays: readonly OverlayRow[],
  canvasWidthPx: number,
  canvasHeightPx: number
): ReadonlyMap<string, GeometryUpdate> | null {
  if (draft.size === 0) return null;
  // This runs on EVERY drag frame (the override changes on each
  // pointermove), so don't allocate a Map over the whole — usually
  // large — `overlays` list. The override map is tiny (typically one
  // entry), so resolve only its ids with a single pass over `overlays`,
  // stopping as soon as every override id has matched a row.
  const rowById = new Map<string, OverlayRow>();
  for (const row of overlays) {
    if (draft.has(row.id)) {
      rowById.set(row.id, row);
      if (rowById.size === draft.size) break; // found them all
    }
  }
  // Clone lazily — most frames during a drag drop NOTHING (the persisted
  // geometry hasn't caught up yet), so we return the same `draft` ref and
  // the caller skips a no-op setState (no render loop).
  let next: Map<string, GeometryUpdate> | null = null;
  for (const [id, geom] of draft) {
    const row = rowById.get(id);
    const landedOrGone =
      row === undefined || // row gone (v1 delete-plus-insert id churn)
      overlayMatchesDraftGeometry(row.data, geom, canvasWidthPx, canvasHeightPx);
    if (landedOrGone) {
      if (next === null) next = new Map(draft);
      next.delete(id);
    }
  }
  if (next === null) return draft; // nothing dropped
  return next.size > 0 ? next : null;
}
