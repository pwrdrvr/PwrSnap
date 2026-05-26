// `useCaptureModel` — single data-access hook for the editor that
// branches the renderer on `record.bundle_format_version`. Returns a
// discriminated union: loading, error, loaded-v1 (overlays), or
// loaded-v2 (layers). The rendering code path can consume either
// format-specific data (`overlays` / `layers`) OR the synthesized
// uniform `LayerView` shape — whichever the call site finds clearer.
//
// Replaces the inline `library:byId` + `overlays:list` fetch loop that
// `Editor.tsx` currently maintains directly. The hook owns:
//
//   - the cancel-safety dance (single `cancelled` flag across both
//     dispatches and any subsequent re-fetch from event broadcasts),
//   - the format branch (`format: 1` → `overlays:list`,
//     `format >= 2` → `layers:list`),
//   - the overlay-to-LayerView shim (inlined here, not a separate
//     file, per code-simplicity-reviewer in the plan),
//   - the format-typed `dispatchEdit` so callers can write without
//     restating the format branch.
//
// Plan reference:
// docs/plans/2026-05-23-001-feat-v2-editor-plan.md Phase 2.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  err,
  type BundleLayerNode,
  type CaptureRecord,
  type Overlay,
  type OverlayRow,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { dispatch, subscribe } from "../../lib/pwrsnap";
import { findRootGroupId, overlayToBundleLayerNode } from "./overlayToLayer";

// ---- Geometry / patch op types -------------------------------------
//
// Phase 3.5 — transform handles + selected-layer style editing. The
// editor needs two new dispatchEdit verbs on top of the existing
// upsert / delete / replace / crop set:
//
//   • updateGeometry — drag the selected overlay's handles. Merges a
//     kind-specific positional/size patch into the overlay's
//     data.{from,to,rect,point}. v1 → overlays:upsert (insert-only
//     surface, but with the same row id the dispatcher re-uses to
//     replace via INSERT … ON CONFLICT semantics on the main side).
//     v2 → for vector kinds, merge into shape.data.* via layers:upsert
//     (same id round-trip); for blur effects, update clip_rect via
//     layers:upsert.
//
//   • updateOverlay — generic style patch dispatched by the selected-
//     layer style editor (popover writes through this when an overlay
//     is selected). Same dispatch shape as updateGeometry — fetch row
//     → merge patch into data.* → upsert with the original id.
//
// Both ops require the layer to ALREADY EXIST. The dispatcher first
// reads the current overlay/layer from the in-memory state (no IPC
// round-trip — the model has it cached), merges the patch, and
// re-dispatches the upsert. The events:overlays:changed broadcast
// triggers refetch and the renderer paints the new state.

/** Normalized [0,1]² point. Same shape as the on-disk Overlay's
 *  `from`/`to`/`point` fields. */
export type NormalizedPoint = { readonly x: number; readonly y: number };

/** Normalized [0,1]² rect — same shape as `CropRect`. Re-aliased here
 *  so call sites that update rectangular geometry can use a name that
 *  matches their intent. */
export type NormalizedRect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** Kind-tagged geometry update. The dispatcher narrows on `kind` to
 *  pick which Overlay fields to merge. Mirrors the OverlayKind taxonomy
 *  but compressed — rect/highlight/blur all use the same { rect } update
 *  because they all carry a `data.rect` field; text uses { point };
 *  arrow uses both endpoints; step uses { point }. */
export type GeometryUpdate =
  | { readonly kind: "arrow"; readonly from: NormalizedPoint; readonly to: NormalizedPoint }
  | { readonly kind: "rect"; readonly rect: NormalizedRect }
  | { readonly kind: "text"; readonly point: NormalizedPoint }
  | { readonly kind: "step"; readonly point: NormalizedPoint };

/** Generic patch applied to the overlay's `data.*` JSON. Only the
 *  fields present in the patch overwrite — every other field is left
 *  alone. The dispatcher does a shallow merge; nested objects (e.g.
 *  arrow.from) should be replaced wholesale, not deep-merged. */
export type OverlayPatch = Partial<Overlay>;

// ---- Public types ---------------------------------------------------

export type LayerMeta = {
  source: "user" | "codex" | "draft";
  aiRunId: string | null;
  zIndex: number;
  appliedAt: string | null;
  rejectedAt: string | null;
};

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

export type VectorGeometry =
  | { kind: "arrow"; from: Point; to: Point }
  | { kind: "rect"; rect: Rect }
  | { kind: "text"; point: Point; body: string; size: "small" | "medium" | "large" }
  | { kind: "step"; point: Point; index: number };

export type VectorStyle = {
  color: string;
};

export type EffectSpec =
  | { mode: "gaussian" | "pixelate" | "redact"; radius: "auto" | number }
  | { mode: "crop" }
  | { mode: "highlight"; opacity: number };

export type LayerView =
  | {
      kind: "vector";
      id: string;
      geometry: VectorGeometry;
      style: VectorStyle;
      meta: LayerMeta;
    }
  | {
      kind: "raster";
      id: string;
      bytesRef: string;
      transform: readonly number[];
      meta: LayerMeta;
    }
  | {
      kind: "effect";
      id: string;
      effect: EffectSpec;
      clipRect: Rect | null;
      meta: LayerMeta;
    }
  | {
      kind: "group";
      id: string;
      childIds: string[];
      meta: LayerMeta;
    };

