// Command-bus handlers for the `layers:*` namespace (v2 captures).
// Mirrors overlays-handlers.ts structure exactly: zod-validate the
// blob before any DB write, then dispatch to layers-repo + broadcast
// the events Library / Editor windows subscribe to.
//
// v1 captures use `overlays:*` instead. Both namespaces guard their
// counterparts: overlays-handlers refuses v2 captures, layers-handlers
// refuses v1 captures. The renderer branches on
// record.bundle_format_version when deciding which IPC namespace to
// hit.

import { BrowserWindow } from "electron";
import { nanoid } from "nanoid";
import {
  ok,
  err,
  EVENT_CHANNELS,
  BundleLayerNode as BundleLayerNodeSchema,
  type BundleLayerNode
} from "@pwrsnap/shared";
import type { Overlay } from "@pwrsnap/shared/overlay";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { scheduleRepack } from "../persistence/bundle-store";
import { getCaptureById, updateCaptureCanvasDimensions } from "../persistence/captures-repo";
import { getDb } from "../persistence/db";
import {
  insertLayer,
  rejectLayer,
  reparent,
  setLayerZIndex,
  setLayerZIndexes,
  listLayerTree,
  updateLayer
} from "../persistence/layers-repo";

const log = getMainLogger("pwrsnap:layers-handlers");

function broadcastLayersChanged(captureId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // Layers-changed for Editor windows that subscribe to the
    // v2-specific event; captures-changed for Library / float-over
    // which only know about the higher-level capture row. The
    // edits_version bump on the captures row was committed in the
    // same transaction as the layer write, so the cache buster on
    // pwrsnap-cache:// URLs is already stale.
    win.webContents.send(EVENT_CHANNELS.overlaysChanged, { captureId });
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds: [captureId] });
  }
}

/**
 * Refuse `layers:*` IPC on v1 captures — they use the `overlays:*`
 * namespace. Mirror of refuseIfV2Capture in overlays-handlers. Without
 * this, a layer row inserted on a v1 capture would bump edits_version
 * on a row whose bundle has no document.json — doctor's
 * `edits_version > bundle_edits_version` rule would then trigger
 * doomed re-packs on next boot.
 */
function refuseIfV1Capture(
  captureId: string
):
  | { kind: "validation"; code: "v1_capture_use_overlays_ipc"; message: string }
  | { kind: "validation"; code: "not_found"; message: string }
  | null {
  const record = getCaptureById(captureId);
  if (record === null) {
    return { kind: "validation", code: "not_found", message: `capture not found: ${captureId}` };
  }
  if (record.bundle_format_version < 2) {
    return {
      kind: "validation",
      code: "v1_capture_use_overlays_ipc",
      message: `capture ${captureId} is a v1 bundle; use overlays:* IPC instead of layers:*`
    };
  }
  return null;
}

class CropCanvasError extends Error {
  constructor(
    readonly kind: "validation" | "persistence",
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function validateCropRect(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): CropCanvasError | null {
  for (const [key, value] of Object.entries(rect)) {
    if (!Number.isFinite(value)) {
      return new CropCanvasError(
        "validation",
        "invalid_crop_rect",
        `crop rect ${key} must be finite: got ${String(value)}`
      );
    }
  }
  if (rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0) {
    return new CropCanvasError(
      "validation",
      "invalid_crop_rect",
      `crop rect must have non-negative x/y and positive w/h: got ${JSON.stringify(rect)}`
    );
  }
  if (rect.x + rect.w > 1 || rect.y + rect.h > 1) {
    return new CropCanvasError(
      "validation",
      "invalid_crop_rect",
      `crop rect must stay inside the canvas: got ${JSON.stringify(rect)}`
    );
  }
  return null;
}

function inverseTransformOverlayByCrop(
  overlay: Overlay,
  rect: { x: number; y: number; w: number; h: number }
): Overlay | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const tx = (n: number): number => (n - rect.x) / rect.w;
  const ty = (n: number): number => (n - rect.y) / rect.h;
  const sx = (n: number): number => n / rect.w;
  const sy = (n: number): number => n / rect.h;
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
      return { ...overlay, point: { x: tx(overlay.point.x), y: ty(overlay.point.y) } };
    case "crop":
      return null;
  }
}

