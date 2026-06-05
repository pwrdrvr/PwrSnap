import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  Notification,
  shell
} from "electron";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { RecordingSubject, Settings } from "@pwrsnap/shared";
import {
  disposeRegionSelector,
  getLastWindowListSnapshot,
  hideSelector,
  pickRegion,
  preWarmRegionSelector
} from "./capture/region-selector";
import { releaseSnapshot } from "./capture/screen-snapshot";
import { activateApp, selfPidSet } from "./capture/window-list";
import { appWindowsOverlappingRect } from "./capture/rect-overlap";
import {
  resolveSelectionSourceApp,
  shouldConsiderRaisingOurWindows
} from "./capture/source-app";
import { getAppIconPath } from "./app-icons/app-icon-cache";
import { setFloatOverState } from "./float-over";
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
import { registerCodexHandlers } from "./handlers/codex-handlers";
import { registerLibraryChatHandlers } from "./handlers/library-chat-handlers";
import { registerSizzleChatHandlers } from "./handlers/sizzle-chat-handlers";
import { registerRenderHandlers } from "./handlers/render-handlers";
import { registerEditorHandlers } from "./handlers/editor-handlers";
import { registerExportHandler } from "./handlers/export-handler";
import { registerFloatOverHandlers } from "./handlers/float-over-handlers";
import { registerLayersHandlers } from "./handlers/layers-handlers";
import { gcHardDeleteCaptures, registerLibraryHandlers } from "./handlers/library-handlers";
import { registerRecordingHandlers } from "./handlers/recording-handlers";
import { installRecordingController } from "./recording/recording-controller";
import {
  needsAttention,
  readRecordingReadiness
} from "./recording/recording-permissions";
import { getRecordingService } from "./recording/recording-service";
import { isRecordingActive } from "./recording/recording-state";
import { onSettingsChanged, registerSettingsHandlers } from "./handlers/settings-handlers";
import { registerStorageHandlers } from "./handlers/storage-handlers";
import { registerSizzleHandlers } from "./handlers/sizzle-handlers";
import { registerCartHandlers } from "./handlers/cart-handlers";
import { getSizzleStore } from "./sizzle/sizzle-store";
import { DesktopSettingsService } from "./settings/desktop-settings-service";
import {
  checkForAppUpdatesNow,
  initAppUpdater,
  setUpdateChannelResolver
} from "./auto-updater";
import { disposeIpcDispatcher, registerIpcDispatcher } from "./ipc";
import { getMainLogger, initializeMainLogger } from "./log";
import { closeDatabase, getDb, openDatabase } from "./persistence/db";
import {
  getCaptureById,
  insertCapture,
  insertCapturesBatch,
  listCaptures,
  listExpiredTrash
} from "./persistence/captures-repo";
import { insertVideoMetadata } from "./persistence/video-repo";
import { migrateLegacyCaptureSources } from "./persistence/capture-source-maintenance";
import { migrateLegacyRenderCache } from "./persistence/render-cache-maintenance";
import { persistCaptureFromTempV2, sweepBundleTrash } from "./persistence/bundle-store";
import { getCacheSourcePath } from "./persistence/paths";
import { runBundleFilenameMaintenanceOnBoot } from "./persistence/bundle-filename-maintenance";
import { runVideoFilenameMaintenanceOnBoot } from "./persistence/video-filename-maintenance";
import { ensureEffectiveSrcPath, sweepStaleTempFiles, sweepTrash } from "./persistence/source-store";
import { resolveCacheFile } from "./render/coordinator";
import { destroyTextBakePool } from "./render/text-html-bake";
import { shutdownCompositeThumbnailWorker } from "./workers/composite-thumbnail-worker-client";
import { clipboardEvents } from "./clipboard-events";
import { CHROMIUM_DISK_CACHE_LIMIT_BYTES } from "./storage/accounting";
import { installProtocolHandlers, registerSchemesAsPrivileged, type ProtocolResolver } from "./protocols";
import {
  disposeTray,
  hideTrayPopoverForE2E,
  installTray,
  measureTrayFirstPaintForE2E,
  prewarmTrayWindow,
  showTrayPopoverForE2E
} from "./tray";
import { createMainWindow, findMainLibraryWindow, reclaimDockIconIfLibraryAlive } from "./window";
import {
  enableOpenFileForwardingToPrimary,
  forwardQueuedOpenFilesToPrimary,
  handleSecondInstanceArgv,
  markQueuedOpenFilesForwarded,
  processQueuedOpenFiles,
  singleInstanceOpenFileHandoffData,
  wireOpenFileHandler
} from "./open-file";

const APP_NAME = "PwrSnap";
const APP_COPYRIGHT = "Copyright © 2026 PwrDrvr LLC. All rights reserved.";
const APP_WEBSITE = "https://pwrsnap.com";
const APP_DOCS = "https://docs.pwrsnap.com";
const APP_ISSUE_REPORTER = "https://github.com/pwrdrvr/PwrSnap/issues/new";
/** Settings (⌘,) stays hardcoded — it's not user-rebindable (the
 *  Hotkeys page shows it as a fixed reference only), and the platform
 *  convention is well-established. Quick Capture / Region / Window /
 *  Full Screen / All Screens / Timed / Video Capture / Re-show last
 *  Float-Over are dynamically registered from `settings.hotkeys.*` via
 *  `wireHotkeyRegistrations`. */
