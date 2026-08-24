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
  const liveWindow = (windowId: number): RecorderWindow | null => {
    const window = windowFromId(windowId);
    if (
      window === null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return null;
    }
    return window;
  };

  const suspend = (windowId: number): void => {
    const window = liveWindow(windowId);
    if (window === null) {
      // Failing closed matters: accepting a lease without bypassing native
      // application-menu accelerators makes Ctrl+Z/C/V/A/zoom impossible to
      // record, while the manager-owned globals are already released.
      throw new Error("hotkey recorder Settings window is no longer available");
    }
    window.webContents.setIgnoreMenuShortcuts(true);
  };

  const restore = (windowId: number): void => {
    const window = liveWindow(windowId);
    // Window destruction is itself a complete restoration of its menu input
    // state, so lifecycle cleanup must remain best-effort and non-throwing.
    if (window === null) return;
    window.webContents.setIgnoreMenuShortcuts(false);
  };

  return {
    suspend,
    restore
  };
}