/** Normalized [0,1]² rectangle in the CURRENT canvas's coordinate
 *  space. Used by `crop` ops. CropTool always normalizes before
 *  dispatching, so callers don't need to know the canvas dims. */
export type CropRect = { x: number; y: number; w: number; h: number };

/** Result of an `upsert` op that emits a fresh row/layer id (v1
 *  overlays:upsert returns the inserted row; v2 layers:upsert returns
 *  the inserted node). Surfaced so callers (notably useUndoRedo) can
 *  capture the artifact for replay on redo and inverse-delete on undo. */
export type EditUpsertArtifact =
  | { format: 1; row: OverlayRow }
  | { format: 2; node: BundleLayerNode };

/** Result of a `crop` op — the PREVIOUS canvas dims so the caller can
 *  stash them for undo. v1 records the previous source dims of the
 *  capture (which don't actually change, but we surface them so the
 *  undo plumbing has a uniform shape). v2 surfaces the previous
 *  width_px / height_px from the captures row. */
export type EditCropArtifact = {
  previousWidthPx: number;
  previousHeightPx: number;
};

export type OverlayEditOp =
  | { kind: "upsert"; row: OverlayRow }
  | { kind: "delete"; id: string }
  | { kind: "replace"; rows: OverlayRow[] }
  /** v1 crop: writes a normalized CropOverlay through overlays:upsert.
   *  v1 doesn't physically crop the source — the rect is stored for
   *  downstream consumers (export, baked composite) that may honor it
   *  in a future slice. */
  | { kind: "crop"; rect: CropRect }
  /** Phase 3.5 — drag the selected overlay's transform handles. The
   *  dispatcher reads the current row from the cached state, merges
   *  the geometry patch into `data.*` (kind-aware), and re-upserts
   *  through overlays:upsert with the SAME id so the row is replaced
   *  rather than duplicated. Refuses when `layerId` doesn't resolve
   *  (likely a stale selection after a delete-broadcast race). */
  | { kind: "updateGeometry"; layerId: string; geometry: GeometryUpdate }
  /** Phase 3.5 — generic style/data patch for the selected overlay.
   *  Used by the popover when an overlay is selected (the popover
   *  edits the SELECTED overlay's style, not the active tool's
   *  defaults). Same dispatch shape as updateGeometry — fetch row,
   *  shallow-merge `patch` into `data.*`, re-upsert with the original
   *  id. */
  | { kind: "updateOverlay"; layerId: string; patch: OverlayPatch };

export type LayerEditOp =
  | { kind: "upsert"; node: BundleLayerNode }
  | { kind: "delete"; id: string }
  | { kind: "upsertBatch"; nodes: BundleLayerNode[] }
  /** v2 crop: writes new canvas dimensions to the captures row via
   *  `bundle:updateCanvasDimensions`. The rect is normalized to the
   *  CURRENT canvas; the dispatcher multiplies by the current canvas
   *  dims to derive the new dims in source pixels.
   *
   *  Crop is currently an axis-aligned re-frame from (0, 0) — `rect.x`
   *  and `rect.y` are ignored. The crop UI honors that today (commits
   *  whatever rect the user picks; we collapse it to `w × h` here).
   *  Off-origin crops would also require translating every layer's
   *  transform; Phase 4-5 layers that on once the editor exposes
   *  positional crops. For now `w × h` defines the new canvas size. */
  | { kind: "crop"; rect: CropRect }
  /** Phase 3.5 — same semantic as the v1 op, applied to a v2 layer.
   *  For vector kinds, the dispatcher merges the geometry patch into
   *  `shape.*` (the on-disk v1 Overlay shape carried verbatim under
   *  the v2 VectorLayer); for blur/highlight effects, it updates
   *  `clip_rect` (renormalized to absolute canvas pixels). */
  | { kind: "updateGeometry"; layerId: string; geometry: GeometryUpdate }
  /** Phase 3.5 — generic style/data patch applied to a v2 layer. For
   *  vector kinds, merges into `shape.*`; for effect kinds, merges
   *  the relevant style fields into `effect.*` (e.g. blur style /
   *  highlight opacity). */
  | { kind: "updateOverlay"; layerId: string; patch: OverlayPatch };

export type CaptureModelLoading = {
  kind: "loading";
  captureId: string;
};

export type CaptureModelError = {
  kind: "error";
  captureId: string;
  message: string;
};

/** Discriminated by the op kind so callers can read the artifact
 *  without restating the op kind. `delete` resolves with `undefined`
 *  artifact (nothing to surface). `upsert` resolves with the fresh
 *  row/layer; `crop` resolves with the previous canvas dims (so the
 *  undo stack can stash them and reverse on ⌘Z). `update` (geometry
 *  + style) resolves with the PRE-PATCH row/layer so the undo stack
 *  can stash it for inverse replay on ⌘Z. */
