import { app, dialog, globalShortcut, Menu, Notification, shell } from "electron";
import type { Settings } from "@pwrsnap/shared";
import { disposeRegionSelector, preWarmRegionSelector } from "./capture/region-selector";
import { bus } from "./command-bus";
import { installDevelopmentDockIcon } from "./development-dock-icon";
// (showFloatOverForCapture is no longer called from the bootstrap;
// the capture-handlers `capture:interactive` now drives the entire
// float-over lifecycle. Kept as an export from float-over.ts for the
// agent-flow / headless path.)
import { disposeFocusSink, installFocusSink } from "./focus-sink";
import { registerAppHandlers } from "./handlers/app-handlers";
import {
  clipboardHasPasteableImage,
  registerCaptureHandlers
} from "./handlers/capture-handlers";
import { registerClipboardHandlers } from "./handlers/clipboard-handlers";
import { registerExportHandler } from "./handlers/export-handler";
import { registerFloatOverHandlers } from "./handlers/float-over-handlers";
import { gcHardDeleteCaptures, registerLibraryHandlers } from "./handlers/library-handlers";
import { registerOverlaysHandlers } from "./handlers/overlays-handlers";
import { onSettingsChanged, registerSettingsHandlers } from "./handlers/settings-handlers";
import { DesktopSettingsService } from "./settings/desktop-settings-service";
import { join } from "node:path";
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
/** Settings (⌘,) stays hardcoded — it isn't exposed in the Hotkeys
 *  page, and the platform convention is well-established. Quick
 *  Capture / Region / Window / Video Capture are dynamically
 *  registered from `settings.hotkeys.*` via `wireHotkeyRegistrations`. */
const SETTINGS_SHORTCUT = "CommandOrControl+,";
const PASTE_FROM_CLIPBOARD_MENU_ID = "file-new-paste-from-clipboard";

/** The four hotkey kinds we register from `settings.hotkeys.*`. Order
 *  matters only for log readability. */
type HotkeyKind = "quickCapture" | "region" | "window" | "videoCapture";
const HOTKEY_KINDS: readonly HotkeyKind[] = [
  "quickCapture",
  "region",
  "window",
  "videoCapture"
];
const isMac = process.platform === "darwin";

/**
 * E2E mode. When `PWRSNAP_E2E=1`, the bootstrap skips:
 *   - The global ⌘⇧P shortcut (Playwright drives capture through the
 *     command bus directly via `electronApp.evaluate(...)`; a real
 *     global shortcut would race with the host machine's keymap).
 *   - The tray icon (no Linux tray support in CI; on macOS the tray
 *     would steal focus from the test browser window).
 *   - The single-instance lock (test launches use isolated userData
 *     and must be able to run beside a real/dev PwrSnap instance).
 * Everything else — DB, command bus, IPC dispatcher, region selector
 * pre-warm, main window — runs unchanged so the assertions exercise
 * the same code paths a real user hits.
 */
const isE2E = process.env.PWRSNAP_E2E === "1";
let pasteFromClipboardMenuItem: Electron.MenuItem | null = null;

function installApplicationMenu(): void {
  const openSettings = (): void => {
    void bus.dispatch("settings:open", {}, { principal: "ipc" });
  };
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: SETTINGS_SHORTCUT,
    click: openSettings
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New",
          submenu: [
            {
              id: PASTE_FROM_CLIPBOARD_MENU_ID,
              label: "Paste from Clipboard",
              enabled: false,
              click: () => {
                void runPasteFromClipboard();
              }
            }
          ]
        },
        { type: "separator" },
        isMac ? { role: "close" as const } : { role: "quit" as const }
      ]
    },
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
        ...(isMac
          ? []
          : [
              settingsItem,
              { type: "separator" as const }
            ]),
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

  const menu = Menu.buildFromTemplate(template);
  pasteFromClipboardMenuItem = menu.getMenuItemById(PASTE_FROM_CLIPBOARD_MENU_ID) ?? null;
  for (const item of menu.items) {
    if (item.label !== "File") continue;
    item.submenu?.on("menu-will-show", refreshPasteFromClipboardMenu);
    const newItem = item.submenu?.items.find((child) => child.label === "New");
    newItem?.submenu?.on("menu-will-show", refreshPasteFromClipboardMenu);
  }
  refreshPasteFromClipboardMenu();
  Menu.setApplicationMenu(menu);
}