const SETTINGS_SHORTCUT = "CommandOrControl+,";
const PASTE_FROM_CLIPBOARD_MENU_ID = "file-new-paste-from-clipboard";

/** The hotkey kinds we register from `settings.hotkeys.*`. Order
 *  matters only for log readability. */
type HotkeyKind =
  | "quickCapture"
  | "region"
  | "window"
  | "fullScreen"
  | "allScreens"
  | "timed"
  | "videoCapture"
  | "reshowFloatOver";
const HOTKEY_KINDS: readonly HotkeyKind[] = [
  "quickCapture",
  "region",
  "window",
  "fullScreen",
  "allScreens",
  "timed",
  "videoCapture",
  "reshowFloatOver"
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

/** Reflects the most recently observed `general.developerMode` value
 *  so the menu can be re-installed on settings change without re-
 *  reading the settings file. Defaults to false until the first
 *  settings read completes. */
let lastKnownDeveloperMode = false;

function installApplicationMenu(developerMode: boolean = lastKnownDeveloperMode): void {
  lastKnownDeveloperMode = developerMode;
  const openSettings = (
    sourceWindow?: { id: number; isDestroyed: () => boolean } | null
  ): void => {
    const options: Parameters<typeof bus.dispatch>[2] = { principal: "ipc" };
    if (sourceWindow !== undefined && sourceWindow !== null && !sourceWindow.isDestroyed()) {
      options.sourceWindowId = sourceWindow.id;
    }
    void bus.dispatch("settings:open", {}, options);
  };
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: SETTINGS_SHORTCUT,
    click: (_item, sourceWindow) => openSettings(sourceWindow)
  };
  // Stripped-down View menu — Reload / Force Reload / Toggle DevTools
  // are gated behind `general.developerMode`. Hidden by default so
  // end-users see the same trim native menu as any signed Mac app;
  // power users + bug reporters flip Developer Mode on in Settings.
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...(developerMode
      ? [
          { role: "reload" as const },
          { role: "forceReload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const }
        ]
      : []),
    { role: "resetZoom" as const },
    { role: "zoomIn" as const },
    { role: "zoomOut" as const },
    { type: "separator" as const },
    { role: "togglefullscreen" as const }
  ];
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
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
    {
      label: "Library",
      submenu: [
        {
          label: "Export Library…",
          click: () => {
            void runExportLibrary();
          }
        },
        { type: "separator" },
        {
          label: "Sizzle Reels…",
          click: () => {
            void bus.dispatch("sizzle:open", {}, { principal: "ipc" });
          }
        }
      ]
    },
    {
      role: "help",
      submenu: [
        // macOS surfaces About + Settings in the app menu, so Help omits
        // them there. Non-Mac has no app menu — mirror PwrAgent and
        // surface About + Settings at the top of Help instead.
        ...(isMac
          ? []
          : [
              {
                label: `About ${APP_NAME}`,
                click: () => {
                  app.showAboutPanel();
                }
              },
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const }
            ]),
        {
          label: "Check for Updates",
          click: () => {
            void checkForAppUpdatesNow("menu");
          }
        },
        {
          label: "Changelog",
          click: () => {
            void bus.dispatch("app:openDocumentWindow", { kind: "changelog" }, { principal: "ipc" });
          }
        },
        { type: "separator" },
        {
          label: "Documentation",
          click: async () => {
            await shell.openExternal(APP_DOCS);
          }
        },
        {
          label: "Report an Issue",
          click: async () => {
            await shell.openExternal(APP_ISSUE_REPORTER);
          }
        },
        {
          label: `${APP_NAME} Website`,
          click: async () => {
            await shell.openExternal(APP_WEBSITE);
          }
        },
        { type: "separator" },
        {
          label: "Third-party Licenses",
          click: () => {
            void bus.dispatch(
              "app:openDocumentWindow",
              { kind: "third-party-licenses" },
              { principal: "ipc" }
            );
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
    case "fullScreen":
      // Capture the display under the cursor end-to-end (no selector).
      // Same `capture:fullScreen` verb the tray's Full Screen tile uses.
      return () => void runFullScreenCapture();
    case "allScreens":
      // Stitch every connected display into one image. Same
      // `capture:allScreens` verb the tray uses; `"stitched"` matches
      // the Hotkeys row's "single image" description.
      return () => void runAllScreensCapture();
    case "timed":
      // 5-second countdown, then the auto-mode selector. Routed through
      // `capture:interactive` (mode `"timed"`), same as the tray tile.
      return () => void runInteractiveCapture("timed");
    case "videoCapture":
      // Fast Video Capture (issue #64). Opens the selector in auto
      // mode; the commit is routed to `recording:start` instead of
      // `capture:interactive`. The Snap/Video post-selection chooser
      // ships in a follow-up enhancement — for now this hotkey is
      // the explicit "record video" entry point and the existing
      // ⌘⇧C remains the explicit "take a snap" entry point.
      return () => void runInteractiveRecord();
    case "reshowFloatOver":
      // Re-pop the most recent capture's float-over toast (issue: the
      // toast auto-dismisses; this brings it back without re-capturing).
      return () => runReshowLastFloatOver();
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
  let currentChannel: Settings["updates"]["channel"] = "latest";
  try {
    const settings = await service.read();
    applyHotkeys(settings.hotkeys);
    // Pick up the persisted developer-mode flag and re-install the menu
    // so the View submenu matches the user's choice from the start of
    // this session (the early bootstrap call hit the false default).
    if (settings.general.developerMode !== lastKnownDeveloperMode) {
      installApplicationMenu(settings.general.developerMode);
    }
    currentChannel = settings.updates.channel;
  } catch (cause) {
    log.warn("hotkey wire-up: initial read failed (continuing with no bindings)", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  setUpdateChannelResolver(() => currentChannel);
  onSettingsChanged((settings) => {
    applyHotkeys(settings.hotkeys);
    if (settings.general.developerMode !== lastKnownDeveloperMode) {
      installApplicationMenu(settings.general.developerMode);
    }
    currentChannel = settings.updates.channel;
  });
  // Startup permission-routing decision (Fast Video Capture, issue
  // #64). Reads the current permission readiness; if any capability
  // needs attention AND the fingerprint differs from the last one we
  // routed for, opens Settings to the System Permissions page and
  // writes the new fingerprint back so a subsequent unchanged launch
  // doesn't re-nag. On darwin only — the Linux/CI build has no
  // permission surface to route to.
  if (process.platform === "darwin") {
    try {
      const settings = await service.read();
      const readiness = readRecordingReadiness();
      if (
        needsAttention(readiness) &&
        readiness.fingerprint !== settings.recording.lastRoutedPermissionFingerprint
      ) {
        log.info("routing to System Permissions on startup", {
          fingerprint: readiness.fingerprint,
          screenRecording: readiness.screenRecording,
          microphone: readiness.microphone,
          systemAudio: readiness.systemAudio
        });
        await service.write({
          recording: { lastRoutedPermissionFingerprint: readiness.fingerprint }
        });
        void bus.dispatch(
          "settings:open",
          { page: "system-permissions" },
          { principal: "ipc" }
        );
      }
    } catch (cause) {
      log.warn("startup permission routing skipped", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
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
  mode: "auto" | "region" | "window" | "timed" = "auto"
): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  // The Quick Capture hotkey explicitly uses 'auto' mode — snap to a
  // window if the cursor is over one, drag for a free rect otherwise.
  // The Region / Window hotkeys force the selector into pure-rect /
  // pure-window mode respectively. 'timed' runs the 5s countdown then
  // falls into the auto picker.
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

/** Full Screen hotkey — capture the display under the cursor with no
 *  selector. Mirrors the tray's Full Screen tile (`capture:fullScreen`). */
async function runFullScreenCapture(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  const result = await bus.dispatch("capture:fullScreen", {}, { principal: "ipc" });
  if (!result.ok && result.error.code !== "cancelled") {
    log.warn("capture:fullScreen failed", {
      code: result.error.code,
      message: result.error.message
    });
  }
}

/** All Screens hotkey — stitch every connected display into a single
 *  image. Mirrors the tray's All Screens tile (`capture:allScreens`,
 *  stitched mode). */
async function runAllScreensCapture(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  const result = await bus.dispatch(
    "capture:allScreens",
    { mode: "stitched" },
    { principal: "ipc" }
  );
  if (!result.ok && result.error.code !== "cancelled") {
    log.warn("capture:allScreens failed", {
      code: result.error.code,
      message: result.error.message
    });
  }
}

/** Re-show last Float-Over hotkey — re-pop the most recent live
 *  capture's toast over the screen without re-capturing. Reads the
 *  newest non-deleted capture straight from the repo (the float-over
 *  module keeps no persistent "last capture" of its own — its state
 *  resets to hidden on dismiss). No-op when the library is empty. */
function runReshowLastFloatOver(): void {
  const log = getMainLogger("pwrsnap:shortcut");
  // Runs inside a globalShortcut callback, so swallow + log any error
  // (a transient repo read failure, say) rather than letting it throw
  // out of the handler — same discipline as the bus-dispatch hotkeys.
  try {
    const { rows } = listCaptures({ limit: 1 });
    const last = rows[0];
    if (last === undefined) {
      log.info("re-show last float-over: no captures yet");
      return;
    }
    // Pass the full record so the toast populates immediately without a
    // renderer round-trip back to the library store.
    setFloatOverState({ kind: "show-loaded", captureId: last.id, record: last });
  } catch (cause) {
    log.warn("re-show last float-over failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

/**
 * Choose which of the overlapping PwrSnap windows to give keyboard
 * focus when we raise them for a recording. Prefer the Library (the
 * primary user-facing window in this app); fall back to the first
 * entry in the overlap set. `BrowserWindow.getAllWindows()` ordering
 * isn't documented as z-order, so a stable tie-breaker beats letting
 * implementation order decide.
 *
 * Caller invariant: `overlapping` is the result of
 * `appWindowsOverlappingRect` BEFORE the recording HUD has been
 * created. The HUD is only constructed when the state machine enters
 * preflight, which happens *after* this call (inside the awaited
 * `bus.dispatch("recording:start", ...)`), so the HUD can't appear
 * here and we don't need to filter it out. If a future caller invokes
 * this from a code path where the HUD is live, pass `excludeWindow`
 * to `appWindowsOverlappingRect` first.
 */
function pickFocusTargetForRecording(overlapping: BrowserWindow[]): BrowserWindow {
  const library = findMainLibraryWindow();
  if (library !== null && overlapping.includes(library)) {
    return library;
  }
  return overlapping[0]!;
}

/**
 * Fast Video Capture entry (issue #64). Opens the selector to pick a
 * region/window, then routes the commit to `recording:start` instead
 * of `capture:interactive`. The Snap-vs-Video chooser ships later;
 * this is the explicit "record" entry point used by the videoCapture
 * hotkey and the tray's Record button.
 */
async function runInteractiveRecord(): Promise<void> {
  const log = getMainLogger("pwrsnap:shortcut");
  // Pick a rect / window via the existing region selector. We can't
  // route through capture:interactive (which persists an image on
  // commit), so we drive the region-selector module directly. On
  // commit we have the rect + displayId + (optional) snappedWindowId,
  // exactly the inputs `recording:start` wants.
  //
  // Imports are static (see file head). An earlier version used
  // `await import(...)` here to avoid a perceived circular-dep risk,
  // but electron-vite's main-process code-splitting paid the load+
  // parse cost on first invocation — ⌘⇧V's first press took ~5
  // seconds before the picker appeared (subsequent invocations were
  // instant because the chunks were cached). Static imports add no
  // measurable boot cost and remove the cold-press latency.
  const selection = await pickRegion({
    mode: "auto",
    keepPwrSnapChrome: false,
    intent: "video"
  });
  if (!selection.ok) {
    setFloatOverState({ kind: "cancel" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    hideSelector();
    if (selection.previousAppPid !== null && selection.previousAppPid !== undefined) {
      await activateApp(selection.previousAppPid);
      // Match the image-capture cancel branch — activateApp can
      // demote PwrSnap's activation policy to Accessory as a side-
      // effect of returning focus to the previous app, which leaves
      // the Library orphaned (alive but unreachable from the Dock or
      // ⌘-Tab). Reclaim Regular policy without yanking focus from
      // the previous app. See `capture-handlers.ts` for the matching
      // call on the image path.
      reclaimDockIconIfLibraryAlive();
    }
    return;
  }
  const { screenSnapshotId, previousAppPid } = selection;
  // CRITICAL: the selector is at screen-saver level and would
  // otherwise be in the captured pixels for the entire countdown +
  // first frames of the recording. Drop it BEFORE `recording:start`
  // (which awaits the 3s countdown before the recorder spawns) so
  // the captured pixels are the user's actual workspace, not our
  // orange selector frame. The countdown HUD lives in its own
  // floating panel at top-center; the in-area overlay (when added)
  // is also outside the selector's lifecycle.
  hideSelector();
  void releaseSnapshot(screenSnapshotId);

  // Focus / z-order policy. Three cases:
  //
  //   • Snap to one of OUR windows, OR free-region drag whose rect
  //     overlaps one of ours → raise our window(s). The user clearly
  //     wants PwrSnap visible in the recording.
  //   • Snap to ANOTHER app's window → leave our windows alone and run
  //     activateApp(previousAppPid). Raising the Library here would
  //     obscure the very window the user picked (e.g. Library sitting
  //     partially behind Claude on screen — overlap detection would
  //     match, but the recording subject is Claude, not us).
  //   • Snap to one of ours but the rect doesn't actually intersect
  //     any visible BrowserWindow (e.g. that window just closed) →
  //     fall through to the previous-app activation; nothing to raise.
  const cachedSnapshot = getLastWindowListSnapshot();
  const shouldRaise = shouldConsiderRaisingOurWindows(
    selection.snappedWindowId,
    cachedSnapshot,
    selfPidSet()
  );
  const overlapping = shouldRaise
    ? appWindowsOverlappingRect(selection.rect, selection.displayId)
    : [];
  // Debug-only — useful when triaging "Library hid / dove under"
  // reports. Turn on with `electron-log` debug; default level keeps
  // this out of the dev terminal on every video recording.
  log.debug("video-record post-commit focus policy", {
    snappedWindowId: selection.snappedWindowId ?? null,
    previousAppPid,
    shouldRaise,
    overlappingCount: overlapping.length,
    overlappingTitles: overlapping.map((w) => w.getTitle()),
    dockVisibleBefore: app.dock?.isVisible() ?? null,
    libraryAlive: findMainLibraryWindow() !== null
  });
  if (overlapping.length > 0) {
    // Two-step "really bring PwrSnap forward" because Electron's
    // app.focus() + window.focus() are unreliable when the app's
    // activation policy has drifted to Accessory (NSUIElement) — a
    // previous activateApp() side-effect.
    //
    //   1. `reclaimDockIconIfLibraryAlive()` → calls
    //      `app.dock.show()` which forcibly re-asserts Regular
    //      activation policy. Without this the next focus() is a
    //      no-op while Accessory.
    //   2. `activateApp(process.pid)` → goes through the same native
    //      NSRunningApplication.activate helper we use to bring
    //      OTHER apps forward, but pointed at our own pid. This
    //      bypasses Electron entirely and uses the macOS API
    //      directly. More reliable than `app.focus({ steal: true })`
    //      which has had spotty behavior with our floating panels
    //      (focus-sink + HUD) in the window list.
    reclaimDockIconIfLibraryAlive();
    await activateApp(process.pid);
    for (const win of overlapping) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.moveTop();
    }
    pickFocusTargetForRecording(overlapping).focus();
    log.debug("video-record raised our windows", {
      ownPid: process.pid,
      dockVisibleAfter: app.dock?.isVisible() ?? null
    });
  } else if (previousAppPid !== null) {
    await activateApp(previousAppPid);
    // Same reclaim as the image-capture path — activateApp deactivates
    // PwrSnap; AppKit can demote our activation policy to Accessory as
    // a side-effect, stripping the Dock icon and orphaning the Library.
    reclaimDockIconIfLibraryAlive();
    log.debug("video-record activated previous app", { previousAppPid });
  }
  const settings = await new DesktopSettingsService({
    filePath: join(app.getPath("userData"), "pwrsnap-settings.json")
  }).read();
  // Honor the user's persisted audio defaults; the in-context
  // recording dialog (a later enhancement) can override these.
  const capabilities = {
    systemAudio: settings.recording.includeSystemAudio,
    microphone: settings.recording.includeMicrophone
  };
  // Source-app attribution mirrors the image-capture path
  // (capture-handlers.ts) via the shared `resolveSelectionSourceApp`
  // helper: snap-target id first, rect-center hit test as fallback,
  // null if neither resolves. This runs whether the user held ⇧ at
  // commit time or just clicked — both shapes attribute the same app
  // for the same selection. We also reuse the cached window-list
  // snapshot rather than re-running `listWindows()`, so the lookup
  // matches the list the user actually picked against (no drift if
  // a window moved/closed in the ~50ms between hideSelector + here).
  const sourceApp = resolveSelectionSourceApp(
    selection.rect,
    selection.snappedWindowId,
    getLastWindowListSnapshot()
  );
  // A snapshot windowId in the selection means the user pointed at a
  // specific window (with or without ⇧). Persist that as a `window`
  // subject so the Library row shows the source app even when the
  // user didn't opt into the full-window capture path. Region kind
  // is reserved for free-hand drags where no window was snapped.
  let subject: RecordingSubject;
  if (selection.snappedWindowId !== undefined) {
    subject = {
      kind: "window",
      windowId: selection.snappedWindowId,
      rect: selection.rect,
      displayId: selection.displayId,
      appName: sourceApp?.appName ?? null,
      appBundleId: sourceApp?.bundleId ?? null
    };
  } else {
    subject = {
      kind: "region",
      rect: selection.rect,
      displayId: selection.displayId
    };
  }
  const result = await bus.dispatch(
    "recording:start",
    { subject, capabilities, countdownSeconds: 3 },
    { principal: "ipc" }
  );
  if (!result.ok) {
    log.warn("recording:start failed", { code: result.error.code, message: result.error.message });
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
    // to restore or permanently delete. Bundle-backed live captures
    // lazy-extract source.png from the bundle if the per-capture
    // cache file has been wiped (Storage → Clear/Trim, manual rm).
    return await ensureEffectiveSrcPath(record);
  },
  async cacheFile(req) {
    return resolveCacheFile(req);
  },
  async appIconPath(bundleId) {
    return getAppIconPath(bundleId);
  },
  async sizzleOutputPath(projectId) {
    const project = await getSizzleStore().get(projectId);
    if (project?.outputPath === null || project?.outputPath === undefined) {
      return null;
    }
    try {
      await access(project.outputPath);
      return project.outputPath;
    } catch {
      return null;
    }
  }
};

const log = getMainLogger("pwrsnap:bootstrap");
const ASSET_FILENAME_MAINTENANCE_BOOT_DELAY_MS = 2_000;

async function runBootGc(): Promise<void> {
  // Tmp file orphans first — cheap, no DB.
  await sweepStaleTempFiles();
  // Trash sweep — hard-delete captures whose deleted_at exceeded
  // retention; cascading delete also drops their render_cache rows.
  const expired = listExpiredTrash(14);
  if (expired.length > 0) {
    log.info("gc: hard-deleting expired captures", { count: expired.length });
    // Sweep both layouts: legacy <id>.png flat trash files, and
    // bundle-pair <id>/ directories. Both are best-effort; either
    // one missing for a given id is fine.
    await Promise.allSettled([sweepTrash(expired), sweepBundleTrash(expired)]);
    gcHardDeleteCaptures(expired);
  }
}

function scheduleAssetFilenameMaintenance(): void {
  setTimeout(() => {
    void runBundleFilenameMaintenanceOnBoot()
      .then(() => runVideoFilenameMaintenanceOnBoot())
      .catch((err: unknown) => {
        log.warn("asset filename maintenance failed", {
          message: err instanceof Error ? err.message : String(err)
        });
      });
  }, ASSET_FILENAME_MAINTENANCE_BOOT_DELAY_MS);
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
  app.commandLine.appendSwitch("disk-cache-size", String(CHROMIUM_DISK_CACHE_LIMIT_BYTES));

  // open-file MUST be registered before the single-instance lock and
  // before `app.whenReady()` resolves. macOS can fire it during cold
  // start with the path the user double-clicked in Finder. If this
  // process loses the single-instance lock, those queued paths are
  // forwarded to the already-running instance via Electron's
  // `additionalData` handoff below.
  wireOpenFileHandler();

  // Single-instance lock. Without this, electron-vite hot-reloads
  // and crashed-but-orphaned dev runs accumulate parallel app
  // instances — both tray icons, both global shortcuts, both
  // alwaysOnTop region-selector windows fighting for clicks. The
  // first instance acquires the lock; subsequent processes find an
  // existing app, focus its main window, and exit immediately.
  if (!isE2E) {
    const gotLock = app.requestSingleInstanceLock(singleInstanceOpenFileHandoffData());
    if (!gotLock) {
      // Finder may deliver macOS's open-file event just after the
      // losing process asks for the single-instance lock. Stay alive
      // briefly as a forward-only stub so that event can still be
      // relayed to the primary/dev instance before this process exits.
      enableOpenFileForwardingToPrimary();
      markQueuedOpenFilesForwarded();
      forwardQueuedOpenFilesToPrimary();
      setTimeout(() => {
        forwardQueuedOpenFilesToPrimary();
        app.quit();
      }, 350);
      return;
    }
    app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
      // Another `pnpm dev` (or another launch of the .app) tried to
      // start. Raise (or recreate) the library singleton so the user
      // gets the window they were trying to launch.
      const main = findMainLibraryWindow() ?? createMainWindow();
      if (main.isMinimized()) main.restore();
      if (!main.isVisible()) main.show();
      main.focus();
      // If the second instance was launched with a file path, route it
      // to the open-file pipeline. Paths can come from argv (CLI /
      // drag-to-Dock) or from the losing process's open-file queue
      // via Electron's additionalData handoff (Finder double-click of
      // the installed app while a dev build owns the lock).
      handleSecondInstanceArgv(argv, additionalData);
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
    await migrateLegacyCaptureSources();
    await migrateLegacyRenderCache();
    installApplicationMenu();
    // Issue #139 — wire the menu refresh + renderer broadcast to OUR
    // clipboard writes. menu-will-show alone was insufficient on macOS;
    // the in-app "Copy MED" flow now updates the menu state at write
    // time. Listeners outlive the menu (re-set on developerMode change
    // via installApplicationMenu), so this single subscribe survives
    // every menu rebuild.
    clipboardEvents.on("changed", () => {
      refreshPasteFromClipboardMenu();
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(EVENT_CHANNELS.clipboardChanged, {});
      }
    });
    installProtocolHandlers(protocolResolver);
    registerAppHandlers();
    registerSettingsHandlers();
    void bus
      .dispatch("settings:refreshCodexDiscovery", { force: true }, { principal: "ipc" })
      .then((result) => {
        if (!result.ok) {
          log.warn("startup Codex readiness probe failed", {
            code: result.error.code,
            message: result.error.message
          });
        }
      });
    registerCodexHandlers();
    registerLibraryChatHandlers();
    registerSizzleChatHandlers();
    registerCaptureHandlers();
    registerClipboardHandlers();
    registerFloatOverHandlers();
    registerLibraryHandlers();
    registerRecordingHandlers();
    registerStorageHandlers();
    registerLayersHandlers();
    registerRenderHandlers();
    registerEditorHandlers();
    registerSizzleHandlers();
    registerCartHandlers();
    // Wire the floating recording HUD so it appears whenever the
    // recording service is non-idle. Has to be installed AFTER the
    // BrowserWindow + handler plumbing because the controller creates
    // a BrowserWindow on the first state transition.
    installRecordingController();
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
    // Drain any `.pwrsnap` paths the OS handed us during cold-start
    // (macOS `app.on('open-file')` fires before whenReady; we queue
    // and dispatch here once the DB + handlers + main window are
    // ready). For each path, looks up the capture by id and opens
    // the editor window. See open-file.ts for the resolution flow.
    processQueuedOpenFiles();
    if (!isE2E) {
      // Auto-update needs the channel resolver wired
      // (wireHotkeyRegistrations sets it). In production, kicks off
      // an initial check after the main window has mounted so the
      // renderer's banner subscription is alive to receive events.
      // No-op in development (skips gracefully).
      initAppUpdater();
    }
    scheduleAssetFilenameMaintenance();

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
      // Bridge dependencies are statically imported at the top of the
      // file — earlier versions used `await import(...)` here for
      // perceived production-bundle hygiene, but every one of those
      // modules is already statically imported elsewhere in the main
      // bundle (tray/float-over/db/captures-repo/electron), so the
      // dynamic imports created zero chunking benefit and tripped
      // Vite's "dynamically imported but also statically imported"
      // warnings on every dev/build run.
      const testBridge = {
        dispatch: <Name extends string>(name: Name, req: unknown) =>
          bus.dispatch(name as never, req as never, { principal: "ipc" }),
        // Test-only helpers for seeding rows + reading internal state
        // that isn't bus-exposed. Every helper goes through the same
        // bridge surface so specs don't reach into module internals
        // via dynamic imports — those tend to drift across path /
        // bundler changes.
        // seedCapture accepts the pre-bundle-storage `src_path` field
        // name as a back-compat alias. Migration 0005 renamed the
        // column to `legacy_src_path`, but specs pulled from main still
        // use the old name. Normalize here so specs work unchanged.
        seedCapture: (input: Parameters<typeof insertCapture>[0] & { src_path?: string }) => {
          const { src_path: legacyAlias, ...rest } = input;
          const normalized =
            legacyAlias !== undefined && rest.legacy_src_path === undefined
              ? { ...rest, legacy_src_path: legacyAlias }
              : rest;
          // v2 is the only bundle format. Default row-only seeds to v2 so
          // the editor's useCaptureModel resolves the v2 layer-tree model
          // — a `bundle_format_version = 1` row now resolves to an error
          // model (the v1 read path is gone). An explicit version in the
          // input still wins. (Harmless for `kind: "video"`: nothing reads
          // the flag for videos — they render via pwrsnap-capture://.)
          return insertCapture({ bundle_format_version: 2, ...normalized });
        },
        // Batch variant — runs all inserts inside one SQLite
        // transaction so the chain pays one fsync instead of N.
        // Lets specs seed 100+ captures inside a single
        // `electronApp.evaluate` without blowing their time budget
        // on slow CI disks. Same src_path alias applied to each input.
        seedCaptures: (inputs: Array<Parameters<typeof insertCapture>[0] & { src_path?: string }>) => {
          const normalized = inputs.map((input) => {
            const { src_path: legacyAlias, ...rest } = input;
            const withAlias =
              legacyAlias !== undefined && rest.legacy_src_path === undefined
                ? { ...rest, legacy_src_path: legacyAlias }
                : rest;
            // Default to v2 (the only bundle format); explicit wins. See
            // `seedCapture` above for the rationale.
            return { bundle_format_version: 2, ...withAlias };
          });
          return insertCapturesBatch(normalized);
        },
        // Insert the video_captures metadata row for a previously-
        // seeded `kind="video"` capture. Specs use this to drive the
        // float-over's video asset branch without spawning a real
        // recording (which would need TCC permission + a Mac).
        seedVideoMetadata: (input: Parameters<typeof insertVideoMetadata>[0]) =>
          insertVideoMetadata(input),
        // Seed a real bundle-backed capture by running the production
        // persistCaptureFromTempV2 pipeline — packs `.pwrsnap`, writes
        // the per-capture source.png cache under <userData>/render-cache/<id>/.
        // Specs that need to exercise bundle-vs-legacy code paths
        // (clear-render-cache recovery, etc.) seed through here instead
        // of the row-only `seedCapture` helper.
        persistBundleCapture: (input: Parameters<typeof persistCaptureFromTempV2>[0]) =>
          persistCaptureFromTempV2(input),
        // Resolve a capture's expected on-disk source.png cache path.
        // Specs use this to assert the file was created at capture
        // time, wiped by Clear, and re-materialized on the next read.
        getCacheSourcePathFor: (captureId: string) => getCacheSourcePath(captureId),
        // Drive the float-over state machine directly. Used by
        // float-over-visibility.spec.ts to assert the toast actually
        // reaches isVisible:true and stays there past the auto-dismiss
        // window — the main bug class the prior e2e suite missed.
        setFloatOverState: (event: Parameters<typeof setFloatOverState>[0]) =>
          setFloatOverState(event),
        getEditsVersion: (captureId: string) => {
          const row = getDb()
            .prepare("SELECT edits_version FROM captures WHERE id = ?")
            .get(captureId) as { edits_version: number } | undefined;
          return row?.edits_version ?? null;
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
        hideTrayPopover: () => hideTrayPopoverForE2E(),
        // Performance baseline + regression surface. Returns checkpoint
        // deltas (ms relative to call) for the user-visible first-paint
        // path: window construction, dom-ready, did-finish-load,
        // ready-to-show, isVisible, first/stable renderer-resize IPC.
        // Auto-detects mode from the live tray-window state — "cold"
        // when no tray window exists, "prewarmed" when one is already
        // hidden + sized from boot. Spec consumer: tray-first-paint.spec.ts.
        measureTrayFirstPaint: (
          opts?: Parameters<typeof measureTrayFirstPaintForE2E>[0]
        ) => measureTrayFirstPaintForE2E(opts ?? {}),
        // E2E only: opt in to the prewarm-at-boot optimization. In
        // production this is done unconditionally from installTray()
        // — but E2E skips installTray(), so the bridge has to drive it.
        // Spec calls this before measure() to test the optimized path,
        // skips it to test the cold path.
        prewarmTrayPopover: () => {
          prewarmTrayWindow();
        },
        // Drive the open-file pipeline directly from a spec. Same
        // entry point used by `app.on('open-file')` (macOS GUI
        // double-click), `process.argv` cold-start sweeps (terminal
        // `open foo.pwrsnap`), and `second-instance` argv routing.
        // Specs use this to verify the read-manifest → look-up-row
        // → open-in-Library chain without needing to dispatch
        // real macOS NSAppleEvents from Playwright.
        triggerOpenFile: (path: string) => {
          handleSecondInstanceArgv([path]);
        },
        triggerOpenFileHandoff: (path: string) => {
          handleSecondInstanceArgv([], {
            pwrsnapOpenFilePaths: [path]
          });
        },
        // Dock-icon test surface (dock-lifecycle.spec.ts). The
        // capture flow's `activateApp(previousAppPid)` deactivates
        // PwrSnap and, with our floating panels in the window list,
        // AppKit demotes our activation policy to Accessory —
        // stripping the Dock icon and orphaning the Library. These
        // helpers let the spec simulate the strip + reclaim cycle
        // without needing the real screencapture pipeline (which
        // requires TCC permission Playwright doesn't have).
        //
        // `forceReclaimDockIcon` runs the same code production calls
        // after every activateApp — `reclaimDockIconIfLibraryAlive`
        // — with the E2E early-out bypassed. Used to assert the
        // recovery actually re-shows the Dock when the activation
        // policy has drifted to Accessory.
        dockIsVisible: () => app.dock?.isVisible() ?? false,
        // `app.dock.show()` returns a Promise that resolves when
        // AppKit has finished the policy write. Awaiting it inside
        // the bridge means the test's `await dockShow(app)` doesn't
        // race the Cocoa run loop.
        dockShow: async () => {
          if (process.platform !== "darwin") return;
          await app.dock?.show();
        },
        // `app.dock.hide()` is synchronous (calls setActivationPolicy
        // directly), but the visibility flip is observed on the next
        // run-loop tick. The spec's `expectDockVisible` polls, so we
        // don't need an explicit wait here.
        dockHide: () => {
          if (process.platform !== "darwin") return;
          app.dock?.hide();
        },
        forceReclaimDockIcon: () => reclaimDockIconIfLibraryAlive({ force: true }),
        // Library lifecycle helpers for the dock-lifecycle spec.
        // `getLibraryState` returns presence + visibility so the spec
        // can confirm "Library still exists" after a strip — the bug
        // is that the Library exists but is unreachable, not that
        // it's closed. `ensureLibrary` opens it idempotently for
        // tests that need a Library present.
        getLibraryState: (): {
          exists: boolean;
          visible: boolean;
          focused: boolean;
        } => {
          const win = findMainLibraryWindow();
          if (win === null) return { exists: false, visible: false, focused: false };
          return {
            exists: true,
            visible: win.isVisible(),
            focused: win.isFocused()
          };
        },
        ensureLibrary: () => {
          createMainWindow();
        }
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

    // Defense-in-depth Dock-icon recovery. The capture flow re-claims
    // the Dock icon right after every `activateApp(...)` call (see
    // capture-handlers.ts), but anything else that deactivates PwrSnap
    // while our floating-level panels are in the window list — a
    // future feature that activates another app, a macOS Mission
    // Control transition, a Stage Manager re-tile — can trip the same
    // AppKit demotion path and strip the Dock icon. Whenever PwrSnap
    // becomes inactive, if the Library still exists we re-assert
    // Regular activation policy on the next tick (we let the
    // deactivation settle first; calling app.dock.show() inside the
    // event handler can race with AppKit's policy write).
    //
    // setImmediate keeps us off the current Cocoa run-loop tick. The
    // re-claim is guarded by both `findMainLibraryWindow() !== null`
    // and `app.dock.isVisible() === false`, so steady-state inactive
    // apps with no Library aren't churned.
    if (process.platform === "darwin" && !isE2E) {
      app.on("did-resign-active", () => {
        setImmediate(() => {
          reclaimDockIconIfLibraryAlive();
        });
      });
    }
  });

  app.on("window-all-closed", () => {
    // The tray icon keeps the app alive after the main window closes —
    // matches the expected menubar-app lifecycle on every platform.
  });

  // Track whether we've already initiated the recording-cancel
  // teardown so we don't loop on the will-quit handler firing again
  // after `app.quit()` is called from inside it.
  let quitTeardownInFlight = false;
  app.on("will-quit", (event) => {
    // Fast Video Capture (issue #64): if a recording is active when
    // the user hits ⌘Q, cancel it cleanly BEFORE the rest of teardown
    // runs. Without this the Swift recorder is orphaned (parent dies,
    // launchd reparents it) and the user's clip is lost AND a stray
    // PwrSnapRecorder process sits in their process list until it
    // hits its own write error or the parent-death watchdog reaps it.
    if (isRecordingActive() && !quitTeardownInFlight) {
      quitTeardownInFlight = true;
      event.preventDefault();
      void getRecordingService()
        .cancel()
        .catch((cause) => {
          getMainLogger("pwrsnap:bootstrap").warn("cancel-on-quit failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
        })
        .finally(() => {
          // Retry the quit — the second time around the recording
          // state is idle so this branch falls through to the
          // ordinary teardown below.
          app.quit();
        });
      return;
    }
    globalShortcut.unregisterAll();
    disposeRegionSelector();
    disposeTray();
    disposeFocusSink();
    disposeIpcDispatcher();
    // Tear down the shared composite-thumbnail worker eagerly so an
    // in-flight encode (e.g. a deferred v1→v2 sweep still running) is
    // rejected and the worker terminated on our terms, rather than the
    // thread being reaped mid-event when the process exits.
    shutdownCompositeThumbnailWorker();
    // Destroy the hidden text-bake BrowserWindow pool. Without this,
    // an undead hidden window can keep the app process alive past
    // `will-quit`, which surfaces in Playwright E2E as "Worker
    // teardown timeout of 30000ms exceeded" after the spawned
    // Electron handle's `app.close()` returns but the OS process
    // hasn't actually exited.
    destroyTextBakePool();
    closeDatabase();
  });
}

bootstrapApp();
