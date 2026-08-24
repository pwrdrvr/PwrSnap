import type { HotkeyRecorderInputScope } from "./hotkey-recorder-suspension";

type RecorderWindow = {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    setIgnoreMenuShortcuts(ignore: boolean): void;
  };
};

/**
 * Keeps application-menu accelerators from consuming a chord before the
 * Settings recorder receives its DOM keydown/keyup pair. Electron continues
 * dispatching input to Chromium; only native application-menu shortcut
 * handling is bypassed while the recorder window is focused.
 */
export function createHotkeyRecorderInputScope(
  windowFromId: (windowId: number) => RecorderWindow | null
): HotkeyRecorderInputScope {
  const setIgnored = (windowId: number, ignore: boolean): void => {
    const window = windowFromId(windowId);
    if (
      window === null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return;
    }
    window.webContents.setIgnoreMenuShortcuts(ignore);
  };

  return {
    suspend: (ownerWindowId) => setIgnored(ownerWindowId, true),
    restore: (ownerWindowId) => setIgnored(ownerWindowId, false)
  };
}
