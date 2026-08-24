import { isLiveHotkeyRecorderDocument } from "./hotkey-recorder-document";

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
