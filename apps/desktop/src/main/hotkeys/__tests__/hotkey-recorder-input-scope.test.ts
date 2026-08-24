import { describe, expect, test, vi } from "vitest";
import { createHotkeyRecorderInputScope } from "../hotkey-recorder-input-scope";

describe("createHotkeyRecorderInputScope", () => {
  test("ignores only application-menu accelerators while recording, then restores them", () => {
    const setIgnoreMenuShortcuts = vi.fn();
    const scope = createHotkeyRecorderInputScope((windowId) =>
      windowId === 41
        ? {
            isDestroyed: () => false,
            webContents: {
              isDestroyed: () => false,
              setIgnoreMenuShortcuts
            }
          }
        : null
    );

    scope.suspend(41);
    scope.restore(41);

    expect(setIgnoreMenuShortcuts.mock.calls).toEqual([[true], [false]]);
  });

  test("fails closed when the Settings owner disappears before suspension", () => {
    const setIgnoreMenuShortcuts = vi.fn();
    const windows = new Map<number, ReturnType<Parameters<typeof createHotkeyRecorderInputScope>[0]>>();
    windows.set(1, {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, setIgnoreMenuShortcuts }
    });
    windows.set(2, {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, setIgnoreMenuShortcuts }
    });
    const scope = createHotkeyRecorderInputScope((windowId) => windows.get(windowId) ?? null);

    expect(() => scope.suspend(1)).toThrow("Settings window is no longer available");
    expect(() => scope.suspend(2)).toThrow("Settings window is no longer available");
    expect(() => scope.suspend(3)).toThrow("Settings window is no longer available");
    scope.restore(1);
    scope.restore(2);
    scope.restore(3);

    expect(setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });
});
