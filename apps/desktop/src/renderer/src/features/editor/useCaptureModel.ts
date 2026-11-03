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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  err,
  readHighlightColor,
  readHighlightOpacity,
  readBlurRadiusPx,
  // Crop-viewport math now lives in @pwrsnap/shared (one copy for the
  // renderer + the main-side bake compositor). Re-exported below so the
  // existing `../useCaptureModel` importers + tests stay put.
  inverseTransformOverlayByCrop,
  inverseCropRect,
  cropRectFromCanvas,
  type AffineTransform,
  type BundleLayerNode,
  type CaptureRecord,
  type LayerHistoryReplayId,
  type Overlay,
  type OverlayRow,
  type PwrSnapError,
  type Result,
  type TextSizeBucket
} from "@pwrsnap/shared";

export { inverseTransformOverlayByCrop, inverseCropRect, cropRectFromCanvas };
import { dispatch, subscribe } from "../../lib/pwrsnap";

// ---- Geometry / patch op types -------------------------------------
//
// Geometry and style edits merge against the last committed node and use
// layers:update. One capture-scoped FIFO orders edits, crops and history replay.

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
      /** Optional clockwise rotation (radians) around the glyph's
       *  BODY-BOX CENTER — NOT around `point`. `point` is the text's
       *  left edge (`computeTextHtmlStyle` anchors with `left:
       *  point.x%` plus a `translateY(-50%)`), so the render pivot is
       *  the wrapper's box center, which is where the rotate handle
       *  and the inverse hit-test transform both pivot too. Rotating
       *  about `point` instead is what put the move cursor an inch to
       *  the right of the glyph in #541. Pinned by
       *  __tests__/TransformHandles.test.tsx ("text rotation handle
       *  pivots around the body-box CENTER, not the anchor").
       *  Omitted = "don't change rotation", as for `rect.rotation`. */
      readonly rotation?: number;
    }
  | { readonly kind: "step"; readonly point: NormalizedPoint }
  /** A Draw stroke's whole point list. A move or a bbox resize rewrites
   *  every point; the width is not geometry (it rides the source-sized
   *  ladder), so a resize never thickens the line. */
  | { readonly kind: "stroke"; readonly points: readonly NormalizedPoint[] }
  /** Raster move (Phase 2 raster unification): the layer's full affine
   *  transform `[sx, 0, 0, sy, tx, ty]` in CANVAS PIXELS of the space
   *  the edit was made in (display space for user drags — the crop
   *  wrapper maps to stored space like every other kind). Only rasters
   *  accept it; applyGeometryToLayer returns null for other kinds.
   *  Routing raster moves through updateGeometry (instead of a raw
   *  layers:update) is what puts them on the undo stack and in the
   *  multi-drag group commit. */
  | { readonly kind: "transform"; readonly transform: AffineTransform };

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
  | { kind: "text"; point: Point; body: string; size: TextSizeBucket }
  | { kind: "step"; point: Point; index: number }
  | { kind: "stroke"; points: Point[] };

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

/** Result payload for an in-place update. `node` is the persisted
 * post-update layer; `previousNode` is the exact layer state that the
 * update replaced. For queued `updateOverlay` writes, that predecessor
 * comes from the write lane rather than a possibly stale render snapshot.
 */
export type EditUpdateArtifact = EditUpsertArtifact & {
  previousNode: BundleLayerNode;
};

/** Result of a `crop` op — the PREVIOUS canvas dims so the caller can
 *  stash them for undo. Surfaces the previous width_px / height_px
 *  from the captures row. */
export type EditCropArtifact = {
  previousWidthPx: number;
  previousHeightPx: number;
  widthPx: number;
  heightPx: number;
  rect: CropRect;
};

/** Kept by the history entry until replay is confirmed; a lost response
 * retries the same main-owned reservation, never a new mutation. */
export type HistoryReplayIdentity = { current: LayerHistoryReplayId | null; removals?: BundleLayerNode[] };

