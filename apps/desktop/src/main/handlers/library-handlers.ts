// Command-bus handlers for the `library:*` namespace. Phase 1 wires
// list / byId / delete; Phase 1.9 adds export.

import { BrowserWindow, clipboard } from "electron";
import {
  ok,
  err,
  EVENT_CHANNELS,
  AddUserTagRequestSchema,
  RemoveUserTagRequestSchema
} from "@pwrsnap/shared";
import { validateLibraryListByIds } from "./sizzle-validators";
import { z } from "zod";
import { bus } from "../command-bus";
import {
  getAppStats,
  getCaptureById,
  getCapturesByIds,
  getTotalLive,
  hardDeleteCapture,
  listCaptures,
  listSoftDeletedIds,
  restoreCapture,
  softDeleteCapture
} from "../persistence/captures-repo";
import { addUserTag, removeTag } from "../persistence/enrichment-repo";
import {
  moveBundlePairToTrash,
  purgeBundlePairFromTrash,
  restoreBundlePairFromTrash
} from "../persistence/bundle-store";
import {
  moveSourceToTrash,
  purgeCacheForCapture,
  purgeOneFromTrash,
  restoreSourceFromTrash
} from "../persistence/source-store";
import { createEditWindow, createMainWindow, findMainLibraryWindow } from "../window";
import { getLegacyMigrationProgress } from "../persistence/legacy-bundle-migration";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:library-handlers");

// Mirror of capture-handlers.broadcastCapturesChanged. The renderer's
// useLibrary subscribes to this event channel and refetches; without a
// broadcast a soft-delete / restore / purge would be invisible until
// the next capture nudged the list.
function broadcastCapturesChanged(changedIds: string[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.capturesChanged, { changedIds });
  }
}

/**
 * Bring the singleton Library window forward, creating it if it isn't
 * alive. Returns the window plus a `justCreated` flag — callers that
 * push state to the renderer use it to know whether to wait for the
 * page to load before sending IPC. Window discovery is delegated to
 * `findMainLibraryWindow` (singleton lookup); `createMainWindow` is
 * itself idempotent so the create-fallback is safe to call.
 */
function bringLibraryForward(): {
  window: BrowserWindow;
  justCreated: boolean;
} {
  const existing = findMainLibraryWindow();
  const justCreated = existing === null;
  const window = existing ?? createMainWindow();
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return { window, justCreated };
}

/**
 * Push a `libraryOpenCapture` event to the Library renderer so it can
 * navigate to the capture in Focus mode. Two cases:
 *
 *   • Existing window — renderer is already mounted and listening,
 *     so we send immediately.
 *   • Just-created window — `webContents.send` would race the React
 *     mount (the event would land before any subscriber registers).
 *     We wait for `did-finish-load` and then add a small grace so
 *     the renderer's `useEffect` subscribe has a chance to attach.
 *     100ms is well past the typical mount interval and safely below
 *     human perception.
 */
function sendOpenCaptureWhenReady(
  window: BrowserWindow,
  captureId: string,
  justCreated: boolean
): void {
  const send = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(EVENT_CHANNELS.libraryOpenCapture, { captureId });
  };
  if (justCreated || window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(send, 100);
    });
  } else {
    send();
  }
}

