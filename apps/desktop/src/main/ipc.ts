// Thin ipcMain transport over the command-bus. The renderer calls
// `pwrsnapApi.dispatch(name, req)` (preload → ipcRenderer.invoke('cmd',
// name, req)) and we route into bus.dispatch with `principal: 'ipc'`.
// All commands flow through here; renderers never own privileged paths.

import { ipcMain, nativeImage } from "electron";
import { IPC_CAPTURE_DRAG_START, IPC_CMD } from "@pwrsnap/shared";
import type { RenderPreset } from "@pwrsnap/shared";
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
}

export function disposeIpcDispatcher(): void {
  ipcMain.removeHandler(IPC_CMD);
  ipcMain.removeAllListeners(IPC_CAPTURE_DRAG_START);
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
