// `useCaptureModel` — single data-access hook for the editor. v2 is
// the only bundle format, so a loaded capture is always v2 (layer
// tree). Returns a discriminated union: loading, error, or loaded
// (v2 layers). The rendering code path can consume the format-specific
// `layers` OR the synthesized uniform `LayerView` shape (`layersView`)
// — whichever the call site finds clearer.
//
// Replaces the inline `library:byId` + `layers:list` fetch loop that
// `Editor.tsx` currently maintains directly. The hook owns:
//
//   - the cancel-safety dance (single `cancelled` flag across both
//     dispatches and any subsequent re-fetch from event broadcasts),
//   - the `layers:list` fetch (a record with
//     `bundle_format_version < 2` is treated as an error — there are
//     no v1 captures left to read),
//   - the layer-node-to-LayerView shim (inlined here, not a separate
//     file, per code-simplicity-reviewer in the plan),
//   - the `dispatchEdit` so callers can write layer ops.
//
// Plan reference:
// docs/plans/2026-05-23-001-feat-v2-editor-plan.md Phase 2.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nanoid } from "nanoid";
import {
  err,
  readHighlightColor,
  readHighlightOpacity,
  readBlurRadiusPx,
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
// editor needs two dispatchEdit verbs on top of the upsert / delete /
// crop set:
//
//   • updateGeometry — drag the selected layer's handles. For vector
//     kinds, merge a kind-specific positional/size patch into
//     shape.{from,to,rect,point} via layers:upsert (delete-plus-insert
//     reusing the layer id — the upsert restores the soft-deleted row);
//     for blur effects, update clip_rect via layers:upsert.
//
//   • updateOverlay — generic style patch dispatched by the selected-
//     layer style editor (popover writes through this when a layer is
//     selected). Same dispatch shape as updateGeometry — fetch the
//     layer → merge patch → re-upsert.
//
// Both ops require the layer to ALREADY EXIST. The dispatcher first
// reads the current layer from the in-memory state (no IPC round-trip
// — the model has it cached), merges the patch, and re-dispatches the
// upsert. The events:overlays:changed broadcast triggers refetch and
// the renderer paints the new state.

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
  | {
      readonly kind: "rect";
      readonly rect: NormalizedRect;
      /** Optional clockwise rotation (radians) around the rect's
       *  geometric center. Omitted = "don't change rotation" (the
       *  merger preserves whatever the overlay currently has). The
       *  rotation handle drags pass this through. */
      readonly rotation?: number;
    }
  | {
      readonly kind: "text";
      readonly point: NormalizedPoint;
      /** Optional clockwise rotation (radians) around the anchor
       *  point. See `rect.rotation` above. */
      readonly rotation?: number;
    }
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
  | {
      mode: "highlight";
      opacity: number;
      color?: string;
      blend?: "multiply" | "screen" | "overlay";
    };

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

/** Result of an `upsert` op that emits a fresh layer id (layers:upsert
 *  returns the inserted node). Surfaced so callers (notably
 *  useUndoRedo) can capture the artifact for replay on redo and
 *  inverse-delete on undo. */
export type EditUpsertArtifact = { format: 2; node: BundleLayerNode };

/** Result of a `crop` op — the PREVIOUS canvas dims so the caller can
 *  stash them for undo. Surfaces the previous width_px / height_px
 *  from the captures row. */
export type EditCropArtifact = {
  previousWidthPx: number;
  previousHeightPx: number;
};

export type LayerEditOp =
  /** v2 upsert. `bumpZIndexToMax` (optional, default false) signals
   *  that the layer is a FRESH DRAW that should land at the top of
   *  the stack — the repo resolves z_index to MAX(existing) + GAP
   *  and ignores `node.z_index`. Fresh-draw callers
   *  (commitArrow / commitRect / etc.) set this to `true`. Update
   *  paths (delete-plus-insert via updateGeometry / updateOverlay)
   *  and undo restore leave it OFF so the repo stores `node.z_index`
   *  verbatim — including 0 (the Send-to-Back regression). */
  | { kind: "upsert"; node: BundleLayerNode; bumpZIndexToMax?: boolean }
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
  | { kind: "updateOverlay"; layerId: string; patch: OverlayPatch }
  /** Z-order change for one layer. Maps directly to `layers:reorder` —
   *  a single-row UPDATE on `z_index`. Layer id is preserved (unlike
   *  updateGeometry / updateOverlay which are delete-plus-insert), so
   *  the caller's selection stays valid without re-anchoring. The
   *  caller computes the new z_index value; the renderer-side helper
   *  uses gaps (e.g. 1000-step) so most reorders avoid touching
   *  neighbors. */
  | { kind: "reorder"; layerId: string; zIndex: number };

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
  | { kind: "update"; artifact: EditUpsertArtifact }
  /** Z-order change. Ids don't change (layers:reorder is a true
   *  in-place UPDATE on `z_index`), so the artifact is empty — callers
   *  keep their existing selection ids. */
  | { kind: "reorder" };

export type CaptureModelV2 = {
  kind: "loaded";
  format: 2;
  captureId: string;
  record: CaptureRecord;
  layers: BundleLayerNode[];
  /** Uniform view shape. v2 layer nodes are already
   *  LayerView-compatible natively; the shim just projects them. */
  layersView: LayerView[];
  dispatchEdit: (
    op: LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
};

export type CaptureModel =
  | CaptureModelLoading
  | CaptureModelError
  | CaptureModelV2;

// ---- Internal state shape ------------------------------------------

type FetchedState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "v2"; record: CaptureRecord; layers: BundleLayerNode[] };

// ---- Shims (v2 layer node → LayerView) -----------------------------
//
// Inlined per the plan's code-simplicity decision. The vector-layer
// case projects the v2 VectorLayer's carried Overlay `shape` through
// `overlayToLayerView`.

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
    case "shape":
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
          effect: { mode: effect.style ?? "gaussian", radius: effect.radius_px },
          clipRect,
          meta
        };
      }
      // highlight effect
      return {
        kind: "effect",
        id: node.id,
        effect: {
          mode: "highlight",
          opacity: effect.opacity,
          color: effect.tint_hex,
          ...(effect.blend !== undefined ? { blend: effect.blend } : {})
        },
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
        overlay.kind !== "shape" &&
        overlay.kind !== "highlight" &&
        overlay.kind !== "blur"
      ) {
        return null;
      }
      // Rotation is OPTIONAL on the geometry — omit = "leave it
      // alone" (preserve overlay.rotation). Same shape semantics as
      // shallow merge: a translation-only drag should never wipe a
      // pre-existing rotation, and the rotation-handle drag pre-fills
      // `rect` with the unchanged value so its update reads as
      // "preserve rect, set rotation".
      return {
        ...overlay,
        rect: geometry.rect,
        ...(geometry.rotation !== undefined ? { rotation: geometry.rotation } : {})
      };
    case "text":
      if (overlay.kind !== "text") return null;
      return {
        ...overlay,
        point: geometry.point,
        ...(geometry.rotation !== undefined ? { rotation: geometry.rotation } : {})
      };
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