export type EditOpResult =
  | { kind: "upsert"; artifact: EditUpsertArtifact }
  | { kind: "delete" }
  | { kind: "crop"; artifact: EditCropArtifact }
  | { kind: "update"; artifact: EditUpsertArtifact };

export type CaptureModelV1 = {
  kind: "loaded";
  format: 1;
  captureId: string;
  record: CaptureRecord;
  overlays: OverlayRow[];
  /** Synthesized format-agnostic view. The renderer can consume this
   *  without caring about v1 vs v2. */
  layers: LayerView[];
  dispatchEdit: (
    op: OverlayEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
};

export type CaptureModelV2 = {
  kind: "loaded";
  format: 2;
  captureId: string;
  record: CaptureRecord;
  layers: BundleLayerNode[];
  /** Same uniform view shape as v1. v2 layer nodes are already
   *  LayerView-compatible natively; the shim just projects them. */
  layersView: LayerView[];
  dispatchEdit: (
    op: LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
};

export type CaptureModel =
  | CaptureModelLoading
  | CaptureModelError
  | CaptureModelV1
  | CaptureModelV2;

// ---- Internal state shape ------------------------------------------

type FetchedState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "v1"; record: CaptureRecord; overlays: OverlayRow[] }
  | { kind: "v2"; record: CaptureRecord; layers: BundleLayerNode[] };

// ---- Shims (v1 overlays → LayerView; v2 layers → LayerView) --------
//
// Inlined per the plan's code-simplicity decision. Deleted in Phase 8
// when overlays go away entirely.

function overlayToLayerView(
  row: OverlayRow,
  sourceWidth: number,
  sourceHeight: number
): LayerView | null {
  const meta: LayerMeta = {
    source: row.source,
    aiRunId: row.ai_run_id,
    zIndex: row.z_index,
    appliedAt: row.applied_at,
    rejectedAt: row.rejected_at
  };
  const data = row.data;
  switch (data.kind) {
    case "arrow":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "arrow",
          from: { x: data.from.x * sourceWidth, y: data.from.y * sourceHeight },
          to: { x: data.to.x * sourceWidth, y: data.to.y * sourceHeight }
        },
        style: { color: typeof data.color === "string" ? data.color : "auto" },
        meta
      };
    case "rect":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "rect",
          rect: {
            x: data.rect.x * sourceWidth,
            y: data.rect.y * sourceHeight,
            w: data.rect.w * sourceWidth,
            h: data.rect.h * sourceHeight
          }
        },
        style: { color: typeof data.color === "string" ? data.color : "auto" },
        meta
      };
    case "highlight":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "rect",
          rect: {
            x: data.rect.x * sourceWidth,
            y: data.rect.y * sourceHeight,
            w: data.rect.w * sourceWidth,
            h: data.rect.h * sourceHeight
          }
        },
        style: { color: "yellow" },
        meta
      };
    case "blur": {
      const style = data.style ?? "gaussian";
      return {
        kind: "effect",
        id: row.id,
        effect: { mode: style, radius: "auto" },
        clipRect: {
          x: data.rect.x * sourceWidth,
          y: data.rect.y * sourceHeight,
          w: data.rect.w * sourceWidth,
          h: data.rect.h * sourceHeight
        },
        meta
      };
    }
    case "text":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "text",
          point: { x: data.point.x * sourceWidth, y: data.point.y * sourceHeight },
          body: data.body,
          size: data.size
        },
        style: { color: typeof data.color === "string" ? data.color : "auto" },
        meta
      };
    case "step":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "step",
          point: { x: data.point.x * sourceWidth, y: data.point.y * sourceHeight },
          index: data.index
        },
        style: { color: "auto" },
        meta
      };
    case "crop":
      return {
        kind: "effect",
        id: row.id,
        effect: { mode: "crop" },
        clipRect: {
          x: data.rect.x * sourceWidth,
          y: data.rect.y * sourceHeight,
          w: data.rect.w * sourceWidth,
          h: data.rect.h * sourceHeight
        },
        meta
      };
    default: {
      // Exhaustiveness check — adding a new overlay kind without
      // teaching the shim about it surfaces here at compile time.
      const _exhaustive: never = data;
      void _exhaustive;
      return null;
    }
  }
}