function refreshPasteFromClipboardMenu(): void {
  if (pasteFromClipboardMenuItem === null) return;
  pasteFromClipboardMenuItem.enabled = clipboardHasPasteableImage();
}

async function runPasteFromClipboard(): Promise<void> {
  const log = getMainLogger("pwrsnap:clipboard");
  const result = await bus.dispatch(
    "capture:pasteFromClipboard",
    {},
    { principal: "ipc" }
  );
  if (!result.ok) {
    log.warn("paste from clipboard failed", {
      code: result.error.code,
      message: result.error.message
    });
    void dialog.showMessageBox({
      type: result.error.code === "no_image" ? "info" : "error",
      message: result.error.code === "no_image" ? "No image on the clipboard" : "Paste failed",
      detail: result.error.message
    });
    return;
  }
  const opened = await bus.dispatch(
    "library:openInLibrary",
    { captureId: result.value.id },
    { principal: "ipc" }
  );
  if (!opened.ok) {
    log.warn("paste succeeded but library open failed", {
      captureId: result.value.id,
      code: opened.error.code,
      message: opened.error.message
    });
  }
}

/** Map of HotkeyKind → currently-registered accelerator. We hold this
 *  so we can unregister cleanly when a setting changes (the
 *  globalShortcut API doesn't track "who registered what"). */
const registeredHotkeys = new Map<HotkeyKind, string>();

