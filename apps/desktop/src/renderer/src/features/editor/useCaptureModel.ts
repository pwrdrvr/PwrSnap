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
  | { kind: "text"; point: Point; body: string; size: "small" | "large" }
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

export type OverlayEditOp =
  | { kind: "upsert"; row: OverlayRow }
  | { kind: "delete"; id: string }
  | { kind: "replace"; rows: OverlayRow[] };

export type LayerEditOp =
  | { kind: "upsert"; node: BundleLayerNode }
  | { kind: "delete"; id: string }
  | { kind: "upsertBatch"; nodes: BundleLayerNode[] };

export type CaptureModelLoading = {
  kind: "loading";
  captureId: string;
};

export type CaptureModelError = {
  kind: "error";
  captureId: string;
  message: string;
};

export type CaptureModelV1 = {
  kind: "loaded";
  format: 1;
  captureId: string;
  record: CaptureRecord;
  overlays: OverlayRow[];
  /** Synthesized format-agnostic view. The renderer can consume this
   *  without caring about v1 vs v2. */
  layers: LayerView[];
  dispatchEdit: (op: OverlayEditOp) => Promise<Result<void, PwrSnapError>>;
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
  dispatchEdit: (op: LayerEditOp) => Promise<Result<void, PwrSnapError>>;
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

  // v1 edit dispatcher.
  const dispatchEditV1 = useCallback(
    async (op: OverlayEditOp): Promise<Result<void, PwrSnapError>> => {
      switch (op.kind) {
        case "upsert": {
          const result = await dispatch("overlays:upsert", {
            captureId,
            overlay: op.row.data
          });
          if (!result.ok) return err(result.error);
          return { ok: true, value: undefined };
        }
        case "delete": {
          const result = await dispatch("overlays:delete", { id: op.id });
          if (!result.ok) return err(result.error);
          return { ok: true, value: undefined };
        }
        case "replace": {
          // overlays:replace isn't in the bus today. Fall back to
          // per-row upserts so Phase 2 callers have a path; Phase 7
          // will wire a real replace verb if needed.
          for (const row of op.rows) {
            const result = await dispatch("overlays:upsert", {
              captureId,
              overlay: row.data
            });
            if (!result.ok) return err(result.error);
          }
          return { ok: true, value: undefined };
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
    async (op: LayerEditOp): Promise<Result<void, PwrSnapError>> => {
      switch (op.kind) {
        case "upsert": {
          const result = await dispatch("layers:upsert", {
            captureId,
            layer: op.node
          });
          if (!result.ok) return err(result.error);
          return { ok: true, value: undefined };
        }
        case "delete": {
          const result = await dispatch("layers:delete", { id: op.id });
          if (!result.ok) return err(result.error);
          return { ok: true, value: undefined };
        }
        case "upsertBatch":
          return err({
            kind: "validation",
            code: "v2_writes_not_yet_supported",
            message:
              "layers:upsertBatch is not in the IPC surface yet; Phase 7 ships it"
          });
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