/** Re-normalize an Overlay's coords by the INVERSE of a crop rect.
 *
 *  Overlay coords are normalized [0,1] to the canvas. When the canvas
 *  is cropped, the canvas dims shrink BUT the absolute-pixel position
 *  the user sees the overlay at should NOT move — overlays in the
 *  kept region stay put visually; overlays in the cropped-away region
 *  end up with normalized coords outside [0,1] and get clipped by
 *  the canvas at render time.
 *
 *  Without this transform a text overlay at point.x = 0.95 on an
 *  800-px canvas (absolute pixel 760) would still render at 0.95 of
 *  the NEW 480-px canvas (absolute pixel 456) after a crop to 60%
 *  width — i.e. the text would visually SLIDE LEFT into the kept
 *  region instead of being clipped at the right edge.
 *
 *  Formula (per axis): `new = (old - rect.origin) / rect.size`.
 *  For width / height (no offset, just scale): `new_w = old_w / rect.w`.
 *  The current v2 crop dispatcher collapses rect.x/y to 0, but the
 *  formula handles non-(0,0) crops too in case the off-origin path
 *  ever ships.
 *
 *  Returns null for CropOverlay (the crop layer itself is in the
 *  pre-crop space and is replaced wholesale by the dispatcher, so
 *  re-normalizing it would scramble the rect meaninglessly). Returns
 *  the original overlay unchanged for kinds with no transformable
 *  coords. */