function handlerFor(kind: HotkeyKind): () => void {
  const log = getMainLogger("pwrsnap:shortcut");
  switch (kind) {
    case "quickCapture":
      return () => void runInteractiveCapture("auto");
    case "region":
      return () => void runInteractiveCapture("region");
    case "window":
      return () => void runInteractiveCapture("window");
    case "videoCapture":
      return () => {
        // Recording surface lands later (Phase 6/7). For now confirm
        // the binding fires end-to-end: a system notification (best-
        // effort; not every OS / build supports them) plus a warn log
        // so dev runs see it in the terminal.
        log.warn("video capture: coming soon (hotkey fired)");
        try {
          if (Notification.isSupported()) {
            new Notification({
              title: "Video capture is coming soon",
              body: "The recording surface ships in a later release. Your hotkey is wired up."
            }).show();
          }
        } catch (cause) {
          log.warn("video-capture notification failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      };
  }
}

/** Apply `settings.hotkeys.*` to the live globalShortcut registry.
 *  Idempotent: rebinds only the kinds whose accelerator changed. Empty
 *  string is the "unbound" sentinel and skips registration. */
function applyHotkeys(hotkeys: Settings["hotkeys"]): void {
  const log = getMainLogger("pwrsnap:shortcut");
  for (const kind of HOTKEY_KINDS) {
    const next = hotkeys[kind] ?? "";
    const prev = registeredHotkeys.get(kind) ?? "";
    if (next === prev) continue;
    if (prev !== "") {
      globalShortcut.unregister(prev);
      registeredHotkeys.delete(kind);
    }
    if (next === "") continue;
    const ok = globalShortcut.register(next, handlerFor(kind));
    if (!ok) {
      log.warn("failed to register hotkey (likely taken by another app)", {
        kind,
        accelerator: next
      });
      continue;
    }
    registeredHotkeys.set(kind, next);
  }
}

/** Boot-time + on-change hotkey registration. Reads the current
 *  settings, applies them, and subscribes to main-side change events
 *  so subsequent edits (Settings → Hotkeys, or external file rewrites
 *  funneled through `settings:write`) re-bind without a restart. */
async function wireHotkeyRegistrations(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  // The settings service is a tiny standalone class — load once,
  // apply current state, then ride the change event for future
  // updates. We deliberately don't reuse the lazy module-singleton in
  // `settings-handlers.ts` (it's also fine, but instantiating a
  // dedicated reader keeps the boot dependency graph one-way:
  // index.ts depends on settings, not the handlers' internal state).
  const userData = app.getPath("userData");
  const service = new DesktopSettingsService({
    filePath: join(userData, "pwrsnap-settings.json")
  });
  try {
    const settings = await service.read();
    applyHotkeys(settings.hotkeys);
  } catch (cause) {
    log.warn("hotkey wire-up: initial read failed (continuing with no bindings)", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  onSettingsChanged((settings) => {
    applyHotkeys(settings.hotkeys);
  });
}

function registerSettingsShortcut(): void {
  // ⌘, → open (or focus) the Settings window. Same bus-routing
  // discipline as ⌘⇧P so a future MCP / HTTP transport gets it for
  // free.
  const log = getMainLogger("pwrsnap:shortcut");
  const ok = globalShortcut.register(SETTINGS_SHORTCUT, () => {
    void bus.dispatch("settings:open", {}, { principal: "ipc" });
  });
  if (!ok) {
    log.warn("failed to register global shortcut", { shortcut: SETTINGS_SHORTCUT });
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

async function runInteractiveCapture(
  mode: "auto" | "region" | "window" = "auto"
): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  // The Quick Capture hotkey explicitly uses 'auto' mode — snap to a
  // window if the cursor is over one, drag for a free rect otherwise.
  // The Region / Window hotkeys force the selector into pure-rect /
  // pure-window mode respectively.
  //
  // The handler owns the full lifecycle now (pre-show / populate /
  // hide-selector / activate-prev-app). We just wait for it to
  // finish and log non-cancellation errors.
  const result = await bus.dispatch(
    "capture:interactive",
    { mode },
    { principal: "ipc" }
  );
  if (!result.ok && result.error.code !== "cancelled") {
    log.warn("capture:interactive failed", {
      code: result.error.code,
      message: result.error.message,
      mode
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

function shouldPreWarmRegionSelector(): boolean {
  return !(isE2E && process.env.PWRSNAP_E2E_SKIP_REGION_PREWARM === "1");
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
  if (isE2E && process.platform === "linux") {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
  }

  // Single-instance lock. Without this, electron-vite hot-reloads
  // and crashed-but-orphaned dev runs accumulate parallel app
  // instances — both tray icons, both global shortcuts, both
  // alwaysOnTop region-selector windows fighting for clicks. The
  // first instance acquires the lock; subsequent processes find an
  // existing app, focus its main window, and exit immediately.
  if (!isE2E) {
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
  }

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
    if (isE2E && process.platform === "darwin") {
      app.dock?.hide();
    } else {
      installDevelopmentDockIcon();
    }

    // ── Dev seeder CLI mode ───────────────────────────────────────
    // Detect `--seed=<profile>` BEFORE `openDatabase()`. The seeder's
    // first action is to wipe the data root; an early DB open would
    // place files there before the wipe ran, tripping the sentinel
    // guard ("contains data but no .pwrsnap-perf-root sentinel").
    // Production builds tree-shake the entire dev/seeder subtree out
    // — gate on `import.meta.env.DEV` (static substitution) plus a
    // runtime NODE_ENV defense-in-depth.
    if (import.meta.env.DEV && process.env.NODE_ENV !== "production") {
      const seedFlag = process.argv.find((arg) => arg.startsWith("--seed="));
      if (seedFlag !== undefined) {
        const seederModule = await import("./dev/seeder");
        // Register capture handlers so the runner can dispatch
        // `capture:ingest`. The handler body uses `getDb()` which
        // throws until `openDatabase()` runs — runner does that
        // itself, after wipe.
        registerCaptureHandlers();
        const name = seedFlag.slice("--seed=".length) as Parameters<
          typeof seederModule.runProfile
        >[0];
        const allowFlagged = process.argv.includes("--seed-stress");
        try {
          const result = await seederModule.runProfile(name, { allowFlagged });
          log.info("seed CLI run complete", result);
          app.exit(0);
        } catch (cause: unknown) {
          log.error("seed CLI run failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
          app.exit(1);
        }
        return; // do NOT bring up the rest of the UI
      }
    }

    // ── Normal boot ───────────────────────────────────────────────
    // Open the DB before anything else — cold first-INSERT cost
    // (~40ms) lands here instead of inside ⌘⇧P's <120ms budget.
    await openDatabase();
    installApplicationMenu();
    installProtocolHandlers(protocolResolver);
    registerAppHandlers();
    registerCaptureHandlers();
    registerClipboardHandlers();
    registerFloatOverHandlers();
    registerLibraryHandlers();
    registerOverlaysHandlers();
    registerSettingsHandlers();
    // Dev seeder — gated on DEV at static-substitution time + a
    // belt-and-suspenders runtime NODE_ENV check. Production builds
    // tree-shake the entire `dev/seeder` subtree out of the bundle.
    // (Tray menu only here; the CLI-flag path is handled earlier.)
    if (import.meta.env.DEV && process.env.NODE_ENV !== "production") {
      const { registerDevSeeder } = await import("./dev/seeder");
      registerDevSeeder();
    }
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
    // It is macOS-only by design; Linux/Xvfb does not have Cocoa's
    // cascade behavior, and hidden panel windows are unstable there.
    if (process.platform === "darwin") {
      installFocusSink();
    }
    if (shouldPreWarmRegionSelector()) {
      preWarmRegionSelector();
    }
    if (!isE2E) {
      // Settings (⌘,) is fixed; capture/region/window/video are
      // dynamically registered from settings + rebind on change.
      registerSettingsShortcut();
      void wireHotkeyRegistrations();
    }
    createMainWindow();

    // ── Dev probe-only CLI mode ───────────────────────────────────
    // Detect `--probe=<profile>` AFTER the full boot — unlike --seed,
    // probes need the live UI session (Library window, IPC dispatcher,
    // library handlers). Used to re-measure UI perf against an
    // already-seeded data root without paying the seed cost again.
    if (import.meta.env.DEV && process.env.NODE_ENV !== "production") {
      const probeFlag = process.argv.find((arg) => arg.startsWith("--probe="));
      if (probeFlag !== undefined) {
        const seederModule = await import("./dev/seeder");
        const name = probeFlag.slice("--probe=".length) as Parameters<
          typeof seederModule.runProbeOnly
        >[0];
        // Give the renderer a moment to mount + commit its first row
        // before we kick off the probes — the cold-load probe times
        // window-reload → firstPaint, which depends on the renderer
        // being subscribed.
        setTimeout(() => {
          seederModule
            .runProbeOnly(name)
            .then((result) => {
              log.info("probe CLI run complete", result);
              app.exit(0);
            })
            .catch((cause: unknown) => {
              log.error("probe CLI run failed", {
                message: cause instanceof Error ? cause.message : String(cause)
              });
              app.exit(1);
            });
        }, 1500);
      }
    }

    if (isE2E) {
      // E2E test bridge. Playwright's `electronApp.evaluate(fn, arg)`
      // runs `fn` in the main process; specs reach into the bus via
      // `globalThis.__PWRSNAP_TEST__.dispatch(name, req)` so a single
      // helper covers every command without per-command plumbing.
      // Lazy-required so production bundles don't even import this
      // shim's `bus` reference unless the flag is on.
      const { insertOrFindCapture, insertOrFindCapturesBatch } = await import(
        "./persistence/captures-repo"
      );
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
        // Batch variant — runs all inserts inside one SQLite
        // transaction so the chain pays one fsync instead of N.
        // Lets specs seed 100+ captures inside a single
        // `electronApp.evaluate` without blowing their time budget
        // on slow CI disks.
        seedCaptures: (inputs: Parameters<typeof insertOrFindCapture>[0][]) =>
          insertOrFindCapturesBatch(inputs),
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
        readClipboardBookmark: () => clipboard.readBookmark(),
        readClipboardText: () => clipboard.readText(),
        readClipboardFormats: () => clipboard.availableFormats(),
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