export type LayerEditOp =
  | { kind: "historyReplay"; identity: HistoryReplayIdentity; restore: BundleLayerNode[]; removeIds: string[]; expectedRejected?: BundleLayerNode[] }
  | { kind: "historyAck"; replayId: LayerHistoryReplayId }
  /** v2 upsert. `bumpZIndexToMax` (optional, default false) signals
   *  that the layer is a FRESH DRAW that should land at the top of
   *  the stack — the repo resolves z_index to MAX(existing) + GAP
   *  and ignores `node.z_index`. Fresh-draw callers
   *  (commitArrow / commitRect / etc.) set this to `true`. Update
   *  paths and undo restore leave it OFF so the repo stores `node.z_index`
   *  verbatim — including 0 (the Send-to-Back regression). */
  | { kind: "upsert"; node: BundleLayerNode; bumpZIndexToMax?: boolean }
  | { kind: "delete"; id: string }
  | { kind: "upsertBatch"; nodes: BundleLayerNode[] }
  /** Apply a non-destructive viewport transform in one main transaction.
   * Negative origins / expanding rectangles are IPC undo or Reset restores. */
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
   *  a single-row UPDATE on `z_index`. Layer id is preserved, so
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
 *  + style) resolves with both the persisted node and the exact
 *  PRE-PATCH node so undo can derive its inverse from the state the
 *  write actually replaced. */
export type EditOpResult =
  | { kind: "historyReplay"; removals?: BundleLayerNode[] }
  | { kind: "historyAck" }
  | { kind: "upsert"; artifact: EditUpsertArtifact }
  | { kind: "delete" }
  | { kind: "crop"; artifact: EditCropArtifact }
  | { kind: "update"; artifact: EditUpdateArtifact }
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
// Deliberately inlined rather than split into their own file. The
// vector-layer
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
    case "stroke":
      return {
        kind: "vector",
        id: row.id,
        geometry: {
          kind: "stroke",
          points: data.points.map((p) => ({ x: p.x * sourceWidth, y: p.y * sourceHeight }))
        },
        style: { color: typeof data.color === "string" ? data.color : "auto" },
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
    case "stroke":
      if (overlay.kind !== "stroke") return null;
      return { ...overlay, points: [...geometry.points] };
    case "transform":
      // Raster-only geometry — never applies to an Overlay shape.
      // Rasters merge via applyGeometryToLayer's raster arm instead.
      return null;
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
 *  pixels (the v2 EffectLayer.clip_rect contract). Returns null if
 *  the geometry kind doesn't fit the layer kind.
 *
 *  Preserves the layer id so in-place edits and history replay address
 *  the same logical annotation.
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
  if (layer.kind === "raster") {
    // Raster moves carry the full affine transform. Keep `layer.id`
    // (carried by the spread) — same id-stability rationale as the
    // vector branch above.
    if (geometry.kind !== "transform") return null;
    return { ...layer, transform: geometry.transform };
  }
  // group: no geometry surface.
  return null;
}