export function registerLibraryHandlers(): void {
  bus.register("library:list", async (req) => {
    const { rows, nextCursor } = listCaptures(req);
    // Unfiltered head-page requests return appStats + totalLive so the
    // sidebar binds without a separate round-trip. Filtered source-app
    // fetches also omit stats; their callers only need rows and would
    // otherwise pay the global stats query on every filter click.
    if (
      req.cursor === undefined &&
      req.appBundleId === undefined &&
      req.appBundleIds === undefined
    ) {
      return ok({
        rows,
        nextCursor,
        appStats: getAppStats(),
        totalLive: getTotalLive()
      });
    }
    return ok({ rows, nextCursor });
  });

  bus.register("library:byId", async (req) => {
    const record = getCaptureById(req.id);
    return ok(record);
  });

  bus.register("library:listByIds", async (req) => {
    // Validates the ids array (length cap + non-empty strings).
    const v = validateLibraryListByIds(req);
    if (!v.ok) return err(v.error);
    // Batched lookup: one `WHERE id IN (?, ?, …)` against the captures
    // table + one batched `listVideoMetadata` for any video rows in
    // the result. Two round-trips total regardless of input size; the
    // helper returns rows in INPUT order with missing ids silently
    // dropped — see `getCapturesByIds` doc for the full contract.
    const rows = getCapturesByIds(v.ids);
    // Drop soft-deleted rows. The sizzle project view shows what
    // currently exists; if a scene's capture got soft-deleted, the
    // row vanishes from the filtered grid (the underlying SizzleScene
    // stays in the project file, so undeleting the capture brings it
    // back).
    const live = rows.filter((r) => r.deleted_at === null);
    return ok({ rows: live });
  });

  bus.register("library:delete", async (req) => {
    const record = getCaptureById(req.id);
    if (record === null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.id}` });
    }
    bus.cancel(req.id);
    softDeleteCapture(req.id);
    try {
      if (record.bundle_path !== null) {
        // Bundle-pair trash: both files move to <userData>/.trash/<id>/,
        // paired PNG first (regenerable), bundle second (system of record).
        await moveBundlePairToTrash({
          captureId: req.id,
          bundlePath: record.bundle_path,
          flatPngPath: record.flat_png_path
        });
      } else if (record.legacy_src_path !== null) {
        // Pre-bundle (legacy) capture — trash the single flat PNG.
        await moveSourceToTrash(record.legacy_src_path, record.id);
      }
    } catch (cause) {
      log.warn("library:delete: trash move failed", {
        captureId: req.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    broadcastCapturesChanged([req.id]);
    return ok(undefined);
  });

  bus.register("library:restore", async (req) => {
    const record = getCaptureById(req.id);
    if (record === null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.id}` });
    }
    if (record.deleted_at === null) {
      // Already live — make this idempotent rather than an error so a
      // double-click on Restore doesn't surface as a failure toast.
      return ok(undefined);
    }
    restoreCapture(req.id);
    try {
      if (record.bundle_path !== null) {
        await restoreBundlePairFromTrash({
          captureId: req.id,
          bundlePath: record.bundle_path,
          flatPngPath: record.flat_png_path
        });
      } else if (record.legacy_src_path !== null) {
        await restoreSourceFromTrash(req.id, record.legacy_src_path);
      }
    } catch (cause) {
      log.warn("library:restore: file restore failed", {
        captureId: req.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    broadcastCapturesChanged([req.id]);
    return ok(undefined);
  });

  bus.register("library:purge", async (req) => {
    const record = getCaptureById(req.id);
    if (record === null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.id}` });
    }
    if (record.deleted_at === null) {
      return err({
        kind: "validation",
        code: "not_in_trash",
        message: `capture is not in trash: ${req.id}`
      });
    }
    try {
      // Bundle captures live at <userData>/.trash/<id>/{<id>.pwrsnap, <id>.png};
      // legacy captures live as a single <userData>/.trash/<id><ext> file
      // where the extension comes from the original legacy_src_path
      // (PR #64: .png for image, .mp4 for video). Branch on what the
      // record actually has.
      if (record.bundle_path !== null) {
        await purgeBundlePairFromTrash(req.id);
      } else if (record.legacy_src_path !== null) {
        await purgeOneFromTrash(req.id, record.legacy_src_path);
      }
    } catch (cause) {
      log.warn("library:purge: trash file remove failed", {
        captureId: req.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    // Drop every cached derivative (image render-cache dir AND, for
    // videos, the GIF/MP4 export-cache dir). SQL CASCADE removes
    // the DB rows pointing at them, but the files themselves don't
    // get cleaned up by foreign keys. Best-effort — log + continue
    // on any rm failure.
    try {
      await purgeCacheForCapture(req.id);
    } catch (cause) {
      log.warn("library:purge: cache cleanup failed", {
        captureId: req.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    hardDeleteCapture(req.id);
    broadcastCapturesChanged([req.id]);
    return ok(undefined);
  });

  bus.register("library:purgeAll", async () => {
    const ids = listSoftDeletedIds();
    let removed = 0;
    for (const id of ids) {
      // Look up the row before we hard-delete so we know which
      // extension to look for in trash. PNG vs MP4 vs future kinds
      // all live in the same `.trash/` directory; the basename
      // alone doesn't tell purgeOneFromTrash which file to remove.
      const record = getCaptureById(id);
      try {
        if (record === null) continue;
        if (record.bundle_path !== null) {
          await purgeBundlePairFromTrash(id);
        } else if (record.legacy_src_path !== null) {
          await purgeOneFromTrash(id, record.legacy_src_path);
        }
      } catch (cause) {
        log.warn("library:purgeAll: trash file remove failed", {
          captureId: id,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
      try {
        await purgeCacheForCapture(id);
      } catch (cause) {
        log.warn("library:purgeAll: cache cleanup failed", {
          captureId: id,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
      hardDeleteCapture(id);
      removed += 1;
    }
    if (removed > 0) broadcastCapturesChanged(ids);
    return ok({ removedCount: removed });
  });

  bus.register("library:export", async () => {
    // Phase 1.9 fills this in (`pwrsnap export` CLI hook).
    return err({
      kind: "validation",
      code: "not_implemented",
      message: "library:export lands in Phase 1.9"
    });
  });

  bus.register("library:focus", async () => {
    // Singleton: raise the existing library window if alive, otherwise
    // create one. Dock-icon show/hide is owned by the window's
    // `ready-to-show` / `closed` handlers — see createMainWindow in
    // ../window.ts.
    bringLibraryForward();
    return ok(undefined);
  });

  bus.register("library:openInLibrary", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    if (record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "deleted",
        message: `capture is in trash: ${req.captureId}`
      });
    }
    const { window: main, justCreated } = bringLibraryForward();
    sendOpenCaptureWhenReady(main, req.captureId, justCreated);
    return ok(undefined);
  });

  bus.register("library:addTag", async (req) => {
    const parsed = AddUserTagRequestSchema.safeParse(req);
    if (!parsed.success) {
      return err({
        kind: "validation",
        code: "invalid_request",
        message: parsed.error.message
      });
    }
    try {
      const enrichment = addUserTag(parsed.data.captureId, parsed.data.label);
      // Reuse the AI-run broadcast channel — every renderer that cares
      // about a capture's enrichment (DetailRail, FloatOverHost) already
      // subscribes here and refreshes from `payload.enrichment`. A new
      // channel would just be a parallel subscriber on every window for
      // the same shape.
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(EVENT_CHANNELS.aiRunUpdated, { run: null, enrichment });
      }
      return ok(enrichment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = /not found or deleted/.test(message);
      return err({
        kind: "validation",
        code: isNotFound ? "not_found" : "invalid_request",
        message
      });
    }
  });

  bus.register("library:removeTag", async (req) => {
    const parsed = RemoveUserTagRequestSchema.safeParse(req);
    if (!parsed.success) {
      return err({
        kind: "validation",
        code: "invalid_request",
        message: parsed.error.message
      });
    }
    try {
      const enrichment = removeTag(parsed.data.captureId, parsed.data.label);
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(EVENT_CHANNELS.aiRunUpdated, { run: null, enrichment });
      }
      return ok(enrichment);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = /not found/.test(message);
      return err({
        kind: "validation",
        code: isNotFound ? "not_found" : "invalid_request",
        message
      });
    }
  });

  bus.register("clipboard:copyText", async (req) => {
    const parsed = z.object({ text: z.string().max(100_000) }).safeParse(req);
    if (!parsed.success) {
      return err({
        kind: "validation",
        code: "invalid_request",
        message: parsed.error.message
      });
    }
    // Single chokepoint for plain-text clipboard writes. Surfaces (OCR
    // copy, AI-derived text) route here instead of calling
    // `navigator.clipboard.writeText` directly so a future redaction
    // policy or audit hook only plugs in once.
    clipboard.writeText(parsed.data.text);
    return ok(undefined);
  });

  bus.register("editor:open", async (req) => {
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err({
        kind: "validation",
        code: "not_found",
        message: `capture not found: ${req.captureId}`
      });
    }
    if (record.deleted_at !== null) {
      return err({
        kind: "validation",
        code: "deleted",
        message: `capture is in trash: ${req.captureId}`
      });
    }
    createEditWindow(req.captureId);
    log.info("editor opened", { captureId: req.captureId });
    return ok(undefined);
  });

  // Cold-start race recovery for the legacy-migration banner: the
  // banner mounts in the renderer some 500-1500ms after the main
  // process kicks off the migration. The migration's first
  // `webContents.send("…progress")` events fire BEFORE the
  // renderer's IPC listener attaches and get dropped. The banner
  // dispatches `migration:status` on mount to pick up the current
  // cached snapshot, then watches the event channel for live
  // updates. See legacy-bundle-migration.ts `cachedProgress`.
  bus.register("migration:status", async () => {
    return ok(getLegacyMigrationProgress());
  });
}

// Reachability for hard-delete during GC sweeps. Not bus-exposed —
// internal callers only.
export function gcHardDeleteCaptures(captureIds: string[]): void {
  for (const id of captureIds) {
    hardDeleteCapture(id);
  }
}
