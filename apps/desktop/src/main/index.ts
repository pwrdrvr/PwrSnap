import { app, BrowserWindow, globalShortcut, Menu, shell } from "electron";
import { showFloatOver } from "./float-over";
import { disposeIpcHandlers, registerIpcHandlers } from "./ipc";
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

export function bootstrapApp(): void {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: APP_COPYRIGHT
  });

  app.whenReady().then(() => {
    installApplicationMenu();
    registerIpcHandlers();
    installTray();
    registerCaptureShortcut();
    createMainWindow();

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
    disposeIpcHandlers();
  });
}

bootstrapApp();
