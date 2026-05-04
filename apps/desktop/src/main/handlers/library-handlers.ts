// Command-bus handlers for the `library:*` namespace. Phase 1 wires
// list / byId / delete; Phase 1.9 adds export.

import { BrowserWindow } from "electron";
import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  getCaptureById,
  hardDeleteCapture,
  listCaptures,
  softDeleteCapture
} from "../persistence/captures-repo";
import { moveSourceToTrash } from "../persistence/source-store";
import { createEditWindow, createMainWindow } from "../window";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:library-handlers");

export function registerLibraryHandlers(): void {
  bus.register("library:list", async (req) => {
    const records = listCaptures(req);
    return ok(records);
  });

  bus.register("library:byId", async (req) => {
    const record = getCaptureById(req.id);
    return ok(record);
  });

  bus.register("library:delete", async (req) => {
    const record = getCaptureById(req.id);
    if (record === null) {
      return err({ kind: "validation", code: "not_found", message: `capture not found: ${req.id}` });
    }
    softDeleteCapture(req.id);
    try {
      await moveSourceToTrash(record.src_path, record.id);
    } catch (cause) {
      log.warn("library:delete: trash move failed", {
        captureId: req.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    return ok(undefined);
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
    // Find the main library BrowserWindow. We can't match by title
    // because every PwrSnap window loads the same renderer entry
    // (<title>PwrSnap</title>) — tray + float-over + selector +
    // edit all share the title. Match by URL hash instead: the
    // library window is the only one without a `stage=` fragment
    // in its URL.
    //
    // Don't check for a specific path substring like index.html —
    // in dev the URL is `http://localhost:5173/...` (Vite dev
    // server), in prod it's `file:///path/out/renderer/index.html`.
    // Both paths are valid library URLs; the discriminator is just
    // the absence of `stage=`.
    let main = BrowserWindow.getAllWindows().find((w) => {
      if (w.isDestroyed()) return false;
      const url = w.webContents.getURL();
      return url.length > 0 && !/[#&?]stage=/.test(url);
    });
    if (main === undefined) {
      log.info("library:focus: recreating main window");
      main = createMainWindow();
    }
    if (main.isMinimized()) main.restore();
    if (!main.isVisible()) main.show();
    main.focus();
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
}

// Reachability for hard-delete during GC sweeps. Not bus-exposed —
// internal callers only.
export function gcHardDeleteCaptures(captureIds: string[]): void {
  for (const id of captureIds) {
    hardDeleteCapture(id);
  }
}