export function inverseTransformOverlayByCrop(
  overlay: Overlay,
  cropRect: { x: number; y: number; w: number; h: number }
): Overlay | null {
  const { x: cx, y: cy, w: cw, h: ch } = cropRect;
  if (cw <= 0 || ch <= 0) return null;
  const tx = (n: number): number => (n - cx) / cw;
  const ty = (n: number): number => (n - cy) / ch;
  const sx = (n: number): number => n / cw;
  const sy = (n: number): number => n / ch;
  // Crop is a VIEWPORT change, not a destructive op (the user's
  // mental model on pwrdrvr/PwrSnap#110 review). Overlays at absolute
  // source pixels outside the cropped viewport must persist as DATA
  // (coords > 1 or < 0 in the new canvas's [0,1] space) so that
  // undoing the crop restores them to their original positions.
  //
  // NormalizedScalar was widened from .min(0).max(1) to .finite() to
  // accept out-of-canvas coords; renderer + bake clip at the canvas
  // boundary at paint time (SVG overflow + sharp composite).
  //
  // Pre-fix this helper deleted (returned null for) overlays whose
  // transformed coords fell outside [0,1], which made the data loss
  // PERMANENT — undoing a crop couldn't restore overlays the forward
  // crop had wiped out. The new behavior just emits the math; nothing
  // is deleted, undo round-trips back to the original coords exactly.
  switch (overlay.kind) {
    case "arrow":
      return {
        ...overlay,
        from: { x: tx(overlay.from.x), y: ty(overlay.from.y) },
        to: { x: tx(overlay.to.x), y: ty(overlay.to.y) }
      };
    case "shape":
    case "highlight":
    case "blur":
      return {
        ...overlay,
        rect: {
          x: tx(overlay.rect.x),
          y: ty(overlay.rect.y),
          w: sx(overlay.rect.w),
          h: sy(overlay.rect.h)
        }
      } as Overlay;
    case "text":
    case "step":
      return {
        ...overlay,
        point: { x: tx(overlay.point.x), y: ty(overlay.point.y) }
      };
    case "crop":
      // Crop layers are replaced wholesale by the dispatcher (the new
      // crop's rect is in the old canvas's coord space; the old crop's
      // rect doesn't make sense in the new canvas). Returning null
      // here signals "don't re-emit this overlay" — the dispatcher's
      // Step 1 deletes the old crop layer and Step 2 inserts the
      // fresh one.
      return null;
  }
}

/** Apply a GeometryUpdate to a BundleLayerNode. For vector layers
 *  we update the underlying `shape` (which carries the v1 Overlay
 *  shape verbatim). For blur/highlight effect layers, geometry
 *  updates target `clip_rect` — renormalized to absolute canvas
 *  pixels (the v2 EffectLayer.clip_rect contract). Returns null if
 *  the geometry kind doesn't fit the layer kind.
 *
 *  PRESERVES the layer id, like `applyPatchToLayer`. The op is still a
 *  delete-plus-insert (the `updateGeometry` dispatcher soft-deletes the
 *  old row then upserts this merged node), but reusing `layer.id` keeps
 *  it the SAME logical layer — `layers:upsert` hits the restore path
 *  (un-rejects the just-soft-deleted row) rather than inserting a fresh
 *  row, so there is no PRIMARY KEY collision.
 *
 *  Why preserve, not churn: minting a fresh id on every drag/resize/
 *  rotate orphaned the undo stack the same way it did for text edits —
 *  the `create` entry recorded when the layer was first drawn points at
 *  the original id, so once an edit churned that id, undoing back to the
 *  create deleted a dead id (a silent no-op) and the layer became
 *  un-removable. Repro: draw arrow1, draw arrow2, drag arrow1, then ⌘Z
 *  all the way — arrow1 used to be stuck on the canvas. A stable id
 *  keeps every prior entry valid. */
