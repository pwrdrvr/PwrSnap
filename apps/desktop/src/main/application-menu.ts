// The application menu, laid out to the PwrSuite menu standard (v1) that
// PwrGit, PwrAgent and PwrSnap share. Reference: Claude Design project
// "PwrSuite", artboard "Menu Standard - Suite Review" (turn 2 is the
// standard, turn 3 the per-app change map).
//
//   [PwrSnap] · File · Edit · View · Library · Window · Help
//
// macOS keeps About, Check for Updates… and Settings… in the app menu.
// Elsewhere Settings… sits in File above Close Window and Quit, and Check
// for Updates… and About close out Help, About last. Help is grouped
// learn → get help → project → legal in every app, so an item is in the
// same place whichever Pwr app is open.
//
// This module is PURE: no Electron import beyond types, every action
// injected. `application-menu.test.ts` flattens the template per platform
// and pins the exact order, so a drift from the standard fails a unit test
// instead of shipping. index.ts owns the wiring (`installApplicationMenu`).

/** The window a menu click came from, as Electron hands it to `click`. */
export type MenuSourceWindow = Electron.BaseWindow | undefined;

export const PWRSNAP_MENU_LINKS = Object.freeze({
  documentation: "https://docs.pwrsnap.com",
  issues: "https://github.com/pwrdrvr/PwrSnap/issues/new",
  security: "https://github.com/pwrdrvr/PwrSnap/security/advisories/new",
  website: "https://pwrsnap.com",
  source: "https://github.com/pwrdrvr/PwrSnap"
});

/** Menu ids index.ts reads back from the built menu. */
export const PASTE_FROM_CLIPBOARD_MENU_ID = "file-new-paste-from-clipboard";
export const EDIT_UNDO_MENU_ID = "edit-undo";
export const EDIT_REDO_MENU_ID = "edit-redo";

/** One open PwrSnap window, for the Window menu off macOS. */
export type OpenWindowEntry = {
  id: number;
  label: string;
  focused: boolean;
};

export type ApplicationMenuActions = {
  onAbout: (window: MenuSourceWindow) => void;
  onCheckForUpdates: () => void;
  onOpenSettings: (window: MenuSourceWindow) => void;
  onPasteFromClipboard: () => void;
  onDuplicate: (
    window: MenuSourceWindow,
    mode: "duplicate" | "edit-copy",
    event: Electron.KeyboardEvent | undefined
  ) => void;
  onUndo: (window: MenuSourceWindow, event: Electron.KeyboardEvent | undefined) => void;
  onRedo: (window: MenuSourceWindow, event: Electron.KeyboardEvent | undefined) => void;
  onExportLibrary: () => void;
  onOpenSizzleReels: (window: MenuSourceWindow) => void;
  onOpenChangelog: (window: MenuSourceWindow) => void;
  onOpenLicense: (window: MenuSourceWindow) => void;
  onOpenThirdPartyNotices: (window: MenuSourceWindow) => void;
  onOpenLogs: (window: MenuSourceWindow) => void;
  onCopyDiagnostics: (window: MenuSourceWindow) => void;
  onOpenExternal: (url: string) => void;
  onFocusWindow: (id: number) => void;
};

export type ApplicationMenuOptions = {
  /** Settings → General → Developer Mode: expose Force Reload and Toggle
   *  Developer Tools. Reload Window is shown either way. */
  developerMode: boolean;
  /** Open PwrSnap windows, listed in the Window menu off macOS (macOS
   *  draws its own list under `role: "windowMenu"`). */
  openWindows: readonly OpenWindowEntry[];
  actions: ApplicationMenuActions;
};

type Item = Electron.MenuItemConstructorOptions;

const separator: Item = { type: "separator" };

