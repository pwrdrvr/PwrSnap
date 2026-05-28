// Thin ipcMain transport over the command-bus. The renderer calls
// `pwrsnapApi.dispatch(name, req)` (preload → ipcRenderer.invoke('cmd',
// name, req)) and we route into bus.dispatch with `principal: 'ipc'`.
// All commands flow through here; renderers never own privileged paths.

import { ipcMain, nativeImage } from "electron";
import {
  IPC_CAPTURE_DRAG_START,
  IPC_CMD,
  IPC_VIDEO_DRAG_START
} from "@pwrsnap/shared";
import type { RenderPreset, VideoExportCoordinates, VideoPreset } from "@pwrsnap/shared";
import { bus } from "./command-bus";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:ipc");

function ipcCancellationKey(name: string, req: unknown): string | undefined {
  if (name !== "codex:enrich") return undefined;
  if (typeof req !== "object" || req === null || !("captureId" in req)) return undefined;
  const captureId = (req as { captureId?: unknown }).captureId;
  return typeof captureId === "string" ? captureId : undefined;
}

export function registerIpcDispatcher(): void {
  ipcMain.handle(IPC_CMD, async (_event, name: string, req: unknown) => {
    if (typeof name !== "string" || !bus.isRegistered(name)) {
      log.warn("ipc: unknown command", { name });
      return {
        ok: false,
        error: { kind: "validation", code: "unknown_command", message: `unknown command: ${name}` }
      };
    }
    // The bus handler signature is typed; renderer untyped → main typed.
    // Validation of `req` shape is the handler's responsibility (Zod schemas).
    const result = await bus.dispatch(name, req as never, {
      principal: "ipc",
      cancellationKey: ipcCancellationKey(name, req)
    });
    return result;
  });

  ipcMain.on(IPC_CAPTURE_DRAG_START, (event, req: unknown) => {
    void (async () => {
      const parsed = parseDragRequest(req);
      if (parsed === null) {
        log.warn("native drag: invalid request");
        return;
      }

      const result = await bus.dispatch(
        "capture:prepareDrag",
        parsed,
        { principal: "ipc" }
      );
      if (!result.ok) {
        log.warn("native drag: prepare failed", {
          code: result.error.code,
          message: result.error.message
        });
        return;
      }
      if (event.sender.isDestroyed()) return;

      let icon = nativeImage.createFromPath(result.value.iconPath);
      if (icon.isEmpty()) {
        icon = nativeImage.createFromPath(result.value.path);
      }
      if (icon.isEmpty()) {
        log.warn("native drag: empty drag icon", { captureId: parsed.captureId });
        return;
      }

      event.sender.startDrag({
        file: result.value.path,
        icon
      });
    })();
  });

  // Video drag-out bridge — same fire-and-forget shape as the image
  // variant above, but routes through `video:prepareDrag` so main
  // encodes (cache-hit if already done), generates a poster, and
  // returns a human-friendly file alias. The renderer dispatches
  // this whenever the user starts dragging a FILE chip on the
  // 6-card grid; main fills out `startDrag` against the resulting
  // path + poster icon. Errors are logged, not surfaced — the OS
  // drag handle has no protocol for "your prepare failed, sorry".
  ipcMain.on(IPC_VIDEO_DRAG_START, (event, req: unknown) => {
    void (async () => {
      const parsed = parseVideoDragRequest(req);
      if (parsed === null) {
        log.warn("native video drag: invalid request");
        return;
      }

      const result = await bus.dispatch(
        "video:prepareDrag",
        parsed,
        { principal: "ipc" }
      );
      if (!result.ok) {
        log.warn("native video drag: prepare failed", {
          captureId: parsed.captureId,
          format: parsed.format,
          preset: parsed.preset,
          code: result.error.code,
          message: result.error.message
        });
        return;
      }
      if (event.sender.isDestroyed()) return;

      const icon = nativeImage.createFromPath(result.value.iconPath);
      if (icon.isEmpty()) {
        // Unlike images, we don't have a sensible second-best icon
        // here — there's no point falling back to the .mp4 path
        // (nativeImage can't decode video). Drop into a small
        // empty placeholder so the OS shows *something* during
        // the drag.
        log.warn("native video drag: empty poster icon", {
          captureId: parsed.captureId
        });
      }

      event.sender.startDrag({
        file: result.value.path,
        icon: icon.isEmpty() ? nativeImage.createEmpty() : icon
      });
    })();
  });
}

export function disposeIpcDispatcher(): void {
  ipcMain.removeHandler(IPC_CMD);
  ipcMain.removeAllListeners(IPC_CAPTURE_DRAG_START);
  ipcMain.removeAllListeners(IPC_VIDEO_DRAG_START);
}

function parseDragRequest(req: unknown): { captureId: string; preset: RenderPreset } | null {
  if (typeof req !== "object" || req === null) return null;
  const value = req as { captureId?: unknown; preset?: unknown };
  if (typeof value.captureId !== "string" || value.captureId.length === 0) return null;
  if (value.preset !== "low" && value.preset !== "med" && value.preset !== "high") {
    return null;
  }
  return { captureId: value.captureId, preset: value.preset };
}

function parseVideoDragRequest(req: unknown): VideoExportCoordinates | null {
  if (typeof req !== "object" || req === null) return null;
  const value = req as {
    captureId?: unknown;
    format?: unknown;
    preset?: unknown;
  };
  if (typeof value.captureId !== "string" || value.captureId.length === 0) return null;
  if (value.format !== "gif" && value.format !== "mp4") return null;
  if (value.preset !== "low" && value.preset !== "med" && value.preset !== "high") {
    return null;
  }
  return {
    captureId: value.captureId,
    format: value.format,
    preset: value.preset as VideoPreset
  };
}