function commonCropLayerProps(
  name: string,
  source: "user" | "codex"
): Omit<BundleLayerNode, "kind"> {
  const now = new Date().toISOString();
  return {
    id: nanoid(16),
    parent_id: null,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source,
    ai_run_id: null,
    applied_at: now,
    rejected_at: null,
    superseded_by: null,
    created_at: now
  };
}

function applyCropCanvasAtomic(input: {
  captureId: string;
  updates: BundleLayerNode[];
  deleteLayerIds: string[];
  cropLayer: BundleLayerNode | null;
  widthPx: number;
  heightPx: number;
}): { previousWidthPx: number; previousHeightPx: number } {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const node of input.updates) {
      const updated = updateLayer({ captureId: input.captureId, node });
      if (updated.status === "not_found") {
        throw new CropCanvasError(
          "validation",
          "not_found",
          `live layer not found for capture ${input.captureId}: ${node.id}`
        );
      }
      if (updated.status === "immutable_violation") {
        throw new CropCanvasError("validation", "immutable_layer_identity", updated.message);
      }
    }

    for (const id of input.deleteLayerIds) {
      const deletedCaptureId = rejectLayer(id);
      if (deletedCaptureId !== input.captureId) {
        throw new CropCanvasError(
          "validation",
          "not_found",
          `live layer not found for capture ${input.captureId}: ${id}`
        );
      }
    }

    if (input.cropLayer !== null) {
      insertLayer({ captureId: input.captureId, node: input.cropLayer, bumpZIndexToMax: true });
    }

    const previous = updateCaptureCanvasDimensions(input.captureId, {
      widthPx: input.widthPx,
      heightPx: input.heightPx
    });
    if (previous === null) {
      throw new CropCanvasError(
        "validation",
        "not_found",
        `capture not found: ${input.captureId}`
      );
    }
    return {
      previousWidthPx: previous.widthPx,
      previousHeightPx: previous.heightPx
    };
  });
  return tx();
}