export function applyGeometryToLayer(
  layer: BundleLayerNode,
  geometry: GeometryUpdate,
  canvas: { width: number; height: number }
): BundleLayerNode | null {
  if (layer.kind === "vector") {
    const merged = applyGeometryToOverlay(layer.shape, geometry);
    if (merged === null) return null;
    // Keep `layer.id` (carried by the spread) — the delete-plus-insert
    // restore path re-materializes the SAME row. See the doc-block.
    return { ...layer, shape: merged };
  }
  if (layer.kind === "effect") {
    // Only rect-shaped geometry maps onto an effect's clip_rect.
    if (geometry.kind !== "rect") return null;
    // Rotation lives on the effect spec for rectangular effects (no
    // `shape` slot). Blur and highlight both project back to overlay
    // rows, so the same rotation-handle geometry update must persist
    // for both.
    const nextEffect =
      geometry.rotation !== undefined &&
      (layer.effect.type === "blur" || layer.effect.type === "highlight")
        ? { ...layer.effect, rotation: geometry.rotation }
        : layer.effect;
    // Keep `layer.id` (carried by the spread) — same id-stability
    // rationale as the vector branch above.
    return {
      ...layer,
      effect: nextEffect,
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
 *  fields into `effect.*` (blur style currently). Returns null when the
 *  patch doesn't fit the layer kind.
 *
 *  PRESERVES the layer id. The op is still materialized as a
 *  delete-plus-insert (the `updateOverlay` dispatcher soft-deletes the
 *  old row then upserts this merged node), but reusing `layer.id` keeps
 *  it the SAME logical layer — `layers:upsert` hits the restore path
 *  (un-rejects the just-soft-deleted row, rewrites its columns) rather
 *  than inserting a fresh row.
 *
 *  Why preserve, not churn: minting a fresh id on every style/text edit
 *  orphaned the undo stack. A `create` entry recorded when the layer was
 *  first drawn points at the original id; once an edit churned that id,
 *  undoing back to the create became a silent no-op (it deleted a dead
 *  id, leaving the live layer un-removable). The user-reported repro:
 *  type "Hi Mom", edit to "Hi Mommy", then ⌘Z all the way — the text
 *  never deleted because its create entry's id had churned out from
 *  under it. A stable id keeps every prior entry valid. */
export function applyPatchToLayer(
  layer: BundleLayerNode,
  patch: OverlayPatch,
  canvas: { width: number; height: number }
): BundleLayerNode | null {
  if (layer.kind === "vector") {
    const merged = applyPatchToOverlay(layer.shape, patch);
    if (merged === null) return null;
    // Keep `layer.id` (carried by the spread) — the delete-plus-insert
    // restore path re-materializes the SAME row. See the doc-block.
    return { ...layer, shape: merged };
  }
  if (layer.kind === "effect") {
    // Map overlay-shaped patches onto effect-layer payloads.
    if (patch.kind === "blur" && layer.effect.type === "blur") {
      const styleUpdate = patch.style;
      const radiusUpdate = patch.radiusPx;
      const rotationUpdate = patch.rotation;
      const effect = layer.effect;
      const newEffect: typeof effect = {
        ...effect,
        ...(styleUpdate !== undefined ? { style: styleUpdate } : {}),
        ...(radiusUpdate !== undefined
          ? { radius_px: readBlurRadiusPx({ radiusPx: radiusUpdate }, canvas) }
          : {}),
        // Rotation rides on the effect spec for blur (see schema +
        // applyGeometryToLayer effect branch). Style patches can
        // change rotation via this path; rotation-handle drags go
        // through updateGeometry above.
        ...(rotationUpdate !== undefined ? { rotation: rotationUpdate } : {})
      };
      // Apply rect part if present (treat as geometry). Keep `layer.id`
      // (carried by the spread) so the delete-plus-insert restore path
      // re-materializes the SAME row — same id-stability rationale as
      // the vector branch above.
      const next: BundleLayerNode = {
        ...layer,
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
    if (patch.kind === "highlight" && layer.effect.type === "highlight") {
      const highlightPatch = patch as Partial<
        Extract<Overlay, { kind: "highlight" }>
      > & { kind: "highlight" };
      const next: BundleLayerNode = {
        ...layer,
        effect: {
          ...layer.effect,
          ...(highlightPatch.color !== undefined
            ? { tint_hex: readHighlightColor({ color: highlightPatch.color }) }
            : {}),
          ...(highlightPatch.opacity !== undefined
            ? { opacity: readHighlightOpacity({ opacity: highlightPatch.opacity }) }
            : {}),
          ...(highlightPatch.blend !== undefined ? { blend: highlightPatch.blend } : {}),
          ...(highlightPatch.rotation !== undefined
            ? { rotation: highlightPatch.rotation }
            : {})
        },
        clip_rect:
          highlightPatch.rect !== undefined
            ? {
                x: highlightPatch.rect.x * canvas.width,
                y: highlightPatch.rect.y * canvas.height,
                w: highlightPatch.rect.w * canvas.width,
                h: highlightPatch.rect.h * canvas.height
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

  // Per-refetch sequence guard. Multiple broadcasts (overlays:changed +
  // captures:changed) can fire in rapid succession during a single
  // dispatchEdit op (the v2 crop dispatcher emits ~5 broadcasts as it
  // steps through transform → delete old crop → insert new crop →
  // update canvas dims). Each broadcast triggers refetch → library:byId
  // dispatch. The DB reflects different state at each dispatch's
  // dispatch-time (Steps 0-2 see pre-canvas-update dims; Step 3 sees
  // post). Real IPC + V8 microtask scheduling don't preserve dispatch
  // order on resolution — so a stale Step-0 refetch can resolve AFTER
  // a fresh Step-3 refetch and overwrite state with stale dims.
  //
  // The user-visible symptom: crop undo lands canvas at raster-natural
  // dims (2880) instead of the original pre-crop dims (1728), because
  // the undo dispatcher reads recordRef.current.width_px from a stale
  // state (1728 instead of 1037), so newWidth = 1.667 × 1728 = 2880
  // instead of 1.667 × 1037 = 1729. See pwrdrvr/PwrSnap#110 user
  // report.
  //
  // Fix: bump a monotonic seq at the start of each refetch; capture
  // the seq locally; before any setState check the seq still matches.
  // Stale resolutions (whose seq is older than the current) are
  // dropped — only the LATEST refetch's resolution wins, regardless
  // of arrival order.
  const refetchSeqRef = useRef(0);

  // refetch is recreated when captureId changes. v2 is the only
  // bundle format — a record with `bundle_format_version < 2` is a
  // corrupt/unrenderable row, surfaced as an error (there are no v1
  // captures left to read).
  const refetch = useCallback(
    async (isCancelled: () => boolean): Promise<void> => {
      refetchSeqRef.current += 1;
      const mySeq = refetchSeqRef.current;
      const isStale = (): boolean => mySeq !== refetchSeqRef.current;
      const recordResult = await dispatch("library:byId", { id: captureId });
      if (isCancelled() || isStale()) return;
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
      if (record.bundle_format_version < 2) {
        setState({
          kind: "error",
          message: `unrenderable bundle_format_version: ${record.bundle_format_version}`
        });
        return;
      }
      const layersResult = await dispatch("layers:list", { captureId });
      if (isCancelled() || isStale()) return;
      const layers =
        layersResult.ok && Array.isArray(layersResult.value)
          ? layersResult.value
          : [];
      setState({ kind: "v2", record, layers });
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

  // Re-fetch the record on captures:changed (covers canvas-dimension
  // and edits_version changes that don't emit a layers broadcast).
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
  if (state.kind === "v2") {
    recordRef.current = state.record;
  }

  // Phase 3.5 — always-fresh ref to the loaded layers so the
  // updateGeometry / updateOverlay dispatchers can read the CURRENT
  // layer shape without an IPC round-trip (the model already has it
  // cached). Same rationale as `recordRef` above — we want the
  // dispatchEdit reference identity to stay stable across refetches.
  const layersRef = useRef<BundleLayerNode[]>([]);
  if (state.kind === "v2") {
    layersRef.current = state.layers;
  }

  // v2 edit dispatcher. `layers:upsertBatch` isn't in the bus yet
  // (Phase 7 expands the surface per the plan); return a typed
  // not-yet-supported error rather than silently no-oping.
  const dispatchEditV2 = useCallback(
    async (op: LayerEditOp): Promise<Result<EditOpResult, PwrSnapError>> => {
      switch (op.kind) {
        case "upsert": {
          const result = await dispatch("layers:upsert", {
            captureId,
            layer: op.node,
            // Thread the fresh-draw signal through the IPC. When true,
            // the repo resolves z_index to MAX(existing) + GAP and
            // ignores `op.node.z_index`. When omitted, `op.node.z_index`
            // is stored verbatim — see LayerEditOp.upsert doc-block.
            ...(op.bumpZIndexToMax === true ? { bumpZIndexToMax: true } : {})
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
          // Canvas size shrinks by w × h — this is independent of the
          // crop's origin (a 60%-wide crop produces a 60%-wide canvas
          // whether the user dragged the rect from the left edge or
          // from the middle). The OFFSET (rect.x, rect.y) is applied
          // separately to the raster layer's transform below, so the
          // smaller canvas displays the user's chosen REGION of the
          // source — not the top-left corner.
          const newWidth = Math.max(
            1,
            Math.round(op.rect.w * record.width_px)
          );
          const newHeight = Math.max(
            1,
            Math.round(op.rect.h * record.height_px)
          );

          // Step 0: re-normalize every vector layer's coords by the
          // inverse of the crop rect — overlays in the kept region
          // stay put visually (absolute pixel position preserved);
          // overlays in the cropped-away region end up with normalized
          // coords > 1 (or < 0) and get clipped by the new canvas at
          // render time. Without this, a text at point.x = 0.95 on an
          // 800-px canvas (absolute pixel 760) would slide LEFT to
          // 0.95 of the new 480-px canvas (absolute pixel 456) after
          // a 60% width crop, instead of being clipped at the right
          // edge.
          //
          // Crop is a VIEWPORT change, not a destructive op (the
          // user's mental model on pwrdrvr/PwrSnap#110 review).
          // Overlays outside the cropped viewport must PERSIST as
          // DATA so undoing the crop restores them. The schema's
          // NormalizedScalar was widened from .min(0).max(1) to
          // .finite() specifically to permit out-of-canvas coords;
          // the renderer (SVG overflow:hidden) and bake pipeline
          // (sharp composite) clip at paint time. So this loop never
          // deletes for "out of bounds" — that data has to survive.
          //
          // Skip the (current) crop VectorLayer itself — it's about
          // to be deleted in Step 1 anyway. Effect layers' clip_rect is
          // in absolute canvas pixels (per the v2 EffectLayer contract):
          // a (0,0)-anchored crop leaves it unchanged, but an OFF-ORIGIN
          // crop must translate it by the same offset as the raster —
          // handled in Step 0.5 below. (This was a real bug: the old
          // dispatcher assumed off-origin crops were unreachable, so
          // blurs / highlights drifted off the region they covered after
          // an off-origin crop, in BOTH the editor and the bake.)
          // The IPC surface has no `layers:updateOverlay` verb — v2
          // edits are delete-plus-insert via `layers:delete` +
          // `layers:upsert` (the v2 updateOverlay dispatcher op does
          // the same dance internally; we inline it here rather than
          // recursively re-entering the dispatchEdit closure).
          // Snapshot the current vector layers before any mutation so
          // we don't iterate over freshly-inserted post-transform
          // layers (the layersRef would update on each upsert as the
          // captures:changed broadcast lands).
          const vectorsBeforeCrop = layersRef.current.filter(
            (l): l is BundleLayerNode & { kind: "vector" } =>
              l.kind === "vector" && l.shape.kind !== "crop"
          );
          for (const layer of vectorsBeforeCrop) {
            const transformed = inverseTransformOverlayByCrop(
              layer.shape,
              op.rect
            );
            // Always delete the OLD vector layer — it's at pre-crop
            // coords that don't apply to the new canvas.
            // eslint-disable-next-line no-await-in-loop
            const delResult = await dispatch("layers:delete", { id: layer.id });
            if (!delResult.ok) return err(delResult.error);
            // `transformed === null` only happens for kinds the helper
            // refuses to re-emit: CropOverlay (replaced wholesale by
            // Steps 1-2 below) and degenerate crop rects. Neither
            // should be reached here — `vectorsBeforeCrop` already
            // filters out crop shapes, and the dispatcher's outer
            // validator rejects degenerate rects. Defense in depth:
            // skip the upsert if we ever do see null, rather than
            // pushing an invalid layer into the tree.
            if (transformed === null) continue;
            // eslint-disable-next-line no-await-in-loop
            const insResult = await dispatch("layers:upsert", {
              captureId,
              layer: { ...layer, shape: transformed }
            });
            if (!insResult.ok) {
              // eslint-disable-next-line no-console
              console.error("[crop-dispatch v2] upsert failed", {
                id: layer.id,
                kind: layer.shape.kind,
                transformed,
                error: insResult.error
              });
              return err(insResult.error);
            }
          }

          // Step 0.5: translate every raster layer's transform by
          // (-rect.x × oldW, -rect.y × oldH) so the (smaller) new
          // canvas displays the user's chosen REGION of the source.
          // Without this, the canvas-dim shrink in Step 3 would just
          // take the top-left W×H of the source — every off-origin
          // crop would silently show the wrong region of the image,
          // and overlays inverse-transformed by Step 0 would no
          // longer line up with where the user originally placed
          // them on the visible image.
          //
          // Multi-crop composes: the new tx/ty ADDs to the existing
          // transform's translation (not replaces). So cropping an
          // already-cropped image accumulates offsets correctly.
          //
          // Why the offset is applied to the RASTER's transform (not
          // by mutating sourceBytes): the source raster's bytes are
          // immutable across crops — the bundle stores one copy of
          // the original screenshot, and every "crop" is purely a
          // viewport change. The compose pipeline (compose-tree.ts'
          // compositeRasterOntoAccumulator) already handles negative
          // translation by extracting the visible window of the
          // source. Same machinery; off-origin just becomes the
          // common case instead of the edge case.
          //
          // Only translate when the crop is actually off-origin.
          // Edge-aligned crops (rect.x === 0 && rect.y === 0) skip
          // this step so we don't churn the raster row on simple
          // top-left crops (no behavior change for that case).
          const offsetXPx = op.rect.x * record.width_px;
          const offsetYPx = op.rect.y * record.height_px;
          if (offsetXPx !== 0 || offsetYPx !== 0) {
            const rasterLayers = layersRef.current.filter(
              (l): l is BundleLayerNode & { kind: "raster" } => l.kind === "raster"
            );
            for (const raster of rasterLayers) {
              const newTransform: [
                number,
                number,
                number,
                number,
                number,
                number
              ] = [
                raster.transform[0],
                raster.transform[1],
                raster.transform[2],
                raster.transform[3],
                raster.transform[4] - offsetXPx,
                raster.transform[5] - offsetYPx
              ];
              // eslint-disable-next-line no-await-in-loop
              const delResult = await dispatch("layers:delete", { id: raster.id });
              if (!delResult.ok) return err(delResult.error);
              // eslint-disable-next-line no-await-in-loop
              const insResult = await dispatch("layers:upsert", {
                captureId,
                layer: { ...raster, transform: newTransform }
              });
              if (!insResult.ok) {
                // eslint-disable-next-line no-console
                console.error("[crop-dispatch v2] raster upsert failed", {
                  id: raster.id,
                  newTransform,
                  error: insResult.error
                });
                return err(insResult.error);
              }
            }

            // Effect layers (blur / highlight) carry an absolute-canvas-
            // pixel `clip_rect`. An off-origin crop moves the canvas
            // origin to (offsetXPx, offsetYPx) of the OLD canvas, so the
            // clip_rect must shift by the same (-offsetXPx, -offsetYPx)
            // as the raster transform above — otherwise the effect keeps
            // its pre-crop coords and drifts off the region it covered
            // (wrong in BOTH the editor and the bake, since clip_rect
            // drives both). Crop is a viewport translate, so we DON'T
            // clamp: a clip_rect pushed partly/fully out of the new
            // canvas persists as data and is clipped at paint, mirroring
            // the overlay re-normalization in Step 0. Snapshot is safe to
            // read here — the raster ops above don't touch effect rows.
            const effectLayers = layersRef.current.filter(
              (l): l is BundleLayerNode & { kind: "effect" } => l.kind === "effect"
            );
            for (const effect of effectLayers) {
              if (effect.clip_rect === null) continue;
              const newClipRect = {
                x: effect.clip_rect.x - offsetXPx,
                y: effect.clip_rect.y - offsetYPx,
                w: effect.clip_rect.w,
                h: effect.clip_rect.h
              };
              // eslint-disable-next-line no-await-in-loop
              const delResult = await dispatch("layers:delete", { id: effect.id });
              if (!delResult.ok) return err(delResult.error);
              // eslint-disable-next-line no-await-in-loop
              const insResult = await dispatch("layers:upsert", {
                captureId,
                layer: { ...effect, clip_rect: newClipRect }
              });
              if (!insResult.ok) {
                // eslint-disable-next-line no-console
                console.error("[crop-dispatch v2] effect upsert failed", {
                  id: effect.id,
                  newClipRect,
                  error: insResult.error
                });
                return err(insResult.error);
              }
            }
          }

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
          // Phase 3.5 — v2 mirror of the v1 update path. The visible
          // "edit-in-place" is materialized as a delete-plus-insert
          // pair (layers:delete then layers:upsert). The merged node
          // REUSES `op.layerId` (applyGeometryToLayer preserves it), so
          // the upsert hits layers:upsert's restore path — un-rejects
          // the just-soft-deleted row rather than colliding on PRIMARY
          // KEY. Keeping the id stable keeps undo-stack create entries
          // valid across edits (see applyGeometryToLayer's doc-block).
          // Vector layers merge into `shape.*`; effect layers
          // (blur/highlight) merge into `clip_rect` (renormalized to
          // absolute canvas pixels per the v2 EffectLayer.clip_rect
          // contract).
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
        case "reorder": {
          // Single-row z_index UPDATE via the dedicated layers:reorder
          // IPC. Layer id is preserved (no delete-plus-insert churn),
          // so the caller's selection stays valid as-is.
          const result = await dispatch("layers:reorder", {
            id: op.layerId,
            zIndex: op.zIndex
          });
          if (!result.ok) return err(result.error);
          return { ok: true, value: { kind: "reorder" } };
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
  }, [state, captureId, dispatchEditV2]);
}
