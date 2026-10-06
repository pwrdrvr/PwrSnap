// Pins the application menu to the PwrSuite menu standard (v1), shared with
// PwrGit and PwrAgent. Claude Design project "PwrSuite", artboard "Menu
// Standard - Suite Review": turn 2 is the standard, turn 3 the change map.
//
// The builder is pure, so every platform's layout is checked here on any
// host. A menu that drifts — an item moved, renamed, re-cased, or a
// separator lost — fails this file rather than shipping.

import { describe, expect, test, vi } from "vitest";
import {
  buildApplicationMenuTemplate,
  EDIT_REDO_MENU_ID,
  EDIT_UNDO_MENU_ID,
  PASTE_FROM_CLIPBOARD_MENU_ID,
  PWRSNAP_MENU_LINKS,
  type ApplicationMenuActions,
  type ApplicationMenuOptions
} from "../application-menu";

type Item = Electron.MenuItemConstructorOptions;
type Platform = "darwin" | "linux" | "win32";
const OTHER_PLATFORMS = ["linux", "win32"] as const;

function actions(): ApplicationMenuActions {
  return {
    onAbout: vi.fn(),
    onCheckForUpdates: vi.fn(),
    onOpenSettings: vi.fn(),
    onPasteFromClipboard: vi.fn(),
    onDuplicate: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onExportLibrary: vi.fn(),
    onOpenSizzleReels: vi.fn(),
    onOpenChangelog: vi.fn(),
    onOpenLicense: vi.fn(),
    onOpenThirdPartyNotices: vi.fn(),
    onOpenLogs: vi.fn(),
    onReloadWindow: vi.fn(),
    onCopyDiagnostics: vi.fn(),
    onOpenExternal: vi.fn(),
    onFocusWindow: vi.fn()
  };
}

function options(overrides: Partial<ApplicationMenuOptions> = {}): ApplicationMenuOptions {
  return { developerMode: false, openWindows: [], actions: actions(), ...overrides };
}

/** A top-level menu's name, whether given by label or by role. */
const nameOf = (item: Item): string => item.label ?? `role:${item.role ?? "?"}`;

/** Labels, roles and separators in order — the shape the standard pins. */
const flatten = (items: Item[]): string[] =>
  items.map((item) => (item.type === "separator" ? "---" : nameOf(item)));

function topLevel(platform: Platform, opts = options()): string[] {
  return buildApplicationMenuTemplate(opts, platform).map(nameOf);
}

function submenuOf(platform: Platform, name: string, opts = options()): Item[] {
  const menu = buildApplicationMenuTemplate(opts, platform).find(
    (item) => nameOf(item) === name
  );
  expect(menu, `${name} menu on ${platform}`).toBeDefined();
  return menu?.submenu as Item[];
}

const find = (items: Item[], label: string): Item | undefined =>
  items.find((item) => item.label === label);

/** Every item at any depth, for checks that span the whole menu. */
function everyItem(items: Item[]): Item[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? everyItem(item.submenu as Item[]) : [])
  ]);
}

const fakeWindow = { id: 7 } as unknown as Electron.BaseWindow;

function click(item: Item | undefined): void {
  expect(item).toBeDefined();
  (
    item?.click as
      | ((menuItem: unknown, window: unknown, event: unknown) => void)
      | undefined
  )?.({}, fakeWindow, { triggeredByAccelerator: false });
}

const HELP_SHARED = [
  "PwrSnap Documentation",
  "Changelog",
  "---",
  "Report an Issue…",
  "Report a Security Vulnerability…",
  "Copy Diagnostics Info",
  "Logs",
  "---",
  "PwrSnap Website",
  "View Source",
  "---",
  "View License",
  "Third-Party Notices"
];

