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
import { ok, err, EVENT_CHANNELS, BundleLayerNode as BundleLayerNodeSchema } from "@pwrsnap/shared";
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
  listLayerTree
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
      const inserted = insertLayer({ captureId: req.captureId, node: parseResult.data });
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

  bus.register("layers:delete", async (req) => {
    const captureId = rejectLayer(req.id);
    log.info("layer rejected (soft-delete cascade)", { id: req.id, captureId });
    if (captureId !== null) {
      broadcastLayersChanged(captureId);
      scheduleRepack(captureId);
    }
    return ok(undefined);
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
