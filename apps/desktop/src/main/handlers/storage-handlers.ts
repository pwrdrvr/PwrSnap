import { session } from "electron";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getStorageSnapshot } from "../storage/accounting";

const log = getMainLogger("pwrsnap:storage-handlers");

export function registerStorageHandlers(): void {
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

  bus.register("storage:clearChromiumCache", async () => {
    try {
      const before = await getStorageSnapshot();
      await session.defaultSession.clearCache();
      const snapshot = await getStorageSnapshot();
      return ok({
        snapshot,
        clearedBytes: Math.max(0, before.chromiumHttpCache.bytes - snapshot.chromiumHttpCache.bytes)
      });
    } catch (cause) {
      log.warn("storage:clearChromiumCache failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "clear_chromium_cache_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });
}