/** Apply a generic OverlayPatch to a BundleLayerNode. Vector layers
 *  merge into `shape`; effect layers project the patch's relevant
 *  fields into `effect.*` (blur style currently). Returns null when the
 *  patch doesn't fit the layer kind.
 *
 *  Preserves the layer id so prior create/history entries remain valid.
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
      // Apply the rect part in canvas pixels, preserving layer identity.
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

  // A later read or edit invalidates older in-flight responses. An atomic
  // crop also installs its committed snapshot before the next queued edit.
  const refetchSeqRef = useRef(0);
  const pendingRefetchRef = useRef<Promise<void> | null>(null);

  // refetch is recreated when captureId changes. v2 is the only
  // bundle format — a record with `bundle_format_version < 2` is a
  // corrupt/unrenderable row, surfaced as an error (there are no v1
  // captures left to read).
  const refetch = useCallback(
    (isCancelled: () => boolean): Promise<void> => {
      const work = (async (): Promise<void> => {
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
        // A transaction reply may have installed a newer snapshot while this
        // read was in flight. Keep the read alive and reconcile by version.
        if (recordRef.current?.id === captureId && record.edits_version < recordRef.current.edits_version) return;
        recordRef.current = record;
        layersRef.current = layers;
        setState({ kind: "v2", record, layers });
      })();
      pendingRefetchRef.current = work;
      void work.finally(() => {
        if (pendingRefetchRef.current === work) pendingRefetchRef.current = null;
      }).catch(() => undefined);
      return work;
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
  if (state.kind === "v2" && state.record.id === captureId) {
    recordRef.current = state.record;
  }

  // Phase 3.5 — always-fresh ref to the loaded layers so the
  // updateGeometry / updateOverlay dispatchers can read the CURRENT
  // layer shape without an IPC round-trip (the model already has it
  // cached). Same rationale as `recordRef` above — we want the
  // dispatchEdit reference identity to stay stable across refetches.
  const layersRef = useRef<BundleLayerNode[]>([]);
  const committedLayersRef = useRef<Map<string, BundleLayerNode>>(new Map());
  const committedLayersCaptureIdRef = useRef(captureId);
  // A hook instance can survive a capture switch. A style lane belongs to
  // one capture only; never let a late old-capture row seed the next one.
  if (committedLayersCaptureIdRef.current !== captureId) {
    committedLayersRef.current.clear();
    committedLayersCaptureIdRef.current = captureId;
  }
  if (state.kind === "v2" && state.record.id === captureId) {
    layersRef.current = state.layers;
    // Keep a settled lane only until the model has incorporated its exact
    // restored node. This closes the race between the IPC resolving and
    // the broadcast/refetch landing, while still allowing a later external
    // update to become the source for the next local style change.
    for (const [layerId, node] of committedLayersRef.current) {
      const landed = state.layers.find((layer) => layer.id === layerId);
      if (landed !== undefined && JSON.stringify(landed) === JSON.stringify(node)) {
        committedLayersRef.current.delete(layerId);
      }
    }
  }

  // Keep a crop behind earlier layer writes, and merge each later patch
  // against its committed predecessor. A capture switch closes admission
  // for queued old work; an already dispatched write may still finish.
  const editQueueRef = useRef({ captureId, tail: Promise.resolve(), active: true });
  if (editQueueRef.current.captureId !== captureId) {
    editQueueRef.current.active = false;
    editQueueRef.current = { captureId, tail: Promise.resolve(), active: true };
  }
  const editQueue = editQueueRef.current;
  useEffect(() => {
    editQueue.active = true;
    return () => { editQueue.active = false; };
  }, [editQueue]);

  const dispatchEditV2 = useCallback((op: LayerEditOp): Promise<Result<EditOpResult, PwrSnapError>> => {
    const isCurrentCapture = (): boolean => editQueue.active && editQueueRef.current === editQueue;
    const work = editQueue.tail.then(async (): Promise<Result<EditOpResult, PwrSnapError>> => {
      if (!isCurrentCapture()) return err({ kind: "validation", code: "edit_cancelled", message: "capture changed or editor unmounted" });
      // Full-node patches must incorporate a newer broadcast read already in
      // flight, rather than invalidate it and overwrite its unseen fields.
      if (op.kind === "updateGeometry" || op.kind === "updateOverlay") {
        while (pendingRefetchRef.current !== null) await pendingRefetchRef.current;
        if (!isCurrentCapture()) return err({ kind: "validation", code: "edit_cancelled", message: "capture changed or editor unmounted" });
      }
      if (op.kind !== "historyAck") refetchSeqRef.current += 1;
      switch (op.kind) {
        case "historyReplay": {
          if (op.identity.current === null) {
            const reservation = await dispatch("layers:replayHistory", { phase: "reserve", captureId, removeIds: op.removeIds });
            if (!reservation.ok) return err(reservation.error);
            if (reservation.value.phase !== "reserved") return err({ kind: "validation", code: "invalid_history_reply", message: "expected history reservation" });
            op.identity.current = reservation.value.replayId;
            op.identity.removals = reservation.value.removals;
          }
          const result = await dispatch("layers:replayHistory", {
            phase: "apply", captureId, replayId: op.identity.current,
            restore: op.restore, removeIds: op.removeIds,
            ...(op.expectedRejected === undefined ? {} : { expectedRejected: op.expectedRejected }),
            ...(op.identity.removals === undefined ? {} : { expectedRemovals: op.identity.removals })
          });
          if (!result.ok) return err(result.error);
          if (result.value.phase !== "applied") return err({ kind: "validation", code: "invalid_history_reply", message: "expected committed history" });
          if (isCurrentCapture()) {
            committedLayersRef.current.clear();
            if ((recordRef.current?.edits_version ?? -1) <= result.value.record.edits_version) {
              recordRef.current = result.value.record;
              layersRef.current = result.value.layers;
              setState({ kind: "v2", record: result.value.record, layers: result.value.layers });
            }
          }
          return { ok: true, value: { kind: "historyReplay", removals: op.identity.removals ?? [] } };
        }
        case "historyAck": {
          const result = await dispatch("layers:ackHistoryReplay", { captureId, replayId: op.replayId });
          if (!result.ok) return err(result.error);
          return { ok: true, value: { kind: "historyAck" } };
        }
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
          if (isCurrentCapture())
            committedLayersRef.current.set(result.value.id, result.value);
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
          if (isCurrentCapture()) {
            committedLayersRef.current.delete(op.id);
            layersRef.current = layersRef.current.filter((layer) => layer.id !== op.id);
          }
          return { ok: true, value: { kind: "delete" } };
        }
        case "upsertBatch":
          return err({
            kind: "validation",
            code: "v2_writes_not_yet_supported",
            message: "layers:upsertBatch is not in the IPC surface yet; Phase 7 ships it"
          });
        case "crop": {
          const result = await dispatch("bundle:cropCanvas", {
            captureId,
            rect: op.rect,
            ...(op.rect.x < 0 || op.rect.y < 0 || op.rect.w > 1 || op.rect.h > 1
              ? { restore: true as const }
              : {})
          });
          if (!result.ok) return err(result.error);
          if (isCurrentCapture()) {
            committedLayersRef.current.clear();
            if ((recordRef.current?.edits_version ?? -1) <= result.value.record.edits_version) {
              // This snapshot was read inside the crop transaction. Install it
              // before admitting another edit, even if no broadcast has landed.
              recordRef.current = result.value.record;
              layersRef.current = result.value.layers;
              setState({ kind: "v2", record: result.value.record, layers: result.value.layers });
            }
          }
          return {
            ok: true,
            value: {
              kind: "crop",
              artifact: {
                previousWidthPx: result.value.previousWidthPx,
                previousHeightPx: result.value.previousHeightPx,
                widthPx: result.value.widthPx,
                heightPx: result.value.heightPx,
                rect: {
                  ...op.rect,
                  w: result.value.widthPx / result.value.previousWidthPx,
                  h: result.value.heightPx / result.value.previousHeightPx
                }
              }
            }
          };
        }
        case "updateGeometry":
        case "updateOverlay": {
          const record = recordRef.current;
          if (record === null) return err({ kind: "validation", code: "record_not_loaded", message: "record not loaded" });
          const previousNode = committedLayersRef.current.get(op.layerId)
            ?? layersRef.current.find((layer) => layer.id === op.layerId);
          if (previousNode === undefined) return err({ kind: "validation", code: "layer_not_found", message: `no layer with id ${op.layerId}` });
          const canvas = { width: record.width_px, height: record.height_px };
          const merged = op.kind === "updateGeometry"
            ? applyGeometryToLayer(previousNode, op.geometry, canvas)
            : applyPatchToLayer(previousNode, op.patch, canvas);
          if (merged === null) return err({ kind: "validation", code: op.kind === "updateGeometry" ? "geometry_kind_mismatch" : "patch_kind_mismatch", message: `cannot apply ${op.kind} to ${previousNode.kind}` });
          const result = await dispatch("layers:update", { captureId, layer: merged });
          if (!result.ok) return err(result.error);
          if (isCurrentCapture())
            committedLayersRef.current.set(op.layerId, result.value);
          return { ok: true, value: { kind: "update", artifact: { format: 2, node: result.value, previousNode } } };
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
          const current = committedLayersRef.current.get(op.layerId) ?? layersRef.current.find((layer) => layer.id === op.layerId);
          if (isCurrentCapture() && current !== undefined)
            committedLayersRef.current.set(op.layerId, { ...current, z_index: op.zIndex });
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
    });
    // A rejected transport must not strand later edits in this session.
    editQueue.tail = work.then(() => undefined, () => undefined);
    return work;
  }, [captureId, editQueue]);

  // Project the fetched state into the public CaptureModel. Memoize
  // the LayerView synthesis so the renderer doesn't re-walk the array
  // on every consumer re-render.
  return useMemo<CaptureModel>(() => {
    if (state.kind === "loading" || (state.kind === "v2" && state.record.id !== captureId)) {
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
