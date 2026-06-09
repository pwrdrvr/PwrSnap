// Unit coverage for the Windows custom title-bar menu bridge
// (app-menu-bridge.ts). The bridge itself only runs on Windows at runtime,
// but its logic — top-level menu filtering + popup payload validation — is
// platform-agnostic and worth pinning here so a refactor can't silently:
//   - leak the macOS `appMenu` role into the renderer's bar,
//   - drift the reported index from the real `Menu.items` index (which would
//     pop the WRONG submenu, since popup looks up `menu.items[index]`), or
//   - throw / mis-pop on a hostile or malformed popup payload.
//
// electron is fully mocked; we capture the two channel handlers the bridge
// registers and drive them directly, swapping `Menu.getApplicationMenu()` per
// case.

import { beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  appMenu: null as null | { items: unknown[] },
  modelHandler: null as null | ((event: unknown) => unknown),
  popupListener: null as null | ((event: unknown, payload: unknown) => void),
  fromWebContents: vi.fn()
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: electronMock.fromWebContents
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown) => unknown) => {
      if (channel === "app-menu:model") electronMock.modelHandler = handler;
    }),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (channel === "app-menu:popup") electronMock.popupListener = listener;
    })
  },
  Menu: {
    getApplicationMenu: () => electronMock.appMenu
  }
}));

const { wireAppMenuBridge } = await import("../app-menu-bridge");
// Idempotent — registers both channel handlers once; the captures above grab
// them. Subsequent calls are no-ops (the module's `wired` latch), so a single
// wire-up here is enough for every test.
wireAppMenuBridge();

function submenu(): { popup: ReturnType<typeof vi.fn> } {
  return { popup: vi.fn() };
}

beforeEach(() => {
  electronMock.appMenu = null;
  electronMock.fromWebContents.mockReset();
});

describe("app-menu:model (appMenuTopLevel)", () => {
  test("returns [] when no application menu is set", () => {
    electronMock.appMenu = null;
    expect(electronMock.modelHandler?.({})).toEqual([]);
  });

  test("keeps real top-level entries, dropping appMenu/invisible/empty/submenu-less — with RAW indices", () => {
    electronMock.appMenu = {
      items: [
        { role: "appMenu", label: "PwrSnap", submenu: submenu() }, // 0 — appMenu role (macOS-only)
        { label: "File", submenu: submenu() }, //                     1 — kept
        { label: "Edit", submenu: submenu() }, //                     2 — kept
        { label: "Hidden", visible: false, submenu: submenu() }, //   3 — explicitly invisible
        { label: "", submenu: submenu() }, //                         4 — empty label
        { label: 42, submenu: submenu() }, //                         5 — non-string label
        { label: "Detached" }, //                                     6 — no submenu
        { label: "Help", submenu: submenu() } //                      7 — kept
      ]
    };
    // The index MUST be the position in `Menu.items` (not the filtered array),
    // because the popup handler does `menu.items[index]`. Help at 7 proves it.
    expect(electronMock.modelHandler?.({})).toEqual([
      { index: 1, label: "File" },
      { index: 2, label: "Edit" },
      { index: 7, label: "Help" }
    ]);
  });
});

describe("app-menu:popup", () => {
  function appMenuWithSubmenuAt(target: number): ReturnType<typeof vi.fn> {
    const targetPopup = vi.fn();
    const items: unknown[] = [];
    for (let i = 0; i <= target; i++) {
      items[i] = i === target ? { label: "T", submenu: { popup: targetPopup } } : { label: "Y", submenu: submenu() };
    }
    electronMock.appMenu = { items };
    return targetPopup;
  }

  test("pops the indexed submenu at the rounded window-relative point", () => {
    const popup = appMenuWithSubmenuAt(1);
    const win = { id: 7 };
    electronMock.fromWebContents.mockReturnValue(win);

    electronMock.popupListener?.({ sender: { marker: "s" } }, { index: 1, x: 10.4, y: 52.6 });

    expect(electronMock.fromWebContents).toHaveBeenCalledWith({ marker: "s" });
    expect(popup).toHaveBeenCalledWith({ window: win, x: 10, y: 53 });
  });

  test("omits non-finite coordinates so Electron falls back to the cursor", () => {
    const popup = appMenuWithSubmenuAt(0);
    const win = { id: 1 };
    electronMock.fromWebContents.mockReturnValue(win);

    electronMock.popupListener?.({ sender: {} }, { index: 0, x: Number.NaN });

    expect(popup).toHaveBeenCalledWith({ window: win });
  });

  test("applies x and y independently when only one is finite", () => {
    const popup = appMenuWithSubmenuAt(0);
    const win = { id: 1 };
    electronMock.fromWebContents.mockReturnValue(win);

    electronMock.popupListener?.({ sender: {} }, { index: 0, y: 40 });

    expect(popup).toHaveBeenCalledWith({ window: win, y: 40 });
  });

  const invalidPayloads: Array<[string, unknown]> = [
    ["null", null],
    ["non-object", "nope"],
    ["missing index", { x: 1, y: 2 }],
    ["string index", { index: "1", x: 1, y: 2 }]
  ];
  test.each(invalidPayloads)("ignores invalid payload: %s", (_label, payload) => {
    const popup = appMenuWithSubmenuAt(1);
    electronMock.fromWebContents.mockReturnValue({ id: 1 });

    electronMock.popupListener?.({ sender: {} }, payload);

    expect(popup).not.toHaveBeenCalled();
  });

  test("no-ops (without resolving a window) when the index has no submenu", () => {
    electronMock.appMenu = { items: [{ label: "Detached" }] };
    electronMock.fromWebContents.mockReturnValue({ id: 1 });

    electronMock.popupListener?.({ sender: {} }, { index: 0, x: 1, y: 2 });

    // The submenu check short-circuits before we ever look up the window.
    expect(electronMock.fromWebContents).not.toHaveBeenCalled();
  });

  test("no-ops when no BrowserWindow resolves from the sender", () => {
    const popup = appMenuWithSubmenuAt(0);
    electronMock.fromWebContents.mockReturnValue(null);

    electronMock.popupListener?.({ sender: {} }, { index: 0, x: 1, y: 2 });

    expect(popup).not.toHaveBeenCalled();
  });
});
