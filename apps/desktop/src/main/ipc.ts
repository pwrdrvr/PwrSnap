// Thin ipcMain transport over the command-bus. The renderer calls
// `pwrsnapApi.dispatch(name, req)` (preload → ipcRenderer.invoke('cmd',
// name, req)) and we route into bus.dispatch with `principal: 'ipc'`.
// All commands flow through here; renderers never own privileged paths.

import { ipcMain } from "electron";
import { IPC_CMD } from "@pwrsnap/shared";
import { bus } from "./command-bus";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:ipc");

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
    const result = await bus.dispatch(name, req as never, { principal: "ipc" });
    return result;
  });
}

export function disposeIpcDispatcher(): void {
  ipcMain.removeHandler(IPC_CMD);
}