export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform
): Item[] {
  const isMac = platform === "darwin";
  const { actions } = options;

  const settingsItem: Item = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: (_item, window) => actions.onOpenSettings(window)
  };
  // Decision A: About opens Settings → About on every platform — the page
  // carries the version, build and release-notes link; the native panel
  // shows little more than a name off macOS.
  const aboutItem: Item = {
    label: "About PwrSnap",
    click: (_item, window) => actions.onAbout(window)
  };
  const checkForUpdatesItem: Item = {
    label: "Check for Updates…",
    click: () => actions.onCheckForUpdates()
  };
  const link = (label: string, url: string): Item => ({
    label,
    click: () => actions.onOpenExternal(url)
  });

  const appMenu: Item = {
    role: "appMenu",
    submenu: [
      aboutItem,
      checkForUpdatesItem,
      separator,
      settingsItem,
      separator,
      { role: "services" },
      separator,
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      separator,
      { role: "quit" }
    ]
  };

  const closeWindowItem: Item = { role: "close", label: "Close Window" };
  const fileMenu: Item = {
    label: "File",
    submenu: [
      {
        label: "New",
        submenu: [
          {
            id: PASTE_FROM_CLIPBOARD_MENU_ID,
            label: "Paste from Clipboard",
            // Enabled from the live pasteboard on `menu-will-show`; see
            // refreshPasteFromClipboardMenu in index.ts.
            enabled: false,
            click: () => actions.onPasteFromClipboard()
          }
        ]
      },
      separator,
      {
        label: "Duplicate Snap",
        accelerator: "CmdOrCtrl+Shift+D",
        click: (_item, window, event) => actions.onDuplicate(window, "duplicate", event)
      },
      {
        label: "Edit a Copy",
        click: (_item, window, event) => actions.onDuplicate(window, "edit-copy", event)
      },
      separator,
      ...(isMac
        ? [closeWindowItem]
        : [settingsItem, separator, closeWindowItem, { role: "quit" } as Item])
    ]
  };

  // Custom Edit menu. Electron's `role: "editMenu"` is replaced only for
  // Undo/Redo: the built-in roles drive the browser's native edit-undo
  // (`webContents.undo()`), which cannot reach the editor's renderer-side
  // undo stack (crop, arrows, every canvas annotation). Our items send
  // `editUndo` / `editRedo` to the focused window, whose edit-menu bridge
  // does native text undo when a field is focused and editor undo
  // otherwise. Everything else mirrors what `role: "editMenu"` produces per
  // platform. The Windows/Linux Ctrl+Y redo convention lives in the
  // renderer bridge (one item can register only one accelerator). See
  // docs/solutions/2026-06-13-edit-menu-undo-redo-bridge.md.
  const editMenu: Item = {
    label: "Edit",
    submenu: [
      {
        id: EDIT_UNDO_MENU_ID,
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
        click: (_item, window, event) => actions.onUndo(window, event)
      },
      {
        id: EDIT_REDO_MENU_ID,
        label: "Redo",
        accelerator: "CmdOrCtrl+Shift+Z",
        click: (_item, window, event) => actions.onRedo(window, event)
      },
      separator,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...((isMac
        ? [
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
            separator,
            {
              label: "Speech",
              submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }]
            }
          ]
        : [{ role: "delete" }, separator, { role: "selectAll" }]) as Item[])
    ]
  };

  // Reload Window is always there: it is the way back when the renderer
  // stops drawing its own controls. Force Reload and Developer Tools stay
  // behind Developer Mode. Toggle Full Screen is listed off macOS only —
  // see the decision-E note at the end of this file.
  const viewMenu: Item = {
    label: "View",
    submenu: [
      { role: "reload", label: "Reload Window" },
      ...((options.developerMode
        ? [{ role: "forceReload" }, { role: "toggleDevTools" }]
        : []) as Item[]),
      separator,
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      ...((isMac ? [] : [separator, { role: "togglefullscreen" }]) as Item[])
    ]
  };

  const libraryMenu: Item = {
    label: "Library",
    submenu: [
      { label: "Export Library…", click: () => actions.onExportLibrary() },
      separator,
      // No ellipsis: this opens the Sizzle Reels window, nothing to
      // complete. ⇧⌘L is the Sizzle window's own "browse reels" key, which
      // is why Help → Logs carries no shortcut anywhere in the suite.
      { label: "Sizzle Reels", click: (_item, window) => actions.onOpenSizzleReels(window) }
    ]
  };

  const openWindowItems: Item[] = options.openWindows.map((entry) => ({
    label: entry.label,
    type: "checkbox",
    checked: entry.focused,
    click: () => actions.onFocusWindow(entry.id)
  }));
  const windowMenu: Item = isMac
    ? { role: "windowMenu" }
    : {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
          separator,
          ...(openWindowItems.length > 0
            ? openWindowItems
            : [{ label: "No Open Windows", enabled: false }])
        ]
      };

  const helpMenu: Item = {
    role: "help",
    submenu: [
      // Learn. PwrSnap has no onboarding, so no Replay Onboarding… item.
      link("PwrSnap Documentation", PWRSNAP_MENU_LINKS.documentation),
      { label: "Changelog", click: (_item, window) => actions.onOpenChangelog(window) },
      separator,
      // Get help.
      link("Report an Issue…", PWRSNAP_MENU_LINKS.issues),
      link("Report a Security Vulnerability…", PWRSNAP_MENU_LINKS.security),
      {
        label: "Copy Diagnostics Info",
        click: (_item, window) => actions.onCopyDiagnostics(window)
      },
      { label: "Logs", click: (_item, window) => actions.onOpenLogs(window) },
      separator,
      // Project.
      link("PwrSnap Website", PWRSNAP_MENU_LINKS.website),
      link("View Source", PWRSNAP_MENU_LINKS.source),
      separator,
      // Legal.
      { label: "View License", click: (_item, window) => actions.onOpenLicense(window) },
      {
        label: "Third-Party Notices",
        click: (_item, window) => actions.onOpenThirdPartyNotices(window)
      },
      ...(isMac ? [] : [separator, checkForUpdatesItem, aboutItem])
    ]
  };

  return [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    libraryMenu,
    windowMenu,
    helpMenu
  ];
}
