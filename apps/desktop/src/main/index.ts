import { app, BrowserWindow, globalShortcut, Menu, shell } from "electron";
import { showFloatOver } from "./float-over";
import { registerFloatOverHandlers } from "./handlers/float-over-handlers";
import { gcHardDeleteCaptures, registerLibraryHandlers } from "./handlers/library-handlers";
import { disposeIpcDispatcher, registerIpcDispatcher } from "./ipc";
import { getMainLogger, initializeMainLogger } from "./log";
import { closeDatabase, openDatabase } from "./persistence/db";
import { getCaptureById, listExpiredTrash } from "./persistence/captures-repo";
import { sweepStaleTempFiles, sweepTrash } from "./persistence/source-store";
import { installProtocolHandlers, registerSchemesAsPrivileged, type ProtocolResolver } from "./protocols";
import { disposeTray, installTray } from "./tray";
import { createMainWindow } from "./window";

const APP_NAME = "PwrSnap";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC. All rights reserved.";
const APP_WEBSITE = "https://pwrdrvr.com";
const CAPTURE_SHORTCUT = "CommandOrControl+Shift+P";
const isMac = process.platform === "darwin";

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () => {
            app.showAboutPanel();
          }
        },
        {
          label: "Visit Website",
          click: async () => {
            await shell.openExternal(APP_WEBSITE);
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerCaptureShortcut(): void {
  // A new ⌘⇧P always replaces any prior in-flight toast (showFloatOver
  // handles the swap). The shortcut is global, so this fires even when
  // the main window is hidden or another app is frontmost.
  const ok = globalShortcut.register(CAPTURE_SHORTCUT, () => {
    showFloatOver();
  });
  if (!ok) {
    // Another app already owns ⌘⇧P. We log and move on — the tray menu's
    // capture rows still work, and the user can rebind once we ship prefs.
    // eslint-disable-next-line no-console
    console.warn(`[pwrsnap] failed to register global shortcut ${CAPTURE_SHORTCUT}`);
  }
}

/**
 * Protocol resolver — Phase 1.3 implements `captureSourcePath` against
 * the captures-repo. `cacheFile` stays a stub until Phase 1.6 lands the
 * render coordinator.
 */
const protocolResolver: ProtocolResolver = {
  async captureSourcePath(captureId) {
    const record = getCaptureById(captureId);
    if (record === null || record.deleted_at !== null) {
      return null;
    }
    return record.src_path;
  },
  async cacheFile() {
    return null;
  }
};

const log = getMainLogger("pwrsnap:bootstrap");

async function runBootGc(): Promise<void> {
  // Tmp file orphans first — cheap, no DB.
  await sweepStaleTempFiles();
  // Trash sweep — hard-delete captures whose deleted_at exceeded
  // retention; cascading delete also drops their render_cache rows.
  const expired = listExpiredTrash(14);
  if (expired.length > 0) {
    log.info("gc: hard-deleting expired captures", { count: expired.length });
    await sweepTrash(expired);
    gcHardDeleteCaptures(expired);
  }
}

export function bootstrapApp(): void {
  initializeMainLogger();

  // Privileged schemes MUST be registered before app is ready.
  registerSchemesAsPrivileged();

  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: APP_COPYRIGHT
  });

  app.whenReady().then(async () => {
    // Open the DB before anything else — cold first-INSERT cost
    // (~40ms) lands here instead of inside ⌘⇧P's <120ms budget.
    await openDatabase();
    installApplicationMenu();
    installProtocolHandlers(protocolResolver);
    registerFloatOverHandlers();
    registerLibraryHandlers();
    registerIpcDispatcher();
    installTray();
    registerCaptureShortcut();
    createMainWindow();
    void runBootGc();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    // The tray icon keeps the app alive after the main window closes —
    // matches the expected menubar-app lifecycle on every platform.
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    disposeTray();
    disposeIpcDispatcher();
    closeDatabase();
  });
}

bootstrapApp();