function layerNodeToLayerView(node: BundleLayerNode): LayerView {
  const meta: LayerMeta = {
    source: node.source,
    aiRunId: node.ai_run_id,
    zIndex: node.z_index,
    appliedAt: node.applied_at,
    rejectedAt: node.rejected_at
  };
  switch (node.kind) {
    case "raster":
      return {
        kind: "raster",
        id: node.id,
        bytesRef: node.source_ref.sha256,
        transform: node.transform,
        meta
      };
    case "group":
      return {
        kind: "group",
        id: node.id,
        // Children are computed by the consumer from the flat array via
        // parent_id pointers; we pass an empty list at this layer.
        childIds: [],
        meta
      };
    case "vector": {
      // Vector v2 layers carry the v1 Overlay shape verbatim under
      // `shape`. Project through the overlay shim using the canvas
      // dims implied by the transform's translate component as 1:1
      // since v2 coords are already in canvas pixels.
      const fakeRow: OverlayRow = {
        id: node.id,
        capture_id: "",
        data: node.shape as Overlay,
        schema_version: 1,
        created_at: node.created_at,
        applied_at: node.applied_at,
        rejected_at: node.rejected_at,
        superseded_by: node.superseded_by,
        ai_run_id: node.ai_run_id,
        source: node.source,
        z_index: node.z_index
      };
      // v2 vector coords are already canvas pixels, so pass 1 / 1 to
      // skip the normalization-to-pixels multiply.
      const view = overlayToLayerView(fakeRow, 1, 1);
      return (
        view ?? {
          kind: "vector",
          id: node.id,
          geometry: { kind: "rect", rect: { x: 0, y: 0, w: 0, h: 0 } },
          style: { color: "auto" },
          meta
        }
      );
    }
    case "effect": {
      const effect = node.effect;
      const clip = node.clip_rect;
      const clipRect: Rect | null =
        clip === null
          ? null
          : { x: clip.x, y: clip.y, w: clip.w, h: clip.h };
      if (effect.type === "blur") {
        return {
          kind: "effect",
          id: node.id,
          effect: { mode: "gaussian", radius: effect.radius_px },
          clipRect,
          meta
        };
      }
      // highlight effect
      return {
        kind: "effect",
        id: node.id,
        effect: { mode: "highlight", opacity: effect.opacity },
        clipRect,
        meta
      };
    }
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      throw new Error("unreachable: unknown layer node kind");
    }
  }
}

// ---- Geometry / patch merge helpers --------------------------------
//
// Phase 3.5 — shared by the v1 (overlay) and v2 (layer) dispatchers.
// The functions are intentionally pure and exported so the unit tests
// can assert behavior directly without spinning the full hook.

/** Apply a GeometryUpdate to an Overlay's geometry fields. Returns
 *  the merged Overlay, or null if the geometry kind doesn't match the
 *  overlay kind (caller surfaces a typed error). */
export function applyGeometryToOverlay(
  overlay: Overlay,
  geometry: GeometryUpdate
): Overlay | null {
  switch (geometry.kind) {
    case "arrow":
      if (overlay.kind !== "arrow") return null;
      return { ...overlay, from: geometry.from, to: geometry.to };
    case "rect":
      if (
        overlay.kind !== "rect" &&
        overlay.kind !== "highlight" &&
        overlay.kind !== "blur"
      ) {
        return null;
      }
      return { ...overlay, rect: geometry.rect };
    case "text":
      if (overlay.kind !== "text") return null;
      return { ...overlay, point: geometry.point };
    case "step":
      if (overlay.kind !== "step") return null;
      return { ...overlay, point: geometry.point };
  }
}

/** Apply a generic patch to an Overlay's data. The patch is shallow-
 *  merged into the overlay. Returns null if the patch kind mismatches
 *  the overlay kind (defense against the caller handing an arrow
 *  patch to a rect). */
export function applyPatchToOverlay(
  overlay: Overlay,
  patch: OverlayPatch
): Overlay | null {
  if (patch.kind !== undefined && patch.kind !== overlay.kind) {
    return null;
  }
  // Shallow merge — the patch's fields overwrite, every other field
  // is preserved verbatim. Cast through `unknown` to bypass the
  // discriminated-union narrowing since we've already verified the
  // kind compatibility above.
  return { ...overlay, ...patch } as Overlay;
}

/** Apply a GeometryUpdate to a BundleLayerNode. For vector layers
 *  we update the underlying `shape` (which carries the v1 Overlay
 *  shape verbatim). For blur/highlight effect layers, geometry
 *  updates target `clip_rect` — renormalized to absolute canvas
 *  pixels (the v2 EffectLayer.clip_rect contract). Returns a fresh
 *  node with a NEW id since the IPC surface requires the delete-
 *  plus-insert pair (the same-id insert collides on PRIMARY KEY).
 *  Returns null if the geometry kind doesn't fit the layer kind. */
export function applyGeometryToLayer(
  layer: BundleLayerNode,
  geometry: GeometryUpdate,
  canvas: { width: number; height: number }
): BundleLayerNode | null {
  if (layer.kind === "vector") {
    const merged = applyGeometryToOverlay(layer.shape, geometry);
    if (merged === null) return null;
    // Fresh id (the old layer is deleted in the same op).
    return { ...layer, id: nanoid(16), shape: merged };
  }
  if (layer.kind === "effect") {
    // Only rect-shaped geometry maps onto an effect's clip_rect.
    if (geometry.kind !== "rect") return null;
    return {
      ...layer,
      id: nanoid(16),
      clip_rect: {
        x: geometry.rect.x * canvas.width,
        y: geometry.rect.y * canvas.height,
        w: geometry.rect.w * canvas.width,
        h: geometry.rect.h * canvas.height
      }
    };
  }
  // group / raster: no Phase 3.5 surface.
  return null;
}

/** Apply a generic OverlayPatch to a BundleLayerNode. Vector layers
 *  merge into `shape`; effect layers project the patch's relevant
 *  fields into `effect.*` (blur style currently). Returns a fresh
 *  node with a new id (delete-plus-insert pattern); returns null
 *  when the patch doesn't fit the layer kind. */