describe("application menu — PwrSuite menu standard", () => {
  test("orders the menu bar [App] · File · Edit · View · Library · Window · Help", () => {
    expect(topLevel("darwin")).toEqual([
      "role:appMenu",
      "File",
      "Edit",
      "View",
      "Library",
      "role:windowMenu",
      "role:help"
    ]);
    for (const platform of OTHER_PLATFORMS) {
      expect(topLevel(platform)).toEqual([
        "File",
        "Edit",
        "View",
        "Library",
        "Window",
        "role:help"
      ]);
    }
  });

  test("keeps About, Check for Updates and Settings in the macOS app menu", () => {
    const appMenu = submenuOf("darwin", "role:appMenu");
    expect(flatten(appMenu)).toEqual([
      "About PwrSnap",
      "Check for Updates…",
      "---",
      "Settings…",
      "---",
      "role:services",
      "---",
      "role:hide",
      "role:hideOthers",
      "role:unhide",
      "---",
      "role:quit"
    ]);
    expect(find(appMenu, "Settings…")?.accelerator).toBe("CmdOrCtrl+,");
  });

  test("ends File with Close Window on macOS", () => {
    expect(flatten(submenuOf("darwin", "File"))).toEqual([
      "New",
      "---",
      "Duplicate Snap",
      "Edit a Copy",
      "---",
      "Close Window"
    ]);
  });

  test("puts Settings in File off macOS, above Close Window and Quit", () => {
    for (const platform of OTHER_PLATFORMS) {
      const file = submenuOf(platform, "File");
      expect(flatten(file)).toEqual([
        "New",
        "---",
        "Duplicate Snap",
        "Edit a Copy",
        "---",
        "Settings…",
        "---",
        "Close Window",
        "role:quit"
      ]);
      expect(find(file, "Settings…")?.accelerator).toBe("CmdOrCtrl+,");
      // Ctrl+W comes from the close role itself.
      expect(find(file, "Close Window")?.role).toBe("close");
    }
  });

  test("lays out Help learn → get help → project → legal, About last off macOS", () => {
    expect(flatten(submenuOf("darwin", "role:help"))).toEqual(HELP_SHARED);
    for (const platform of OTHER_PLATFORMS) {
      expect(flatten(submenuOf(platform, "role:help"))).toEqual([
        ...HELP_SHARED,
        "---",
        "Check for Updates…",
        "About PwrSnap"
      ]);
    }
  });

  test("lists About, Settings and Check for Updates exactly once per platform", () => {
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      const labels = everyItem(buildApplicationMenuTemplate(options(), platform)).map(
        (item) => item.label
      );
      for (const label of ["About PwrSnap", "Settings…", "Check for Updates…"]) {
        expect(labels.filter((l) => l === label), `${label} on ${platform}`).toHaveLength(1);
      }
    }
  });

  test("always offers Reload Window; Force Reload and DevTools only in Developer Mode", () => {
    // Toggle Full Screen stays on macOS as well: decision E measured that
    // AppKit adds no second one while the stock role is there
    // (scripts/macos-fullscreen-menu-probe.cjs).
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      expect(flatten(submenuOf(platform, "View"))).toEqual([
        "Reload Window",
        "---",
        "role:resetZoom",
        "role:zoomIn",
        "role:zoomOut",
        "---",
        "role:togglefullscreen"
      ]);
      expect(
        flatten(submenuOf(platform, "View", options({ developerMode: true })))
      ).toEqual([
        "Reload Window",
        "role:forceReload",
        "role:toggleDevTools",
        "---",
        "role:resetZoom",
        "role:zoomIn",
        "role:zoomOut",
        "---",
        "role:togglefullscreen"
      ]);
    }
  });

  test("keeps the Library menu's items, Sizzle Reels without an ellipsis", () => {
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      expect(flatten(submenuOf(platform, "Library"))).toEqual([
        "Export Library…",
        "---",
        "Sizzle Reels"
      ]);
    }
  });

  test("keeps the custom Undo/Redo bridge in Edit", () => {
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      const edit = submenuOf(platform, "Edit");
      expect(edit.slice(0, 2).map((item) => item.id)).toEqual([
        EDIT_UNDO_MENU_ID,
        EDIT_REDO_MENU_ID
      ]);
      expect(edit.slice(0, 2).map((item) => item.accelerator)).toEqual([
        "CmdOrCtrl+Z",
        "CmdOrCtrl+Shift+Z"
      ]);
    }
  });

  test("binds no ⇧⌘L anywhere: it is the Sizzle window's browse-reels key", () => {
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      const accelerators = everyItem(buildApplicationMenuTemplate(options(), platform)).map(
        (item) => item.accelerator
      );
      expect(accelerators).not.toContain("CmdOrCtrl+Shift+L");
      expect(accelerators).not.toContain("CommandOrControl+Shift+L");
    }
  });

  test("gives an ellipsis only to items that open something to complete", () => {
    const withEllipsis = everyItem(buildApplicationMenuTemplate(options(), "linux"))
      .map((item) => item.label)
      .filter((label): label is string => label?.endsWith("…") === true)
      .sort();
    expect(withEllipsis).toEqual([
      "Check for Updates…",
      "Export Library…",
      "Report a Security Vulnerability…",
      "Report an Issue…",
      "Settings…"
    ]);
  });
});

