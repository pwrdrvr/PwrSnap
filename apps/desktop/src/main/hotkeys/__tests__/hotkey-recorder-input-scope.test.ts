import { describe, expect, test, vi } from "vitest";
import {
  createHotkeyRecorderInputScope,
  createRemoteHotkeyRecorderInputScope
} from "../hotkey-recorder-input-scope";

const DOCUMENT_ID = "documentepoch0001";

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

    scope.suspend(41, DOCUMENT_ID);
    scope.restore(41, DOCUMENT_ID);

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

    expect(() => scope.suspend(1, DOCUMENT_ID)).toThrow("Settings window is no longer available");
    expect(() => scope.suspend(2, DOCUMENT_ID)).toThrow("Settings window is no longer available");
    expect(() => scope.suspend(3, DOCUMENT_ID)).toThrow("Settings window is no longer available");
    scope.restore(1, DOCUMENT_ID);
    scope.restore(2, DOCUMENT_ID);
    scope.restore(3, DOCUMENT_ID);

    expect(setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  test("bridges the exact Settings owner to the process that owns its BrowserWindow", async () => {
    const dispatch = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { applied: true } });
    const scope = createRemoteHotkeyRecorderInputScope(dispatch);

    await scope.suspend(41, DOCUMENT_ID);
    await scope.restore(41, DOCUMENT_ID);

    expect(dispatch.mock.calls).toEqual([
      [{ ownerWindowId: 41, ownerDocumentId: DOCUMENT_ID, ignore: true }],
      [{ ownerWindowId: 41, ownerDocumentId: DOCUMENT_ID, ignore: false }]
    ]);
  });

  test("fails closed when the owning process cannot apply menu suspension", async () => {
    const scope = createRemoteHotkeyRecorderInputScope(async () => ({
      ok: true,
      value: { applied: false }
    }));

    await expect(scope.suspend(41, DOCUMENT_ID)).rejects.toThrow(
      "Settings window is no longer available"
    );
  });
});
