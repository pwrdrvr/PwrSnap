import { app, dialog, globalShortcut, Menu, shell } from "electron";
import { disposeRegionSelector, preWarmRegionSelector } from "./capture/region-selector";
import { bus } from "./command-bus";
// (showFloatOverForCapture is no longer called from the bootstrap;
// the capture-handlers `capture:interactive` now drives the entire
// float-over lifecycle. Kept as an export from float-over.ts for the
// agent-flow / headless path.)
import { disposeFocusSink, installFocusSink } from "./focus-sink";
import { registerCaptureHandlers } from "./handlers/capture-handlers";
import { registerClipboardHandlers } from "./handlers/clipboard-handlers";
import { registerExportHandler } from "./handlers/export-handler";
import { registerFloatOverHandlers } from "./handlers/float-over-handlers";
import { gcHardDeleteCaptures, registerLibraryHandlers } from "./handlers/library-handlers";
import { registerOverlaysHandlers } from "./handlers/overlays-handlers";
import { disposeIpcDispatcher, registerIpcDispatcher } from "./ipc";
import { getMainLogger, initializeMainLogger } from "./log";
import { closeDatabase, openDatabase } from "./persistence/db";
import { getCaptureById, listExpiredTrash } from "./persistence/captures-repo";
import { effectiveSrcPathFor, sweepStaleTempFiles, sweepTrash } from "./persistence/source-store";
import { resolveCacheFile } from "./render/coordinator";
import { installProtocolHandlers, registerSchemesAsPrivileged, type ProtocolResolver } from "./protocols";
import { disposeTray, installTray } from "./tray";
import { createMainWindow, findMainLibraryWindow } from "./window";

const APP_NAME = "PwrSnap";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC. All rights reserved.";
const APP_WEBSITE = "https://pwrdrvr.com";
const CAPTURE_SHORTCUT = "CommandOrControl+Shift+P";
const isMac = process.platform === "darwin";

/**
 * E2E mode. When `PWRSNAP_E2E=1`, the bootstrap skips:
 *   - The global ⌘⇧P shortcut (Playwright drives capture through the
 *     command bus directly via `electronApp.evaluate(...)`; a real
 *     global shortcut would race with the host machine's keymap).
 *   - The tray icon (no Linux tray support in CI; on macOS the tray
 *     would steal focus from the test browser window).
 * Everything else — DB, command bus, IPC dispatcher, region selector
 * pre-warm, main window — runs unchanged so the assertions exercise
 * the same code paths a real user hits.
 */
const isE2E = process.env.PWRSNAP_E2E === "1";

function installApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      label: "Library",
      submenu: [
        {
          label: "Export Library…",
          click: () => {
            void runExportLibrary();
          }
        }
      ]
    },
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

