import { session } from "electron";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import type { RenderCacheMaintenanceMode } from "@pwrsnap/shared";
import { getStorageSnapshot, getStorageSummary, maintainRenderCache } from "../storage/accounting";

const log = getMainLogger("pwrsnap:storage-handlers");

export function registerStorageHandlers(): void {
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

  bus.register("storage:snapshot", async () => {
    try {
      return ok(await getStorageSnapshot());
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
      const before = await getStorageSnapshot();
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({ urls: [] });
      const snapshot = await getStorageSnapshot();
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
