// Renderer-side Overlay → BundleLayerNode adapter for v2 captures.
//
// Phase 2 of the v2 editor refresh made the READ path dual-format —
// `useCaptureModel` discovers `bundle_format_version` and dispatches
// either `overlays:list` or `layers:list`, then projects v2 layers back
// into the `OverlayRow[]` shape the renderer consumes. Phase 3 shipped
// the v1 → v2 lazy doctor, so any v1 capture is doctored to v2 on first
// edit-open.
//
// This adapter is what `persistOverlay` calls to project the editor's
// v1-shaped Overlay payloads (arrow/rect/text/highlight/blur) into v2
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

/** 1.5% of the canvas short-side, with an 8px floor. Mirrors
 *  `deriveBlurRadiusPx` in `apps/desktop/src/main/persistence/v1-to-v2-doctor.ts`
 *  so a freshly-drawn blur on a v2 capture has the same radius the
 *  doctor would have produced if the same overlay had been migrated
 *  from a v1 row. The clamp matches `BlurEffect.radius_px.lte(200)` in
 *  the v2 schema. */
function deriveBlurRadiusPx(canvas: CanvasDims): number {
  const shortSide = Math.min(canvas.width, canvas.height);
  return Math.max(1, Math.min(200, Math.max(8, Math.round(shortSide * 0.015))));
}

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
 *   • effect layers (blur) denormalize their rect into absolute canvas
 *     pixels for `clip_rect` — that's what the EffectLayer schema
 *     expects (`CanvasRect`).
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

  // Crop has no per-layer v2 representation. Refuse with a typed
  // validation error so the call site can surface it (and so future
  // call paths that DO support crop don't quietly inherit a misroute).
  if (overlay.kind === "crop") {
    return {
      ok: false,
      error: {
        kind: "validation",
        code: "crop_not_supported_on_v2",
        message:
          "v2 capture: crop overlay has no layer-tree equivalent; canvas-side crop is Phase 4+"
      }
    };
  }

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
        radius_px: deriveBlurRadiusPx(canvas),
        ...(overlay.style !== undefined ? { style: overlay.style } : {})
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

  // arrow / rect / highlight / text / step — all carry the v1 Overlay
  // shape verbatim under `shape`. Mirrors the migration path in
  // `synthesizeV2DocumentFromV1Overlays`.
  const layer: BundleLayerNode = {
    id,
    parent_id: parentId,
    kind: "vector",
    shape: overlay,
    name: layerNameForVector(overlay.kind),
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
 * per migrated capture (see `synthesizeV2DocumentFromV1Overlays`); a
 * native v2 capture from a Phase 4+ surface will follow the same
 * invariant. Returns `null` if no root group is found (caller should
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

/** Mirror of `layerNameForVector` in `v1-to-v2-doctor.ts`. Kept
 *  intentionally duplicated rather than importing across the
 *  renderer/main boundary — the doctor module is main-only and
 *  pulling it would yank node-only code into the renderer bundle. */
function layerNameForVector(
  kind: Exclude<Overlay["kind"], "crop" | "blur">
): string {
  switch (kind) {
    case "arrow":
      return "Arrow";
    case "rect":
      return "Rectangle";
    case "text":
      return "Text";
    case "highlight":
      return "Highlight";
    case "step":
      return "Step";
  }
}
