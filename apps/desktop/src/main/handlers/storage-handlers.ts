import { BrowserWindow, session } from "electron";
import { ok, err } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import type { RenderCacheMaintenanceMode } from "@pwrsnap/shared";
import {
  getStorageSnapshot,
  getStorageSummary,
  maintainRenderCache,
  onStorageSnapshotUpdated
} from "../storage/accounting";

const log = getMainLogger("pwrsnap:storage-handlers");
let storageEventsRegistered = false;

export function registerStorageHandlers(): void {
  registerStorageEventBroadcast();

  bus.register("storage:summary", async () => {
    try {
      return ok(getStorageSummary());
    } catch (cause) {
      log.warn("storage:summary failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "storage_summary_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:snapshot", async (req) => {
    try {
      return ok(await getStorageSnapshot({
        force: req.force ?? false,
        audit: req.audit ?? false
      }));
    } catch (cause) {
      log.warn("storage:snapshot failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "storage_snapshot_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:clearAppCache", async () => {
    try {
      const before = await getStorageSnapshot({ force: true });
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({ urls: [] });
      const snapshot = await getStorageSnapshot({ force: true });
      return ok({
        snapshot,
        clearedBytes: Math.max(
          0,
          before.chromiumHttpCache.bytes +
            before.chromiumCodeCache.bytes -
            snapshot.chromiumHttpCache.bytes -
            snapshot.chromiumCodeCache.bytes
        )
      });
    } catch (cause) {
      log.warn("storage:clearAppCache failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "clear_app_cache_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:maintainRenderCache", async (req) => {
    const mode = req.mode;
    if (!isRenderCacheMaintenanceMode(mode)) {
      return err({
        kind: "validation",
        code: "invalid_render_cache_mode",
        message: "storage:maintainRenderCache mode must be 'trim' or 'clear'"
      });
    }
    try {
      return ok(await maintainRenderCache(mode));
    } catch (cause) {
      log.warn("storage:maintainRenderCache failed", {
        mode: req.mode,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "maintain_render_cache_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}

function isRenderCacheMaintenanceMode(value: unknown): value is RenderCacheMaintenanceMode {
  return value === "trim" || value === "clear";
}

function registerStorageEventBroadcast(): void {
  if (storageEventsRegistered) return;
  storageEventsRegistered = true;
  onStorageSnapshotUpdated((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.storageSnapshotUpdated, payload);
    }
  });
}
