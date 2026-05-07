// Command-bus handlers for the `library:*` namespace. Phase 1 wires
// list / byId / delete; Phase 1.9 adds export.

import { ok, err } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import {
  getCaptureById,
  hardDeleteCapture,
  listCaptures,
  softDeleteCapture
} from "../persistence/captures-repo";
import { moveSourceToTrash } from "../persistence/source-store";
import { createEditWindow, createMainWindow, findMainLibraryWindow } from "../window";
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
    // Singleton: raise the existing library window if alive, otherwise
    // create one. Dock-icon show/hide is owned by the window's
    // `ready-to-show` / `closed` handlers — see createMainWindow in
    // ../window.ts.
    let main = findMainLibraryWindow();
    if (main === null) {
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
