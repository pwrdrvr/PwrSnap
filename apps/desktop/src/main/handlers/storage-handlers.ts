import { BrowserWindow, session, shell } from "electron";
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
import {
  getCapturesAccessHealth,
  onCapturesAccessHealthChanged,
  reportCapturesAccessFailure,
  reportCapturesAccessSuccess
} from "../storage/captures-access-health";
import { ensureCapturesDirReady } from "../capture/capture-storage-gate";
import { getCapturesRoot } from "../persistence/paths";

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

  bus.register("storage:capturesAccessHealth", async () => {
    return ok(getCapturesAccessHealth());
  });

  bus.register("storage:openCapturesAccessSettings", async () => {
    // Same deep-link scheme as capture/permissions.ts — stable since
    // Sonoma, still works on macOS 26. Files & Folders is where the
    // Documents-folder grant lives.
    if (process.platform !== "darwin") return ok(undefined);
    try {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
      );
      return ok(undefined);
    } catch (cause) {
      log.warn("storage:openCapturesAccessSettings failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "persistence",
        code: "open_privacy_settings_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
  });

  bus.register("storage:checkCapturesAccess", async () => {
    // Active, user-initiated verification (the Settings "Check access"
    // button). Force a real write probe — it re-triggers the macOS
    // Documents prompt + re-registers PwrSnap when macOS has no decision
    // on file, and tells us definitively whether writes work right now.
    const blocked = await ensureCapturesDirReady({ force: true });
    const root = getCapturesRoot();
    if (blocked === null) {
      // Writable — clear any standing denial so the banner + Settings row
      // both recover.
      reportCapturesAccessSuccess(root);
      return ok({ granted: true });
    }
    // Probe failed. Route the cause through the shared health accounting so
    // a TCC denial (EPERM/EACCES) lights up the same snapshot/event the
    // Library banner and Settings row read. Non-permission failures (e.g.
    // ENOSPC) are ignored by reportCapturesAccessFailure by design.
    // (`blocked` is non-null here and ensureCapturesDirReady only ever
    // returns null | err, so the `.ok` guard is just to satisfy the type.)
    reportCapturesAccessFailure(root, blocked.ok ? undefined : blocked.error.cause);
    return ok({ granted: false });
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
  // Boot filename maintenance is kicked off earlier in startup than
  // this registration, so its denials can be reported before any
  // listener exists — those early broadcasts reach no window. That's
  // fine and intentional: the snapshot persists in the
  // captures-access-health singleton, and the Library banner fetches it
  // via `storage:capturesAccessHealth` on mount, then stays current
  // through this broadcast. No denial is lost by the ordering.
  onCapturesAccessHealthChanged((health) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(EVENT_CHANNELS.capturesAccessChanged, health);
    }
  });
}