export function registerLayersHandlers(): void {
  bus.register("layers:list", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if (refusal !== null) return err(refusal);
    return ok(listLayerTree(req.captureId));
  });

  bus.register("layers:upsert", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if (refusal !== null) return err(refusal);

    // Re-parse the layer blob on the boundary — IPC payload is
    // structurally typed but the discriminated-union narrowing only
    // holds if the runtime payload matches. Same discipline as
    // OverlaySchema.safeParse in overlays-handlers.
    const parseResult = BundleLayerNodeSchema.safeParse(req.layer);
    if (!parseResult.success) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: `layer payload failed schema validation: ${parseResult.error.message}`
      });
    }
    try {
      const inserted = insertLayer({
        captureId: req.captureId,
        node: parseResult.data,
        // Fresh-draw callers opt into the monotonic auto-bump by passing
        // `bumpZIndexToMax: true` on the IPC envelope. Update-in-place
        // callers (updateGeometry / updateOverlay / undo restore) leave
        // it off so the repo stores `node.z_index` verbatim — including
        // 0, which is the Send-to-Back regression. See InsertLayerInput
        // doc-block in layers-repo.ts for the full repro.
        ...(req.bumpZIndexToMax === true ? { bumpZIndexToMax: true } : {})
      });
      log.info("layer inserted", {
        id: inserted.id,
        captureId: req.captureId,
        kind: inserted.kind
      });
      broadcastLayersChanged(req.captureId);
      scheduleRepack(req.captureId);
      return ok(inserted);
    } catch (cause) {
      return err({
        kind: "persistence",
        code: "insert_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });

  bus.register("layers:update", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if (refusal !== null) return err(refusal);

    const parseResult = BundleLayerNodeSchema.safeParse(req.layer);
    if (!parseResult.success) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: `layer payload failed schema validation: ${parseResult.error.message}`
      });
    }
    try {
      const updated = updateLayer({
        captureId: req.captureId,
        node: parseResult.data
      });
      if (updated.status === "not_found") {
        return err({
          kind: "validation",
          code: "not_found",
          message: `live layer not found for capture ${req.captureId}: ${req.layer.id}`
        });
      }
      if (updated.status === "immutable_violation") {
        return err({
          kind: "validation",
          code: "immutable_layer_identity",
          message: updated.message
        });
      }
      log.info("layer updated", {
        id: updated.node.id,
        captureId: req.captureId,
        kind: updated.node.kind
      });
      broadcastLayersChanged(req.captureId);
      scheduleRepack(req.captureId);
      return ok(updated.node);
    } catch (cause) {
      return err({
        kind: "persistence",
        code: "update_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });

  bus.register("layers:reparent", async (req) => {
    const status = reparent(req.id, req.newParentId);
    if (status === "ok") {
      // Look up capture id for the broadcast — listLayerTree already
      // ran the depth check, so we know the tree is sane.
      const row = getCaptureIdFromLayer(req.id);
      if (row !== null) {
        broadcastLayersChanged(row);
        scheduleRepack(row);
      }
    }
    log.info("layer reparent", { id: req.id, newParentId: req.newParentId, status });
    return ok({ status });
  });

  bus.register("layers:reorder", async (req) => {
    // Same NaN/Infinity guard as `overlays:reorder` (v1) — see that
    // handler for the full rationale. v2 is the DEFAULT bundle format
    // (per CLAUDE.md "Bundle format v2 — default"), so this is the
    // higher-traffic path of the two reorder verbs and the hole here
    // is the more important one to close. Without the guard, a
    // compromised renderer (or a buggy caller) lands NaN into
    // `layers.z_index` and breaks `ORDER BY z_index` silently for
    // the whole capture's layer tree.
    if (!Number.isFinite(req.zIndex)) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: `layers:reorder rejected: zIndex must be finite, got ${String(req.zIndex)}`
      });
    }
    setLayerZIndex(req.id, req.zIndex);
    const row = getCaptureIdFromLayer(req.id);
    if (row !== null) {
      broadcastLayersChanged(row);
      scheduleRepack(row);
    }
    return ok(undefined);
  });

  bus.register("layers:reorderMany", async (req) => {
    if (!Array.isArray(req.orders) || req.orders.length === 0) {
      return err({
        kind: "validation",
        code: "schema_mismatch",
        message: "layers:reorderMany rejected: orders must be a non-empty array"
      });
    }
    const seen = new Set<string>();
    for (const order of req.orders) {
      if (seen.has(order.id)) {
        return err({
          kind: "validation",
          code: "schema_mismatch",
          message: `layers:reorderMany rejected: duplicate layer id ${order.id}`
        });
      }
      seen.add(order.id);
      if (!Number.isFinite(order.zIndex)) {
        return err({
          kind: "validation",
          code: "schema_mismatch",
          message: `layers:reorderMany rejected: zIndex must be finite, got ${String(order.zIndex)}`
        });
      }
    }
    const captureIds = setLayerZIndexes(req.orders);
    for (const captureId of captureIds) {
      broadcastLayersChanged(captureId);
      scheduleRepack(captureId);
    }
    return ok(undefined);
  });

  bus.register("layers:delete", async (req) => {
    const captureId = rejectLayer(req.id);
    if (captureId === null) {
      // Already deleted — a redundant call (agents sometimes re-issue
      // delete_layer several times). Idempotent no-op; quiet at debug so the
      // retries don't spam the log. NOT an error, NOT a rejection.
      log.debug("layer delete no-op (already deleted)", { id: req.id });
      return ok(undefined);
    }
    log.info("layer soft-deleted", { id: req.id, captureId });
    broadcastLayersChanged(captureId);
    scheduleRepack(captureId);
    return ok(undefined);
  });

  bus.register("bundle:cropCanvas", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if (refusal !== null) return err(refusal);

    const rectError = validateCropRect(req.rect);
    if (rectError !== null) {
      return err({
        kind: rectError.kind,
        code: rectError.code,
        message: rectError.message
      });
    }

    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }

    const widthPx = Math.max(1, Math.round(req.rect.w * record.width_px));
    const heightPx = Math.max(1, Math.round(req.rect.h * record.height_px));
    const MIN_CANVAS_DIM_PX = 32;
    if (widthPx < MIN_CANVAS_DIM_PX || heightPx < MIN_CANVAS_DIM_PX) {
      return err({
        kind: "validation",
        code: "canvas_below_minimum",
        message: `canvas dimensions ${widthPx}x${heightPx} below minimum ${MIN_CANVAS_DIM_PX}px on either axis`
      });
    }

    const layers = listLayerTree(req.captureId);
    let maxNaturalWidth = 0;
    let maxNaturalHeight = 0;
    for (const layer of layers) {
      if (layer.kind === "raster") {
        if (layer.natural_width_px > maxNaturalWidth) maxNaturalWidth = layer.natural_width_px;
        if (layer.natural_height_px > maxNaturalHeight) maxNaturalHeight = layer.natural_height_px;
      }
    }
    const maxAllowedWidth = maxNaturalWidth > 0 ? maxNaturalWidth : record.width_px;
    const maxAllowedHeight = maxNaturalHeight > 0 ? maxNaturalHeight : record.height_px;
    if (widthPx > maxAllowedWidth || heightPx > maxAllowedHeight) {
      return err({
        kind: "validation",
        code: "canvas_exceeds_source",
        message: `canvas dimensions ${widthPx}x${heightPx} exceed source raster ${maxAllowedWidth}x${maxAllowedHeight}`
      });
    }

    const offsetXPx = req.rect.x * record.width_px;
    const offsetYPx = req.rect.y * record.height_px;
    const updates: BundleLayerNode[] = [];
    const deleteLayerIds: string[] = [];
    const root = layers.find((layer) => layer.kind === "group" && layer.parent_id === null);
    for (const layer of layers) {
      if (layer.kind === "vector") {
        const transformed = inverseTransformOverlayByCrop(layer.shape, req.rect);
        if (transformed === null) {
          deleteLayerIds.push(layer.id);
        } else {
          updates.push({ ...layer, shape: transformed });
        }
      } else if (layer.kind === "raster" && (offsetXPx !== 0 || offsetYPx !== 0)) {
        updates.push({
          ...layer,
          transform: [
            layer.transform[0],
            layer.transform[1],
            layer.transform[2],
            layer.transform[3],
            layer.transform[4] - offsetXPx,
            layer.transform[5] - offsetYPx
          ]
        });
      } else if (layer.kind === "effect" && layer.clip_rect !== null && (offsetXPx !== 0 || offsetYPx !== 0)) {
        updates.push({
          ...layer,
          clip_rect: {
            ...layer.clip_rect,
            x: layer.clip_rect.x - offsetXPx,
            y: layer.clip_rect.y - offsetYPx
          }
        });
      }
    }

    const source = req.source ?? "user";
    const cropLayer =
      root === undefined
        ? null
        : BundleLayerNodeSchema.parse({
            ...commonCropLayerProps(source === "codex" ? "AI crop" : "Crop", source),
            parent_id: root.id,
            kind: "vector",
            shape: { kind: "crop", rect: req.rect }
          });

    try {
      const previous = applyCropCanvasAtomic({
        captureId: req.captureId,
        updates,
        deleteLayerIds,
        cropLayer,
        widthPx,
        heightPx
      });
      log.info("canvas cropped", {
        captureId: req.captureId,
        previousWidthPx: previous.previousWidthPx,
        previousHeightPx: previous.previousHeightPx,
        widthPx,
        heightPx
      });
      broadcastLayersChanged(req.captureId);
      scheduleRepack(req.captureId);
      return ok({
        previousWidthPx: previous.previousWidthPx,
        previousHeightPx: previous.previousHeightPx,
        widthPx,
        heightPx
      });
    } catch (cause) {
      if (cause instanceof CropCanvasError) {
        return err({
          kind: cause.kind,
          code: cause.code,
          message: cause.message
        });
      }
      return err({
        kind: "persistence",
        code: "crop_failed",
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  });

  // v2-native crop: update the captures row's canvas dimensions, bump
  // edits_version, broadcast. The bundle re-packer reads width_px /
  // height_px from the row when packing the new manifest, so the next
  // scheduled repack picks up the new dims automatically. composeV2
  // already reads them from the captures row for the live render
  // pipeline (see render/coordinator.ts).
  //
  // Refuses v1 captures (use overlays:upsert with a CropOverlay).
  // Refuses any width/height <= 0 or any value that exceeds the source
  // raster's natural dimensions — we don't expand the canvas past
  // what we have pixels for. (A future "expand canvas" surface could
  // relax this for users who want to compose past the source bounds.)
  bus.register("bundle:updateCanvasDimensions", async (req) => {
    const refusal = refuseIfV1Capture(req.captureId);
    if (refusal !== null) return err(refusal);

    if (
      !Number.isInteger(req.widthPx) ||
      !Number.isInteger(req.heightPx) ||
      req.widthPx <= 0 ||
      req.heightPx <= 0
    ) {
      return err({
        kind: "validation",
        code: "invalid_canvas_dimensions",
        message: `canvas dimensions must be positive integers: got ${req.widthPx}x${req.heightPx}`
      });
    }

    // Minimum-canvas-dim guard. Without this, a user clicking Crop
    // repeatedly (each crop sized to a normalized [0,1] rect of the
    // CURRENT canvas) multiplicatively shrinks dims toward zero —
    // 1116 * 0.6 = 670; * 0.6 = 402; … → 1. At 1×1 the bundle still
    // has its full-resolution raster source but the canvas is one
    // pixel, so compose-tree fails with "Image to composite must
    // have same dimensions or smaller". Real user hit this on
    // 8nnmKLuUpBI4K8fl (DB needed manual SQL repair). 32px is the
    // CropTool's UI min anyway, so anything smaller is either a
    // bug or a repeated-crop misadventure.
    const MIN_CANVAS_DIM_PX = 32;
    if (req.widthPx < MIN_CANVAS_DIM_PX || req.heightPx < MIN_CANVAS_DIM_PX) {
      return err({
        kind: "validation",
        code: "canvas_below_minimum",
        message: `canvas dimensions ${req.widthPx}x${req.heightPx} below minimum ${MIN_CANVAS_DIM_PX}px on either axis`
      });
    }

    // Find the source raster's natural dimensions — the canvas can't
    // exceed them (no pixels to fill). We look up the single root
    // raster layer in the live tree; v2 captures always have at least
    // one raster from the persistCaptureFromTempV2 or v1-to-v2-doctor
    // seed.
    const layers = listLayerTree(req.captureId);
    let maxNaturalWidth = 0;
    let maxNaturalHeight = 0;
    for (const layer of layers) {
      if (layer.kind === "raster") {
        if (layer.natural_width_px > maxNaturalWidth) {
          maxNaturalWidth = layer.natural_width_px;
        }
        if (layer.natural_height_px > maxNaturalHeight) {
          maxNaturalHeight = layer.natural_height_px;
        }
      }
    }
    // Fallback: if there's no raster (shouldn't happen for valid v2
    // captures), fall back to the current capture row's dims so we
    // never grow the canvas past what was already there.
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    const maxAllowedWidth =
      maxNaturalWidth > 0 ? maxNaturalWidth : record.width_px;
    const maxAllowedHeight =
      maxNaturalHeight > 0 ? maxNaturalHeight : record.height_px;
    if (req.widthPx > maxAllowedWidth || req.heightPx > maxAllowedHeight) {
      return err({
        kind: "validation",
        code: "canvas_exceeds_source",
        message: `canvas dimensions ${req.widthPx}x${req.heightPx} exceed source raster ${maxAllowedWidth}x${maxAllowedHeight}`
      });
    }

    const previous = updateCaptureCanvasDimensions(req.captureId, {
      widthPx: req.widthPx,
      heightPx: req.heightPx
    });
    if (previous === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    log.info("canvas dimensions updated", {
      captureId: req.captureId,
      previousWidthPx: previous.widthPx,
      previousHeightPx: previous.heightPx,
      widthPx: req.widthPx,
      heightPx: req.heightPx
    });
    broadcastLayersChanged(req.captureId);
    scheduleRepack(req.captureId);
    return ok({
      previousWidthPx: previous.widthPx,
      previousHeightPx: previous.heightPx
    });
  });
}

function getCaptureIdFromLayer(layerId: string): string | null {
  // Inline 1-shot SQL — avoids growing layers-repo.ts with a helper
  // used only here. Falls back to null if the layer was deleted
  // between the dispatch and the broadcast.
  const row = getDb()
    .prepare<[string], { capture_id: string }>(
      `SELECT capture_id FROM layers WHERE id = ?`
    )
    .get(layerId);
  return row?.capture_id ?? null;
}