async function runExportLibrary(): Promise<void> {
  const log = getMainLogger("pwrsnap:export");
  const result = await dialog.showOpenDialog({
    title: "Choose a destination for the PwrSnap export",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const destDir = result.filePaths[0]!;
  const dispatched = await bus.dispatch("library:export", { destDir }, { principal: "ipc" });
  if (!dispatched.ok) {
    log.warn("export library failed", { code: dispatched.error.code, message: dispatched.error.message });
    void dialog.showMessageBox({
      type: "error",
      message: "Export failed",
      detail: dispatched.error.message
    });
    return;
  }
  log.info("export library succeeded", { destDir: dispatched.value.destDir });
  void dialog.showMessageBox({
    type: "info",
    message: "Library exported",
    detail: `Snapshot at ${dispatched.value.destDir}`,
    buttons: ["Reveal in Finder", "OK"],
    defaultId: 0
  }).then((response) => {
    if (response.response === 0) shell.showItemInFolder(dispatched.value.manifestPath);
  });
}

async function runInteractiveCapture(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  // ⌘⇧P explicitly uses 'auto' mode — snap to a window if the cursor
  // is over one, drag for a free rect otherwise. Tray buttons send a
  // different mode for region-only / window-only flows.
  //
  // The handler owns the full lifecycle now (pre-show / populate /
  // hide-selector / activate-prev-app). We just wait for it to
  // finish and log non-cancellation errors.
  const result = await bus.dispatch(
    "capture:interactive",
    { mode: "auto" },
    { principal: "ipc" }
  );
  if (!result.ok && result.error.code !== "cancelled") {
    log.warn("capture:interactive failed", {
      code: result.error.code,
      message: result.error.message
    });
  }
}

/**
 * Protocol resolver. captureSourcePath wired in Phase 1.3, cacheFile
 * wired in Phase 1.6 to the render coordinator.
 */
const protocolResolver: ProtocolResolver = {
  async captureSourcePath(captureId) {
    const record = getCaptureById(captureId);
    if (record === null) {
      return null;
    }
    // Soft-deleted records resolve through their trash file
    // (`<userData>/.trash/<id>.png`) so the Trash view's thumbnails +
    // Focus image keep working — the user can see what they're about
    // to restore or permanently delete.
    return effectiveSrcPathFor(record);
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

  // Enable ScreenCaptureKit for window/screen capture on macOS.
  // Without this flag, Chromium / Electron may use the legacy
  // CGWindowList-based capturer for desktopCapturer.getSources —
  // which produces ON-SCREEN-RENDERING thumbnails (occlusion
  // included). With SCKit enabled, captures go through
  // WindowServer's backing-buffer pipeline, so the captured PNG
  // contains the window's actual rendered content even when
  // covered by other windows.
  //
  // Must be set BEFORE app.whenReady — Chromium reads command-line
  // flags during early init.
  if (process.platform === "darwin") {
    app.commandLine.appendSwitch(
      "enable-features",
      "ScreenCaptureKitMac,ScreenCaptureKitMacWindow,ScreenCaptureKitMacScreen,ScreenCaptureKitPickerScreen"
    );
  }

  // Single-instance lock. Without this, electron-vite hot-reloads
  // and crashed-but-orphaned dev runs accumulate parallel app
  // instances — both tray icons, both global shortcuts, both
  // alwaysOnTop region-selector windows fighting for clicks. The
  // first instance acquires the lock; subsequent processes find an
  // existing app, focus its main window, and exit immediately.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    // Another `pnpm dev` (or another launch of the .app) tried to
    // start. Raise (or recreate) the library singleton so the user
    // gets the window they were trying to launch.
    const main = findMainLibraryWindow() ?? createMainWindow();
    if (main.isMinimized()) main.restore();
    if (!main.isVisible()) main.show();
    main.focus();
  });

  // Privileged schemes MUST be registered before app is ready.
  registerSchemesAsPrivileged();

  app.setName(APP_NAME);

  // E2E isolation: each Playwright launch sets PWRSNAP_USER_DATA to
  // an isolated tmpdir so SQLite, captures dir, cache dir, and trash
  // all live in a throwaway location — no contamination between
  // specs and no risk of the suite writing into the developer's real
  // PwrSnap install. We can't rely on HOME alone because Electron
  // caches the userData path early using the binary's bundle name
  // ("Electron" under Playwright), which mangles the layout.
  const customUserData = process.env.PWRSNAP_USER_DATA;
  if (customUserData !== undefined && customUserData.length > 0) {
    app.setPath("userData", customUserData);
  }

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
    registerOverlaysHandlers();
    // export-handler.ts re-registers `library:export` over the
    // not-implemented stub from library-handlers.ts. Order matters.
    registerExportHandler();
    registerIpcDispatcher();
    if (!isE2E) {
      installTray();
    }
    // Focus-sink: an invisible 1×1 floating-level panel that absorbs
    // Cocoa's next-key-window cascade when the tray popover hides.
    // Without it, Cocoa picks the Library as next-key and raises
    // (un-minimizes) it. See focus-sink.ts for the full rationale.
    installFocusSink();
    preWarmRegionSelector();
    if (!isE2E) {
      registerCaptureShortcut();
    }
    createMainWindow();
    if (isE2E) {
      // E2E test bridge. Playwright's `electronApp.evaluate(fn, arg)`
      // runs `fn` in the main process; specs reach into the bus via
      // `globalThis.__PWRSNAP_TEST__.dispatch(name, req)` so a single
      // helper covers every command without per-command plumbing.
      // Lazy-required so production bundles don't even import this
      // shim's `bus` reference unless the flag is on.
      const { insertOrFindCapture } = await import("./persistence/captures-repo");
      const { getDb } = await import("./persistence/db");
      const { setFloatOverState } = await import("./float-over");
      const { showTrayPopoverForE2E, hideTrayPopoverForE2E } = await import("./tray");
      const { clipboard } = await import("electron");
      const testBridge = {
        dispatch: <Name extends string>(name: Name, req: unknown) =>
          bus.dispatch(name as never, req as never, { principal: "ipc" }),
        // Test-only helpers for seeding rows + reading internal state
        // that isn't bus-exposed. Every helper goes through the same
        // bridge surface so specs don't reach into module internals
        // via dynamic imports — those tend to drift across path /
        // bundler changes.
        seedCapture: (input: Parameters<typeof insertOrFindCapture>[0]) =>
          insertOrFindCapture(input),
        // Drive the float-over state machine directly. Used by
        // float-over-visibility.spec.ts to assert the toast actually
        // reaches isVisible:true and stays there past the auto-dismiss
        // window — the main bug class the prior e2e suite missed.
        setFloatOverState: (event: Parameters<typeof setFloatOverState>[0]) =>
          setFloatOverState(event),
        getOverlaysVersion: (captureId: string) => {
          const row = getDb()
            .prepare("SELECT overlays_version FROM captures WHERE id = ?")
            .get(captureId) as { overlays_version: number } | undefined;
          return row?.overlays_version ?? null;
        },
        // Read the system clipboard's current image. Returns null
        // when the clipboard doesn't currently hold an image. Used by
        // clipboard-copy.spec.ts to verify each preset (low/med/high)
        // produces an image of the expected width on the clipboard.
        readClipboardImage: () => {
          const img = clipboard.readImage();
          if (img.isEmpty()) return null;
          const size = img.getSize();
          return { width: size.width, height: size.height, isEmpty: false };
        },
        // Clear clipboard before the spec runs so we know any image
        // we read back came from THIS test's dispatch, not a stale
        // earlier paste.
        clearClipboard: () => {
          clipboard.clear();
        },
        // Tray-sizing test surface. `installTray()` is skipped in E2E
        // mode (no NSStatusItem in tests), so these helpers stand in
        // for the user clicking the tray icon. They drive the same
        // BrowserWindow + resize-channel plumbing the production
        // path uses; only the icon is bypassed.
        showTrayPopover: () => showTrayPopoverForE2E(),
        hideTrayPopover: () => hideTrayPopoverForE2E()
      };
      (globalThis as unknown as { __PWRSNAP_TEST__: typeof testBridge }).__PWRSNAP_TEST__ =
        testBridge;
      log.info("e2e bridge installed");
    }
    void runBootGc();

    app.on("activate", () => {
      // Fired when the user clicks the dock icon. Since the dock
      // icon only exists while the library is open, this normally
      // means "raise the library" — but also covers the case where
      // some macOS automation pokes us awake.
      //
      // The earlier `getAllWindows().length === 0` guard was dead
      // code: the focus-sink + tray + float-over panels persist for
      // the app's lifetime, so the array was never empty.
      const main = findMainLibraryWindow() ?? createMainWindow();
      if (main.isMinimized()) main.restore();
      if (!main.isVisible()) main.show();
      main.focus();
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
    disposeFocusSink();
    disposeIpcDispatcher();
    closeDatabase();
  });
}

bootstrapApp();
