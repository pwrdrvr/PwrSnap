// Renderer-side Overlay → BundleLayerNode adapter for v2 captures.
//
// v2 is the only bundle format. `useCaptureModel` reads the layer tree
// via `layers:list`; this adapter is the WRITE side.
//
// This adapter is what `persistOverlay` calls to project the editor's
// drawn Overlay payloads (arrow/rect/text/highlight/blur) into v2
// BundleLayerNodes for `layers:upsert`. The renderer doesn't
// independently track v2-shape state — drag handlers produce normalized
// Overlays as the source of truth, and the adapter mints a fresh
// BundleLayerNode at commit time.
//
// Crop NO LONGER goes through this adapter. The v2-native crop semantic
// (Option A: data-layer crop via canvas_dimensions mutation) ships as
// a top-level `crop` op kind on `useCaptureModel.dispatchEdit` —
// onCropCommit in Editor.tsx routes there directly. The
// `crop_not_supported_on_v2` refusal below is defense in depth in case
// a caller accidentally hands a CropOverlay through the create path;
// the editor itself won't.
//
// TODO(phase-4-5): replace this adapter with a Layer-native write path
// that doesn't round-trip through the v1 Overlay shape.

import { nanoid } from "nanoid";
import type { BundleLayerNode, Overlay } from "@pwrsnap/shared";
import {
  readBlurRadiusPx,
  readHighlightColor,
  readHighlightOpacity,
  readShapeKind
} from "@pwrsnap/shared";

/** Canvas dimensions (source-pixel space) used to denormalize Overlay
 *  rects (which carry `[0,1]^2` fractions) into the absolute canvas
 *  coords v2 effect layers expect. */
export type CanvasDims = { width: number; height: number };

/** Optional adapter hint: the id of the v2 document's root group so
 *  new layers parent under it rather than sitting as document-level
 *  siblings. The caller derives this by scanning the loaded layer
 *  array for a `kind === "group"` with `parent_id === null` — there's
 *  exactly one such root in every doctor-synthesized v2 doc. Passing
 *  `null` leaves the new layer at the document root (still renders
 *  via the flat projection in Editor.tsx). */
export type ParentLayerId = string | null;

/** Result of a single Overlay → BundleLayerNode adaptation. Crop is
 *  returned as an error rather than a null so the call site can
 *  surface a typed problem the same way the bus-side validators do. */
export type OverlayToLayerResult =
  | { ok: true; layer: BundleLayerNode }
  | {
      ok: false;
      error: {
        kind: "validation";
        code: "crop_not_supported_on_v2" | "unknown_overlay_kind";
        message: string;
      };
    };

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Adapt a single v1 Overlay payload into a v2 BundleLayerNode suitable
 * for dispatch through `layers:upsert`. Coord conventions:
 *
 *   • vector layers carry the Overlay verbatim under `shape` and keep
 *     their normalized `[0,1]^2` coords — the v2 vector renderer
 *     multiplies by canvas dims at render time (see
 *     compose-tree-vector.ts on the bake path).
 *   • effect layers (blur / highlight) denormalize their rect into
 *     absolute canvas pixels for `clip_rect` — that's what the
 *     EffectLayer schema expects (`CanvasRect`).
 *
 * `parent_id` is set to `null` deliberately: the root group's id is a
 * server-side concept the renderer doesn't have in scope. The bus
 * accepts a null parent and reparents to the root on insert (today the
 * layers-repo INSERT honors whatever parent_id arrives; a follow-up
 * may explicitly reparent-to-root on null). For the Phase 3.1 fix,
 * top-level layers render correctly through the existing flat
 * `projectV2LayersToOverlayRows` projection.
 *
 * Crop is refused — there's no v2 vector or effect equivalent of a v1
 * CropOverlay. The v2 canvas-side crop semantic mutates
 * `canvas_dimensions` in the document and is Phase 4+ work.
 */
