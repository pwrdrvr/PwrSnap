import { ipcMain } from "electron";
import { dismissFloatOver } from "./float-over";

export const IPC = {
  dismissFloatOver: "pwrsnap:float-over:dismiss"
} as const;

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.dismissFloatOver, () => {
    dismissFloatOver();
  });
}

export function disposeIpcHandlers(): void {
  ipcMain.removeHandler(IPC.dismissFloatOver);
}
