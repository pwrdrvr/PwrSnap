import { isLiveHotkeyRecorderDocument } from "./hotkey-recorder-document";
import type { CommandDispatchOptions } from "../command-bus";

export type HotkeyRecorderSettingsWindow = {
  readonly id: number;
  isDestroyed(): boolean;
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
  };
};

/**
 * Production authorization boundary for a Settings hotkey-recorder lease.
 * A valid IPC principal is insufficient: the caller must be the live Settings
 * singleton and must present the opaque epoch admitted for its current main
 * frame. Keeping this predicate named and pure prevents index wiring from
 * drifting back to an "any renderer with a window id" check.
 */
export function isLiveSettingsHotkeyRecorderOwner(
  settingsWindow: HotkeyRecorderSettingsWindow | null,
  ownerWindowId: number,
  ownerDocumentId: string
): boolean {
  return (
    settingsWindow !== null &&
    !settingsWindow.isDestroyed() &&
    settingsWindow.id === ownerWindowId &&
    !settingsWindow.webContents.isDestroyed() &&
    isLiveHotkeyRecorderDocument(settingsWindow.webContents.id, ownerDocumentId)
  );
}

const RENDERER_RECORDER_COMMANDS = new Set([
  "settings:beginHotkeyRecording",
  "settings:endHotkeyRecording"
]);

/**
 * Mint the process-bridge attestation for a recorder command while the
 * Settings BrowserWindow is still local and inspectable. In split mode the
 * agent owns native shortcuts but cannot resolve the library process's
 * BrowserWindow id, so it must consume this authenticated provenance instead
 * of trying to repeat the window check in the wrong process.
 */
export function attestSettingsHotkeyRecorderOwnerForBridge(
  name: string,
  context: CommandDispatchOptions,
  settingsWindow: HotkeyRecorderSettingsWindow | null
): CommandDispatchOptions {
  if (
    !RENDERER_RECORDER_COMMANDS.has(name) ||
    context.principal !== "ipc" ||
    context.sourceWindowId === undefined ||
    context.sourceDocumentId === undefined ||
    !isLiveSettingsHotkeyRecorderOwner(
      settingsWindow,
      context.sourceWindowId,
      context.sourceDocumentId
    )
  ) {
    return context;
  }
  return { ...context, sourceSettingsHotkeyRecorderOwner: true };
}