export function applyPatchToLayer(
  layer: BundleLayerNode,
  patch: OverlayPatch,
  canvas: { width: number; height: number }
): BundleLayerNode | null {
  if (layer.kind === "vector") {
    const merged = applyPatchToOverlay(layer.shape, patch);
    if (merged === null) return null;
    return { ...layer, id: nanoid(16), shape: merged };
  }
  if (layer.kind === "effect") {
    // Map blur-overlay style patches onto effect.style.
    // (Highlight effect updates aren't in the v3.5 surface yet —
    // ToolStylePopover for selected highlights still routes through
    // overlays:upsert in v1; the v2 highlight effect doesn't have a
    // popover surface in this slice.)
    if (patch.kind === "blur" && layer.effect.type === "blur") {
      const styleUpdate = patch.style;
      const effect = layer.effect;
      const newEffect: typeof effect = {
        ...effect,
        ...(styleUpdate !== undefined ? { style: styleUpdate } : {})
      };
      // Apply rect part if present (treat as geometry).
      const next: BundleLayerNode = {
        ...layer,
        id: nanoid(16),
        effect: newEffect,
        clip_rect:
          patch.rect !== undefined
            ? {
                x: patch.rect.x * canvas.width,
                y: patch.rect.y * canvas.height,
                w: patch.rect.w * canvas.width,
                h: patch.rect.h * canvas.height
              }
            : layer.clip_rect
      };
      return next;
    }
    return null;
  }
  return null;
}

// ---- The hook -------------------------------------------------------