describe("Window menu", () => {
  test("macOS keeps the stock windowMenu role", () => {
    const menu = buildApplicationMenuTemplate(
      options({ openWindows: [{ id: 1, label: "Library", focused: true }] }),
      "darwin"
    ).find((item) => item.role === "windowMenu");
    expect(menu?.submenu).toBeUndefined();
  });

  test("lists open windows off macOS, checking the focused one", () => {
    for (const platform of OTHER_PLATFORMS) {
      const opts = options({
        openWindows: [
          { id: 1, label: "Library", focused: false },
          { id: 4, label: "Settings", focused: true }
        ]
      });
      const menu = submenuOf(platform, "Window", opts);
      expect(flatten(menu)).toEqual([
        "role:minimize",
        "---",
        "Library",
        "Settings"
      ]);
      expect(menu.slice(2).map((item) => [item.type, item.checked])).toEqual([
        ["checkbox", false],
        ["checkbox", true]
      ]);
      click(find(menu, "Library"));
      expect(opts.actions.onFocusWindow).toHaveBeenCalledWith(1);
    }
  });

  test("says so when no window is open", () => {
    const menu = submenuOf("win32", "Window");
    expect(flatten(menu)).toEqual(["role:minimize", "---", "No Open Windows"]);
    expect(find(menu, "No Open Windows")?.enabled).toBe(false);
  });

  test("binds Ctrl+W once — to File → Close Window, not again in Window", () => {
    for (const platform of OTHER_PLATFORMS) {
      const closeItems = everyItem(buildApplicationMenuTemplate(options(), platform)).filter(
        (item) => item.role === "close"
      );
      expect(closeItems.map((item) => item.label)).toEqual(["Close Window"]);
    }
  });
});

describe("menu actions", () => {
  test("routes every item to its action, with the source window", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const opts = options();
      const a = opts.actions;
      const help = submenuOf(platform, "role:help", opts);
      const file = submenuOf(platform, "File", opts);
      const app = platform === "darwin" ? submenuOf(platform, "role:appMenu", opts) : null;
      const settingsHome = app ?? file;
      const aboutHome = app ?? help;

      click(find(aboutHome, "About PwrSnap"));
      click(find(aboutHome, "Check for Updates…"));
      click(find(settingsHome, "Settings…"));
      click(find(help, "Changelog"));
      click(find(help, "Copy Diagnostics Info"));
      click(find(help, "Logs"));
      click(find(help, "View License"));
      click(find(help, "Third-Party Notices"));
      click(find(file, "Duplicate Snap"));
      click(find(file, "Edit a Copy"));
      click((find(file, "New")?.submenu as Item[])[0]);
      const library = submenuOf(platform, "Library", opts);
      click(find(library, "Export Library…"));
      click(find(library, "Sizzle Reels"));

      expect(a.onAbout).toHaveBeenCalledWith(fakeWindow);
      expect(a.onCheckForUpdates).toHaveBeenCalledOnce();
      expect(a.onOpenSettings).toHaveBeenCalledWith(fakeWindow);
      expect(a.onOpenChangelog).toHaveBeenCalledWith(fakeWindow);
      expect(a.onCopyDiagnostics).toHaveBeenCalledOnce();
      expect(a.onOpenLogs).toHaveBeenCalledWith(fakeWindow);
      expect(a.onOpenLicense).toHaveBeenCalledWith(fakeWindow);
      expect(a.onOpenThirdPartyNotices).toHaveBeenCalledWith(fakeWindow);
      expect(vi.mocked(a.onDuplicate).mock.calls.map((call) => call[1])).toEqual([
        "duplicate",
        "edit-copy"
      ]);
      expect(a.onPasteFromClipboard).toHaveBeenCalledOnce();
      expect(a.onExportLibrary).toHaveBeenCalledOnce();
      expect(a.onOpenSizzleReels).toHaveBeenCalledWith(fakeWindow);
    }
  });

  test("opens the canonical project links from Help", () => {
    const opts = options();
    const help = submenuOf("darwin", "role:help", opts);
    const expected = [
      ["PwrSnap Documentation", PWRSNAP_MENU_LINKS.documentation],
      ["Report an Issue…", PWRSNAP_MENU_LINKS.issues],
      ["Report a Security Vulnerability…", PWRSNAP_MENU_LINKS.security],
      ["PwrSnap Website", PWRSNAP_MENU_LINKS.website],
      ["View Source", PWRSNAP_MENU_LINKS.source]
    ] as const;
    for (const [label] of expected) click(find(help, label));
    expect(vi.mocked(opts.actions.onOpenExternal).mock.calls).toEqual(
      expected.map(([, url]) => [url])
    );
    expect(PWRSNAP_MENU_LINKS.security).toBe(
      "https://github.com/pwrdrvr/PwrSnap/security/advisories/new"
    );
  });

  test("Reload Window is ⌘R / Ctrl+R through the action, not the stock role", () => {
    for (const platform of ["darwin", ...OTHER_PLATFORMS] as const) {
      const opts = options();
      const reload = find(submenuOf(platform, "View", opts), "Reload Window");
      // The stock role reloads whatever is focused, chrome windows included.
      expect(reload?.role).toBeUndefined();
      expect(reload?.accelerator).toBe("CmdOrCtrl+R");
      click(reload);
      expect(opts.actions.onReloadWindow).toHaveBeenCalledWith(fakeWindow);
    }
  });

  test("Paste from Clipboard starts disabled and is found by id", () => {
    const file = submenuOf("linux", "File");
    const paste = (find(file, "New")?.submenu as Item[])[0];
    expect(paste?.id).toBe(PASTE_FROM_CLIPBOARD_MENU_ID);
    expect(paste?.enabled).toBe(false);
  });
});
