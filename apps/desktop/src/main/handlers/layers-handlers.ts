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
import { getCaptureById } from "../persistence/captures-repo";
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