export function useCaptureModel(captureId: string): CaptureModel {
  const [state, setState] = useState<FetchedState>({ kind: "loading" });

  // refetch is recreated when captureId changes. Each invocation
  // re-discovers the bundle_format_version, so a Phase 3 doctor run
  // that flips a capture from v1 → v2 is picked up automatically.
  const refetch = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (isCancelled()) return;
      if (!recordResult.ok) {
        setState({ kind: "error", message: recordResult.error.message });
        return;
      }
      if (recordResult.value === null) {
        setState({
          kind: "error",
          message: `capture not found: ${captureId}`
        });
        return;
      }
      const record = recordResult.value;
      // Plan: use `>= 2` (kieran-typescript), not strict equality.
      // Anything below 1 is invalid; we treat it as an error to avoid
      // silent v1 fallback on a corrupt row.
      if (record.bundle_format_version < 1) {
        setState({
          kind: "error",
          message: `invalid bundle_format_version: ${record.bundle_format_version}`
        });
        return;
      }
      if (record.bundle_format_version >= 2) {
        const layersResult = await dispatch("layers:list", { captureId });
        if (isCancelled()) return;
        const layers =
          layersResult.ok && Array.isArray(layersResult.value)
            ? layersResult.value
            : [];
        setState({ kind: "v2", record, layers });
        return;
      }
      // v1
      const overlaysResult = await dispatch("overlays:list", { captureId });
      if (isCancelled()) return;
      const overlays =
        overlaysResult.ok && Array.isArray(overlaysResult.value)
          ? overlaysResult.value
          : [];
      setState({ kind: "v1", record, overlays });
    },
    [captureId]
  );

  // Initial fetch + on captureId change. Single cancelled flag covers
  // BOTH dispatches and any in-flight branching decision.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void refetch(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refetch]);

  // Re-fetch on overlays/layers broadcasts for this capture.
  // `events:overlays:changed` is fired by BOTH overlays-handlers AND
  // layers-handlers (see apps/desktop/src/main/handlers/layers-handlers.ts)
  // so subscribing to one channel covers both formats.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe("events:overlays:changed", (payload) => {
      const p = payload as { captureId?: string };
      if (p.captureId !== undefined && p.captureId !== captureId) return;
      void refetch(() => cancelled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, refetch]);

  // Re-fetch the record on captures:changed (covers bundle_format_version
  // flips post-Phase-3 doctor — the capture's IPC family may change
  // without an overlays/layers broadcast).
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = subscribe("events:captures:changed", (payload) => {
      const p = payload as { changedIds?: string[] };
      if (!Array.isArray(p.changedIds)) return;
      if (!p.changedIds.includes(captureId)) return;
      void refetch(() => cancelled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [captureId, refetch]);

  // Always-fresh ref to the resolved record so the dispatchers can
  // read the current canvas dims without forcing a re-creation every
  // time the record's `edits_version` ticks. The crop dispatcher
  // needs source dims; capturing them via useCallback deps would
  // invalidate the dispatchEdit reference on every refetch and could
  // strand a recorded-but-not-yet-replayed undo entry pointing at a
  // stale function.
  const recordRef = useRef<CaptureRecord | null>(null);
  if (state.kind === "v1" || state.kind === "v2") {
    recordRef.current = state.record;
  }

  // Phase 3.5 — always-fresh refs to the loaded overlays/layers so the
  // updateGeometry / updateOverlay dispatchers can read the CURRENT row
  // shape without an IPC round-trip (the model already has it cached).
  // Same rationale as `recordRef` above — we want the dispatchEdit
  // reference identity to stay stable across refetches.
  const overlaysRef = useRef<OverlayRow[]>([]);
  const layersRef = useRef<BundleLayerNode[]>([]);
  if (state.kind === "v1") {
    overlaysRef.current = state.overlays;
  }
  if (state.kind === "v2") {
    layersRef.current = state.layers;
  }

  // v1 edit dispatcher.
  const dispatchEditV1 = useCallback(
    async (op: OverlayEditOp): Promise<Result<EditOpResult, PwrSnapError>> => {
      switch (op.kind) {
        case "upsert": {
          const result = await dispatch("overlays:upsert", {
            captureId,
            overlay: op.row.data
          });
          if (!result.ok) return err(result.error);
          return {
            ok: true,
            value: {
              kind: "upsert",
              artifact: { format: 1, row: result.value }
            }
          };
        }
        case "delete": {
          const result = await dispatch("overlays:delete", { id: op.id });
          if (!result.ok) return err(result.error);
          return { ok: true, value: { kind: "delete" } };
        }
        case "replace": {
          // overlays:replace isn't in the bus today. Fall back to
          // per-row upserts so Phase 2 callers have a path; Phase 7
          // will wire a real replace verb if needed. The artifact we
          // surface is the LAST inserted row — single-shot undo will
          // only revert that one. Multi-row replace is Phase 7.
          let last: OverlayRow | null = null;
          for (const row of op.rows) {
            const result = await dispatch("overlays:upsert", {
              captureId,
              overlay: row.data
            });
            if (!result.ok) return err(result.error);
            last = result.value;
          }
          if (last === null) {
            return err({
              kind: "validation",
              code: "empty_replace",
              message: "replace op called with empty rows array"
            });
          }
          return {
            ok: true,
            value: { kind: "upsert", artifact: { format: 1, row: last } }
          };
        }
        case "crop": {
          // v1 crop is stored as a normal CropOverlay through
          // overlays:upsert. CropTool already normalizes the rect to
          // [0,1]² before dispatching, so we forward as-is.
          const result = await dispatch("overlays:upsert", {
            captureId,
            overlay: { kind: "crop", rect: op.rect }
          });
          if (!result.ok) return err(result.error);
          const record = recordRef.current;
          return {
            ok: true,
            value: {
              kind: "crop",
              artifact: {
                previousWidthPx: record?.width_px ?? 0,
                previousHeightPx: record?.height_px ?? 0
              }
            }
          };
        }
        case "updateGeometry": {
          // Phase 3.5 — fetch the current row, merge the geometry patch
          // into data.*, then DELETE the original + INSERT the merged
          // overlay. The overlays IPC surface is INSERT-only (no UPDATE
          // verb; see overlays-handlers.ts), so the visible "edit-in-
          // place" semantic is implemented as a soft-delete-plus-insert
          // pair. The new row has a fresh id; the caller updates its
          // selection model from the artifact. Returns the new row in
          // the artifact (`format: 1`); the inverse for undo is captured
          // by the caller stashing the PREVIOUS row separately.
          const current = overlaysRef.current.find(
            (r) => r.id === op.layerId
          );
          if (current === undefined) {
            return err({
              kind: "validation",
              code: "layer_not_found",
              message: `updateGeometry: no overlay with id ${op.layerId}`
            });
          }
          const merged = applyGeometryToOverlay(current.data, op.geometry);
          if (merged === null) {
            return err({
              kind: "validation",
              code: "geometry_kind_mismatch",
              message: `updateGeometry: cannot apply ${op.geometry.kind} geometry to overlay kind ${current.data.kind}`
            });
          }
          // Delete first, then insert. If the insert fails, the delete
          // already landed — the caller sees a missing overlay and the
          // user can redraw. Failing the other order (insert + delete)
          // would leave duplicate overlays on the canvas on partial
          // failure, which is worse.
          const delResult = await dispatch("overlays:delete", {
            id: op.layerId
          });
          if (!delResult.ok) return err(delResult.error);
          const insResult = await dispatch("overlays:upsert", {
            captureId,
            overlay: merged
          });
          if (!insResult.ok) return err(insResult.error);
          return {
            ok: true,
            value: {
              kind: "update",
              artifact: { format: 1, row: insResult.value }
            }
          };
        }
        case "updateOverlay": {
          // Phase 3.5 — generic style patch on the selected overlay.
          // Same delete-plus-insert pattern as updateGeometry above.
          const current = overlaysRef.current.find(
            (r) => r.id === op.layerId
          );
          if (current === undefined) {
            return err({
              kind: "validation",
              code: "layer_not_found",
              message: `updateOverlay: no overlay with id ${op.layerId}`
            });
          }
          const merged = applyPatchToOverlay(current.data, op.patch);
          if (merged === null) {
            return err({
              kind: "validation",
              code: "patch_kind_mismatch",
              message: `updateOverlay: patch kind does not match overlay kind ${current.data.kind}`
            });
          }
          const delResult = await dispatch("overlays:delete", {
            id: op.layerId
          });
          if (!delResult.ok) return err(delResult.error);
          const insResult = await dispatch("overlays:upsert", {
            captureId,
            overlay: merged
          });
          if (!insResult.ok) return err(insResult.error);
          return {
            ok: true,
            value: {
              kind: "update",
              artifact: { format: 1, row: insResult.value }
            }
          };
        }
        default: {
          const _exhaustive: never = op;
          void _exhaustive;
          return err({
            kind: "validation",
            code: "unknown_edit_op",
            message: "unknown overlay edit op kind"
          });
        }
      }
    },
    [captureId]
  );

  // v2 edit dispatcher. `layers:upsertBatch` isn't in the bus yet
  // (Phase 7 expands the surface per the plan); return a typed
  // not-yet-supported error rather than silently no-oping.
  const dispatchEditV2 = useCallback(
    async (op: LayerEditOp): Promise<Result<EditOpResult, PwrSnapError>> => {
      switch (op.kind) {
        case "upsert": {
          const result = await dispatch("layers:upsert", {
            captureId,
            layer: op.node
          });
          if (!result.ok) return err(result.error);
          return {
            ok: true,
            value: {
              kind: "upsert",
              artifact: { format: 2, node: result.value }
            }
          };
        }
        case "delete": {
          const result = await dispatch("layers:delete", { id: op.id });
          if (!result.ok) return err(result.error);
          return { ok: true, value: { kind: "delete" } };
        }
        case "upsertBatch":
          return err({
            kind: "validation",
            code: "v2_writes_not_yet_supported",
            message:
              "layers:upsertBatch is not in the IPC surface yet; Phase 7 ships it"
          });
        case "crop": {
          // v2 crop = TWO writes that together form the "I cropped" state:
          //
          //   1. A VectorLayer with shape.kind === "crop" inserted in the
          //      layer tree — same kind as any arrow/rect/text. Idempotent:
          //      any pre-existing crop VectorLayer is deleted first so we
          //      end up with exactly ONE active crop. The compose pipeline
          //      treats this layer as a no-op composite (canvas-dim shrink
          //      below is what actually clips the image); the layer's job
          //      is to RECORD the crop in the tree so Reset can wipe it
          //      via the normal "delete user-facing layers" loop and
          //      future undo / layer-panel reads can see it.
          //
          //   2. captures.{width,height}_px shrink via
          //      bundle:updateCanvasDimensions — the authoritative canvas
          //      dims for the bake (sharp's .extract()), library grid,
          //      export filename, etc. The handler refuses dims exceeding
          //      raster.natural so this is the validation gate.
          //
          // Pre-fix, only (2) happened; the crop was invisible to the layer
          // tree, which made Reset disabled when only a crop existed and
          // forced bespoke `recordCropRef` undo plumbing.  See #109.
          //
          // Order: layer ops first (best-effort, idempotent), then dim
          // update. If the dim update fails (e.g. rect would exceed
          // natural dims), the crop layer has already updated to reflect
          // the user's intent — they retry and the dim update succeeds
          // or the validation surfaces. If the dim update succeeds but
          // the layer ops failed: canvas is cropped but no layer in the
          // tree, which means Reset still works via the legacy dim-
          // comparison fallback added in EditToolbar's isV2Cropped.
          const record = recordRef.current;
          if (record === null) {
            return err({
              kind: "validation",
              code: "record_not_loaded",
              message: "crop op dispatched before record resolved"
            });
          }
          // Collapse to (0,0) + w×h here. Off-origin crops require
          // translating every layer's transform by (-rect.x, -rect.y)
          // — deferred to the layer-editor UI in Phase 4-5.
          const newWidth = Math.max(
            1,
            Math.round(op.rect.w * record.width_px)
          );
          const newHeight = Math.max(
            1,
            Math.round(op.rect.h * record.height_px)
          );

          // Step 1: wipe any prior crop VectorLayer (the existing one, if
          // a re-crop, would otherwise stack alongside the new one and
          // mean "the user has TWO crops" — not a meaningful state).
          const existingCrop = layersRef.current.find(
            (l) => l.kind === "vector" && l.shape.kind === "crop"
          );
          if (existingCrop !== undefined) {
            const delResult = await dispatch("layers:delete", {
              id: existingCrop.id
            });
            if (!delResult.ok) return err(delResult.error);
          }

          // Step 2: insert the fresh crop VectorLayer under the root
          // group. Skip silently when the tree has no root group (means
          // the doctor hasn't run yet; shouldn't happen at this point
          // but be defensive). Skip surfacing a layer-insert failure as
          // a hard dispatch error — the user-visible crop IS the canvas
          // shrink in step 3, and the absence of the layer record only
          // costs us a layer-tree-aware Reset path (the dim-comparison
          // fallback in EditToolbar.isV2Cropped still works).
          const rootId = findRootGroupId(layersRef.current);
          if (rootId !== null) {
            const layerResult = overlayToBundleLayerNode(
              { kind: "crop", rect: op.rect },
              { width: record.width_px, height: record.height_px },
              rootId
            );
            if (layerResult.ok) {
              await dispatch("layers:upsert", {
                captureId,
                layer: layerResult.layer
              });
            }
          }

          // Step 3: shrink the canvas dims — the authoritative crop signal
          // for the bake + downstream consumers. Failure here returns err;
          // the user retries.
          const result = await dispatch("bundle:updateCanvasDimensions", {
            captureId,
            widthPx: newWidth,
            heightPx: newHeight
          });
          if (!result.ok) return err(result.error);
          return {
            ok: true,
            value: {
              kind: "crop",
              artifact: {
                previousWidthPx: result.value.previousWidthPx,
                previousHeightPx: result.value.previousHeightPx
              }
            }
          };
        }
        case "updateGeometry": {
          // Phase 3.5 — v2 mirror of the v1 update path. layers:upsert
          // inserts a fresh row keyed on `node.id` (collision on the
          // same id), so the visible "edit-in-place" semantic is again
          // a delete-plus-insert pair. The new node carries a fresh id
          // (mintFreshLayerId) so the insert succeeds. Vector layers
          // merge into `shape.*`; effect layers (blur/highlight) merge
          // into `clip_rect` (renormalized to absolute canvas pixels
          // per the v2 EffectLayer.clip_rect contract).
          const record = recordRef.current;
          if (record === null) {
            return err({
              kind: "validation",
              code: "record_not_loaded",
              message: "updateGeometry: record not loaded"
            });
          }
          const current = layersRef.current.find((l) => l.id === op.layerId);
          if (current === undefined) {
            return err({
              kind: "validation",
              code: "layer_not_found",
              message: `updateGeometry: no layer with id ${op.layerId}`
            });
          }
          const merged = applyGeometryToLayer(current, op.geometry, {
            width: record.width_px,
            height: record.height_px
          });
          if (merged === null) {
            return err({
              kind: "validation",
              code: "geometry_kind_mismatch",
              message: `updateGeometry: cannot apply ${op.geometry.kind} geometry to layer kind ${current.kind}`
            });
          }
          const delResult = await dispatch("layers:delete", { id: op.layerId });
          if (!delResult.ok) return err(delResult.error);
          const insResult = await dispatch("layers:upsert", {
            captureId,
            layer: merged
          });
          if (!insResult.ok) return err(insResult.error);
          return {
            ok: true,
            value: {
              kind: "update",
              artifact: { format: 2, node: insResult.value }
            }
          };
        }
        case "updateOverlay": {
          // Phase 3.5 — v2 mirror of v1 updateOverlay. For vector
          // layers we merge into `shape`; for effect layers the
          // semantic patch maps onto `effect.*` (blur style /
          // highlight opacity etc.). Same delete-plus-insert pattern
          // as updateGeometry.
          const record = recordRef.current;
          if (record === null) {
            return err({
              kind: "validation",
              code: "record_not_loaded",
              message: "updateOverlay: record not loaded"
            });
          }
          const current = layersRef.current.find((l) => l.id === op.layerId);
          if (current === undefined) {
            return err({
              kind: "validation",
              code: "layer_not_found",
              message: `updateOverlay: no layer with id ${op.layerId}`
            });
          }
          const merged = applyPatchToLayer(current, op.patch, {
            width: record.width_px,
            height: record.height_px
          });
          if (merged === null) {
            return err({
              kind: "validation",
              code: "patch_kind_mismatch",
              message: `updateOverlay: patch does not apply to layer kind ${current.kind}`
            });
          }
          const delResult = await dispatch("layers:delete", { id: op.layerId });
          if (!delResult.ok) return err(delResult.error);
          const insResult = await dispatch("layers:upsert", {
            captureId,
            layer: merged
          });
          if (!insResult.ok) return err(insResult.error);
          return {
            ok: true,
            value: {
              kind: "update",
              artifact: { format: 2, node: insResult.value }
            }
          };
        }
        default: {
          const _exhaustive: never = op;
          void _exhaustive;
          return err({
            kind: "validation",
            code: "unknown_edit_op",
            message: "unknown layer edit op kind"
          });
        }
      }
    },
    [captureId]
  );

  // Project the fetched state into the public CaptureModel. Memoize
  // the LayerView synthesis so the renderer doesn't re-walk the array
  // on every consumer re-render.
  return useMemo<CaptureModel>(() => {
    if (state.kind === "loading") {
      return { kind: "loading", captureId };
    }
    if (state.kind === "error") {
      return { kind: "error", captureId, message: state.message };
    }
    if (state.kind === "v1") {
      const layers: LayerView[] = [];
      for (const row of state.overlays) {
        const view = overlayToLayerView(
          row,
          state.record.width_px,
          state.record.height_px
        );
        if (view !== null) layers.push(view);
      }
      return {
        kind: "loaded",
        format: 1,
        captureId,
        record: state.record,
        overlays: state.overlays,
        layers,
        dispatchEdit: dispatchEditV1
      };
    }
    // v2
    const layersView: LayerView[] = state.layers.map(layerNodeToLayerView);
    return {
      kind: "loaded",
      format: 2,
      captureId,
      record: state.record,
      layers: state.layers,
      layersView,
      dispatchEdit: dispatchEditV2
    };
  }, [state, captureId, dispatchEditV1, dispatchEditV2]);
}
