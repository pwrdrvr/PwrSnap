import { app, BrowserWindow, globalShortcut, Menu, shell } from "electron";
import { disposeRegionSelector, preWarmRegionSelector } from "./capture/region-selector";
import { bus } from "./command-bus";
import { showFloatOverForCapture } from "./float-over";
import { registerCaptureHandlers } from "./handlers/capture-handlers";
import { registerClipboardHandlers } from "./handlers/clipboard-handlers";
import { registerFloatOverHandlers } from "./handlers/float-over-handlers";
import { gcHardDeleteCaptures, registerLibraryHandlers } from "./handlers/library-handlers";
import { disposeIpcDispatcher, registerIpcDispatcher } from "./ipc";
import { getMainLogger, initializeMainLogger } from "./log";
import { closeDatabase, openDatabase } from "./persistence/db";
import { getCaptureById, listExpiredTrash } from "./persistence/captures-repo";
import { sweepStaleTempFiles, sweepTrash } from "./persistence/source-store";
import { resolveCacheFile } from "./render/coordinator";
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
  // ⌘⇧P → interactive capture. The dispatch routes through the command
  // bus so a future MCP / HTTP transport reuses the same path.
  const log = getMainLogger("pwrsnap:shortcut");
  const ok = globalShortcut.register(CAPTURE_SHORTCUT, () => {
    void runInteractiveCapture();
  });
  if (!ok) {
    log.warn("failed to register global shortcut", { shortcut: CAPTURE_SHORTCUT });
  }
}

async function runInteractiveCapture(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  const result = await bus.dispatch("capture:interactive", {}, { principal: "ipc" });
  if (!result.ok) {
    if (result.error.code === "cancelled") {
      // User pressed Esc on the selector — no-op.
      return;
    }
    log.warn("capture:interactive failed", { code: result.error.code, message: result.error.message });
    return;
  }
  showFloatOverForCapture(result.value.id);
}

/**
 * Protocol resolver. captureSourcePath wired in Phase 1.3, cacheFile
 * wired in Phase 1.6 to the render coordinator.
 */
const protocolResolver: ProtocolResolver = {
  async captureSourcePath(captureId) {
    const record = getCaptureById(captureId);
    if (record === null || record.deleted_at !== null) {
      return null;
    }
    return record.src_path;
  },
  async cacheFile(req) {
    return resolveCacheFile(req);
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
    registerCaptureHandlers();
    registerClipboardHandlers();
    registerFloatOverHandlers();
    registerLibraryHandlers();
    registerIpcDispatcher();
    installTray();
    preWarmRegionSelector();
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
    disposeRegionSelector();
    disposeTray();
    disposeIpcDispatcher();
    closeDatabase();
  });
}

bootstrapApp();