export function overlayToBundleLayerNode(
  overlay: Overlay,
  canvas: CanvasDims,
  parentId: ParentLayerId = null
): OverlayToLayerResult {
  const id = nanoid(16);
  const now = nowIso();

  // Crop IS a vector layer in v2 (was deferred to "Phase 4+" originally
  // but the dual-state — crop in captures.{width,height}_px AND crop
  // not in the layer tree — caused the Reset-can't-undo-crop class of
  // bugs (#109). Adding a crop VectorLayer makes the crop a first-class
  // layer-tree citizen: Reset's existing "delete user-facing layers"
  // loop wipes it naturally, undo through the layer model is symmetric
  // with every other layer mutation, and "is this capture cropped?"
  // becomes a layer-tree presence check instead of a captures-dim vs
  // raster-natural-dims comparison.
  //
  // The compose pipeline (compose-tree-vector.ts) already treats
  // `case "crop"` as a no-op composite — crop is consumed at the
  // canvas-dimension level by sharp's .extract(), not by painting
  // anything onto the accumulator. So adding this layer kind doesn't
  // change render output; it just gives the editor a place to RECORD
  // the crop in the layer tree alongside arrows / rects / etc.
  //
  // The dispatcher (useCaptureModel.ts v2 crop case) updates
  // captures.width_px/height_px alongside the layer insert — those
  // remain the authoritative canvas dims for downstream consumers
  // (library grid, export filename, render coordinator). Promoting
  // the layer tree to source-of-truth for canvas dims is a future
  // refactor; this PR closes the bug class without changing that
  // boundary.

  if (overlay.kind === "blur") {
    // Phase 3.4 — thread the v1 BlurOverlay's `style` field into the v2
    // BlurEffect. The v2 schema gained an optional `style` for exactly
    // this round-trip; without it, every committed blur would
    // re-project as gaussian regardless of what the user picked.
    const layer: BundleLayerNode = {
      id,
      parent_id: parentId,
      kind: "effect",
      effect: {
        type: "blur",
        radius_px: readBlurRadiusPx(overlay, canvas),
        ...(overlay.style !== undefined ? { style: overlay.style } : {}),
        ...(overlay.rotation !== undefined ? { rotation: overlay.rotation } : {})
      },
      clip_rect: {
        x: overlay.rect.x * canvas.width,
        y: overlay.rect.y * canvas.height,
        w: overlay.rect.w * canvas.width,
        h: overlay.rect.h * canvas.height
      },
      name: "Blur",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    };
    return { ok: true, layer };
  }

  if (overlay.kind === "highlight") {
    const layer: BundleLayerNode = {
      id,
      parent_id: parentId,
      kind: "effect",
      effect: {
        type: "highlight",
        tint_hex: readHighlightColor(overlay),
        opacity: readHighlightOpacity(overlay),
        ...(overlay.blend !== undefined ? { blend: overlay.blend } : {}),
        ...(overlay.rotation !== undefined ? { rotation: overlay.rotation } : {})
      },
      clip_rect: {
        x: overlay.rect.x * canvas.width,
        y: overlay.rect.y * canvas.height,
        w: overlay.rect.w * canvas.width,
        h: overlay.rect.h * canvas.height
      },
      name: "Highlight",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: now,
      rejected_at: null,
      superseded_by: null,
      created_at: now
    };
    return { ok: true, layer };
  }

  // arrow / shape / text / step — all carry the Overlay shape
  // verbatim under `shape`.
  const layer: BundleLayerNode = {
    id,
    parent_id: parentId,
    kind: "vector",
    shape: overlay,
    name: layerNameForVector(overlay),
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };
  return { ok: true, layer };
}

/**
 * Find the document root group's id in a flat layer list. The doctor
 * synthesizes exactly one `kind: "group"` layer with `parent_id: null`
 * per capture; a native v2 capture from a Phase 4+ surface follows the
 * same invariant. Returns `null` if no root group is found (caller should
 * fall back to `parent_id: null` on the new layer, which still renders
 * via the flat projection in Editor.tsx).
 */
export function findRootGroupId(layers: readonly BundleLayerNode[]): string | null {
  for (const layer of layers) {
    if (layer.kind === "group" && layer.parent_id === null) {
      return layer.id;
    }
  }
  return null;
}

/** Human-readable layer name for a vector overlay. Takes the full
 *  overlay (not just `kind`) so shape rows can pick a per-shape label
 *  ("Rectangle" / "Square" / "Circle" / "Oval" / "Parallelogram") off
 *  the `shape` discriminant. */
function layerNameForVector(
  overlay: Exclude<Overlay, { kind: "blur" | "highlight" }>
): string {
  switch (overlay.kind) {
    case "arrow":
      return "Arrow";
    case "shape": {
      const shapeLabels: Record<string, string> = {
        rect: "Rectangle",
        square: "Square",
        circle: "Circle",
        oval: "Oval",
        parallelogram: "Parallelogram"
      };
      return shapeLabels[readShapeKind(overlay)] ?? "Shape";
    }
    case "text":
      return "Text";
    case "step":
      return "Step";
    case "crop":
      // v2 crop is a VectorLayer with shape.kind === "crop" — same
      // tree-shape as arrow/shape/text. The compose pipeline no-ops
      // on it (canvas-dim shrink is what actually clips the
      // composite); the layer's job is to RECORD the crop in the
      // tree so Reset / undo / future layer-panel reads can see it.
      return "Crop";
  }
}
