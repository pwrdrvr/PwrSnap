import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { join } from "node:path";
import type { AppDocumentKind } from "@pwrsnap/shared";
import { installDevelopmentDockIcon, showDockWithDevelopmentIcon } from "./development-dock-icon";
import { getStartupAppearanceArgs, getStartupBackgroundColor } from "./settings/startup-appearance";
import { getMainLogger } from "./log";
import { showWindowWhenReady } from "./window-show";

const log = getMainLogger("pwrsnap:window");
const SETTINGS_WINDOW_WIDTH = 1040;
const SETTINGS_WINDOW_HEIGHT = 720;
const SIZZLE_WINDOW_WIDTH = 1280;
const SIZZLE_WINDOW_HEIGHT = 820;
const APP_DOCUMENT_WINDOW_WIDTH = 920;
const APP_DOCUMENT_WINDOW_HEIGHT = 760;

/**
 * Module-level reference to the (singleton) Library window.
 *
 * Why a tracked ref instead of `BrowserWindow.getAllWindows().find(...)`:
 *
 *   1. The library's URL is the only one without a `stage=` fragment,
 *      but the focus-sink loads `data:text/html,` which ALSO has no
 *      stage — the URL-regex check would silently match the sink and
 *      "focus" / "raise" the wrong window.
 *   2. The dock-icon lifecycle (show on open, hide on close) needs to
 *      be wired to the SAME object the rest of the app treats as the
 *      library — easier to reason about with a single source of truth.
 *
 * Cleared in the `closed` handler.
 */
let libraryWindow: BrowserWindow | null = null;

/**
 * Module-level reference to the (singleton) Settings window.
 * Cleared in the `closed` handler. Same rationale as `libraryWindow`:
 * a single source of truth makes the "open / focus existing" verb
 * idempotent without scanning every BrowserWindow.
 */
let settingsWindow: BrowserWindow | null = null;
let sizzleWindow: BrowserWindow | null = null;
const appDocumentWindows = new Map<AppDocumentKind, BrowserWindow>();

type RendererStage =
  | "tray"
  | "float-over"
  | "settings"
  | "document"
  | "sizzle"
  | "recording-controller";
type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash?: string };

export function getPreloadPath(): string {
  return join(__dirname, "../preload/index.cjs");
}

function developmentRendererUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  return process.env.ELECTRON_RENDERER_URL;
}

function rendererTarget(stage?: RendererStage, extraHash?: string): RendererTarget {
  const baseHash = stage ? `stage=${stage}` : undefined;
  const hash = baseHash !== undefined && extraHash !== undefined
    ? `${baseHash}&${extraHash}`
    : baseHash ?? extraHash;
  const devUrl = developmentRendererUrl();
  if (devUrl !== undefined) {
    const url = devUrl + (hash ? `#${hash}` : "");
    return { kind: "url", url };
  }
  if (hash !== undefined) {
    return {
      kind: "file",
      path: join(__dirname, "../renderer/index.html"),
      hash
    };
  }
  return {
    kind: "file",
    path: join(__dirname, "../renderer/index.html")
  };
}

function loadRenderer(window: BrowserWindow, target: RendererTarget): void {
  if (target.kind === "url") {
    void window.loadURL(target.url);
  } else {
    void window.loadFile(target.path, target.hash ? { hash: target.hash } : undefined);
  }
}

const baseWebPreferences = {
  preload: getPreloadPath(),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false
} as const;

/** Build a per-window `webPreferences` that carries the persisted
 *  theme through `additionalArguments`. The preload reads it from
 *  `process.argv` and surfaces it on `window.__pwrsnapAppearance` so
 *  the inline bootstrap in `index.html` has a synchronous, main-side
 *  source of truth for the first paint — no localStorage race, no
 *  flash-of-wrong-theme on cold launch.
 *
 *  Resolved fresh per-window (rather than memoized) so a theme change
 *  in the Settings page propagates to the next window opened without
 *  any cache-invalidation plumbing. The read is a small synchronous
 *  JSON parse, cheap enough that the simpler model wins. */
function themedWebPreferences(): Electron.WebPreferences {
  return {
    ...baseWebPreferences,
    additionalArguments: [...getStartupAppearanceArgs()]
  };
}

function isE2E(): boolean {
  return process.env.PWRSNAP_E2E === "1";
}

function centeredWindowBoundsOnDisplay(
  width: number,
  height: number,
  display: Electron.Display
): { x: number; y: number } {
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + Math.max(0, wa.width - width) / 2),
    y: Math.round(wa.y + Math.max(0, wa.height - height) / 2)
  };
}

function sourceDisplayForWindow(sourceWindowId?: number): Electron.Display {
  const source =
    sourceWindowId !== undefined
      ? BrowserWindow.fromId(sourceWindowId)
      : BrowserWindow.getFocusedWindow() ?? libraryWindow;
  if (source !== null && source !== undefined && !source.isDestroyed()) {
    return screen.getDisplayMatching(source.getBounds());
  }
  return screen.getPrimaryDisplay();
}

export function positionSettingsWindowForSource(
  window: BrowserWindow,
  sourceWindowId?: number
): void {
  const display = sourceDisplayForWindow(sourceWindowId);
  const bounds = window.getBounds();
  const position = centeredWindowBoundsOnDisplay(bounds.width, bounds.height, display);
  window.setPosition(position.x, position.y, false);
}

export function positionSizzleWindowForSource(
  window: BrowserWindow,
  sourceWindowId?: number
): void {
  const display = sourceDisplayForWindow(sourceWindowId);
  const bounds = window.getBounds();
  const position = centeredWindowBoundsOnDisplay(bounds.width, bounds.height, display);
  window.setPosition(position.x, position.y, false);
}

export function positionAppDocumentWindowForSource(
  window: BrowserWindow,
  sourceWindowId?: number
): void {
  const display = sourceDisplayForWindow(sourceWindowId);
  const bounds = window.getBounds();
  const position = centeredWindowBoundsOnDisplay(bounds.width, bounds.height, display);
  window.setPosition(position.x, position.y, false);
}

/**
 * Re-claim the Dock icon when the Library window is alive but the
 * activation policy has drifted to Accessory (NSUIElement). Safe to
 * call any time; a no-op when Library is closed (the dock-icon-tied-
 * to-Library invariant means no icon should exist) or when the dock
 * is already visible.
 *
 * Why this exists: `activateApp(otherPid)` (in capture-handlers.ts)
 * deactivates PwrSnap to return the user to whichever app was
 * frontmost before they triggered a capture. With our floating-level
 * panels (focus-sink, tray, float-over) in the window list, AppKit
 * periodically demotes our activation policy to Accessory as a
 * side-effect of that deactivation — which strips the Dock icon and
 * orphans the Library window (alive but unreachable from the Dock or
 * ⌘-Tab). The pre-existing `focus` handler on the Library window only
 * recovered when the Library itself re-focused, but once PwrSnap is
 * Accessory, clicking the Library doesn't re-focus PwrSnap (Accessory
 * apps don't auto-activate on window click) — so the recovery never
 * fired and the user was stuck.
 *
 * Calling `app.dock.show()` re-asserts Regular activation policy
 * WITHOUT activating PwrSnap (no focus theft from whatever app the
 * user is currently typing in). The Dock icon comes back, the
 * Library becomes reachable again via the Dock, and the user's
 * keyboard focus in Claude / Terminal / etc. is preserved.
 *
 * The `installDevelopmentDockIcon` call inside
 * `showDockWithDevelopmentIcon` paints the dev/prod icon — no-op in
 * packaged builds, but harmless to call either way.
 */
export function reclaimDockIconIfLibraryAlive(options: { force?: boolean } = {}): void {
  if (process.platform !== "darwin") return;
  // Production E2E runs skip dock-icon claiming entirely (the
  // Playwright Electron binary shouldn't grab a Dock icon during
  // tests). The dedicated bug-fix spec opts in via `force: true` to
  // exercise the reclaim logic against a deliberately-stripped dock.
  if (isE2E() && options.force !== true) return;
  if (libraryWindow === null || libraryWindow.isDestroyed()) return;
  if (app.dock?.isVisible() === true) return;
  showDockWithDevelopmentIcon();
}

/**
 * Return the live singleton Library window, or null when no library is
 * currently open. Callers that want to ENSURE the library exists
 * should use `createMainWindow()` (idempotent) instead.
 */
export function findMainLibraryWindow(): BrowserWindow | null {
  if (libraryWindow !== null && !libraryWindow.isDestroyed()) {
    return libraryWindow;
  }
  return null;
}

/**
 * Create the Library window if one doesn't already exist; otherwise
 * return the existing singleton. Idempotent — clicking "Open Library"
 * five times raises the same window five times rather than spawning
 * five copies.
 *
 * Owns the dock-icon lifecycle on macOS: shows the icon when the
 * library becomes ready/focused, hides it when the library is closed.
 * The app stays alive in the background via the tray.
 */
export function createMainWindow(): BrowserWindow {
  if (libraryWindow !== null && !libraryWindow.isDestroyed()) {
    return libraryWindow;
  }
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "PwrSnap",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: getStartupBackgroundColor(),
    webPreferences: themedWebPreferences()
  });
  libraryWindow = window;

  loadRenderer(window, rendererTarget());

  // `showWindowWhenReady` handles the Linux `ready-to-show`
  // unreliability (see window-show.ts for the why); on macOS the
  // `ready-to-show` path wins exactly as before. The onShow callback
  // runs on whichever fallback fires first so the dock claim lines up
  // with the moment the window becomes visible to the user.
  showWindowWhenReady(window, {
    label: "main",
    onShow: () => {
      // Claim the dock icon as soon as the library is on screen. On
      // macOS this flips activation policy → Regular; on other
      // platforms `app.dock` is undefined and this is a no-op.
      if (process.platform === "darwin" && !isE2E()) {
        showDockWithDevelopmentIcon();
      }
    }
  });

  // Defensive re-claim: every focus on the library re-asserts the
  // dock icon. The `activateApp(previousAppPid)` call in the capture
  // flow (capture-handlers.ts) deactivates PwrSnap to return the user
  // to their previous app — that side-effect (in combination with our
  // persistent panel windows) periodically strips the dock icon's
  // representation. Re-claiming on the next Library focus puts it
  // back.
  //
  // BUT: macOS fires a CASCADE of focus events when the user
  // alt-tabs back to PwrSnap (window-key → window-main → app-active,
  // plus the focus-sink at floating level cascading down to Library).
  // Calling `app.dock?.show()` unconditionally on each one was
  // hammering `[NSApp setActivationPolicy:Regular]`, and every
  // policy-set call triggered AppKit to redraw the window
  // decorations — that's the 10× traffic-light flash users saw on
  // app refocus. Guard with `app.dock.isVisible()` so we only call
  // `show()` when the dock genuinely isn't visible (i.e. only
  // immediately after `activateApp()` stripped it). Subsequent
  // focus events become no-ops.
  window.on("focus", () => {
    if (process.platform !== "darwin") return;
    if (isE2E()) return;
    installDevelopmentDockIcon();
    if (app.dock?.isVisible()) return;
    showDockWithDevelopmentIcon();
  });

  // Lifecycle diagnostics — these helped track down the
  // "library closes after ~10s" bug, which turned out to be
  // a duplicate-instance issue, not a true window-close.
  window.on("close", () => log.info("main window close event", { id: window.id }));
  window.on("closed", () => {
    log.info("main window closed", { id: window.id });
    if (libraryWindow === window) libraryWindow = null;
    // No library = no dock icon. Tray icon keeps the app alive in the
    // background; the user re-opens via right-click → "Open Library".
    if (process.platform === "darwin") {
      app.dock?.hide();
    }
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.warn("main window renderer crashed", { id: window.id, reason: details.reason });
  });
  window.webContents.on("unresponsive", () => {
    log.warn("main window renderer unresponsive", { id: window.id });
  });

  // Re-enable pinch zoom for the library window. Electron disables
  // visual zoom by default — and "disabled" means more than "no
  // zoom"; Chromium silently drops the synthetic ctrl+wheel events
  // for trackpad pinch entirely. Calling setVisualZoomLevelLimits
  // with a non-degenerate range re-enables event dispatch. The
  // Editor's onWheel preventDefaults before the browser actually
  // visual-zooms. See Electron docs:
  // https://www.electronjs.org/docs/latest/api/web-contents#contentssetvisualzoomlevellimitsminimumlevel-maximumlevel
  // and preload/index.ts for the matching webFrame call (which
  // applies on every renderer reload).
  // (1, 1) does NOT re-enable. Range must be non-degenerate.
  window.webContents.setVisualZoomLevelLimits(1, 3);

  return window;
}

/**
 * Return the live singleton Settings window, or null when no Settings
 * window is currently open. Callers that want to ENSURE the window
 * exists should use `createSettingsWindow()` (idempotent) instead.
 */
export function findSettingsWindow(): BrowserWindow | null {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }
  return null;
}

/**
 * Create the Settings window if one doesn't already exist; otherwise
 * return the existing singleton. Idempotent — clicking "Open Settings"
 * five times raises the same window five times rather than spawning
 * five copies.
 *
 * Caller can append `&page=<id>` to the URL hash via `extraHash` if it
 * wants to deep-link a specific sidebar page; otherwise the renderer
 * defaults to "ai" via `useActivePage`.
 *
 * Note: the Settings window does NOT auto-size to content, so the
 * `setMinimumSize(0, 0)` rule (see tray / float-over) does not apply
 * here.
 */
export function createSettingsWindow(
  extraHash?: string,
  options: { sourceWindowId?: number | undefined } = {}
): BrowserWindow {
  if (settingsWindow !== null && !settingsWindow.isDestroyed()) {
    return settingsWindow;
  }
  const position = centeredWindowBoundsOnDisplay(
    SETTINGS_WINDOW_WIDTH,
    SETTINGS_WINDOW_HEIGHT,
    sourceDisplayForWindow(options.sourceWindowId)
  );
  const window = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "PwrSnap Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: getStartupBackgroundColor(),
    webPreferences: themedWebPreferences()
  });
  settingsWindow = window;

  loadRenderer(window, rendererTarget("settings", extraHash));

  showWindowWhenReady(window, { label: "settings" });

  window.on("close", () => log.info("settings window close event", { id: window.id }));
  window.on("closed", () => {
    log.info("settings window closed", { id: window.id });
    if (settingsWindow === window) settingsWindow = null;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.warn("settings window renderer crashed", { id: window.id, reason: details.reason });
  });
  window.webContents.on("unresponsive", () => {
    log.warn("settings window renderer unresponsive", { id: window.id });
  });

  return window;
}

export function findSizzleWindow(): BrowserWindow | null {
  if (sizzleWindow !== null && !sizzleWindow.isDestroyed()) return sizzleWindow;
  return null;
}

export function createSizzleWindow(
  extraHash?: string,
  options: { sourceWindowId?: number | undefined } = {}
): BrowserWindow {
  if (sizzleWindow !== null && !sizzleWindow.isDestroyed()) {
    return sizzleWindow;
  }
  const position = centeredWindowBoundsOnDisplay(
    SIZZLE_WINDOW_WIDTH,
    SIZZLE_WINDOW_HEIGHT,
    sourceDisplayForWindow(options.sourceWindowId)
  );
  const window = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: SIZZLE_WINDOW_WIDTH,
    height: SIZZLE_WINDOW_HEIGHT,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: "PwrSnap Sizzle Reels",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: getStartupBackgroundColor(),
    webPreferences: themedWebPreferences()
  });
  sizzleWindow = window;

  loadRenderer(window, rendererTarget("sizzle", extraHash));
  showWindowWhenReady(window, { label: "sizzle" });

  window.on("closed", () => {
    if (sizzleWindow === window) sizzleWindow = null;
  });
  return window;
}

function appDocumentTitle(kind: AppDocumentKind): string {
  return kind === "changelog" ? "PwrSnap Changelog" : "PwrSnap Third-party Licenses";
}

export function showAppDocumentWindow(
  kind: AppDocumentKind,
  options: { sourceWindowId?: number | undefined } = {}
): BrowserWindow {
  const existing = appDocumentWindows.get(kind);
  if (existing !== undefined && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    positionAppDocumentWindowForSource(existing, options.sourceWindowId);
    if (!existing.isVisible()) existing.show();
    existing.focus();
    return existing;
  }

  const position = centeredWindowBoundsOnDisplay(
    APP_DOCUMENT_WINDOW_WIDTH,
    APP_DOCUMENT_WINDOW_HEIGHT,
    sourceDisplayForWindow(options.sourceWindowId)
  );
  const window = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: APP_DOCUMENT_WINDOW_WIDTH,
    height: APP_DOCUMENT_WINDOW_HEIGHT,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: appDocumentTitle(kind),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: getStartupBackgroundColor(),
    webPreferences: themedWebPreferences()
  });
  appDocumentWindows.set(kind, window);

  loadRenderer(window, rendererTarget("document", `kind=${kind}`));

  showWindowWhenReady(window, { label: `document/${kind}` });

  window.on("close", () => log.info("document window close event", { id: window.id, kind }));
  window.on("closed", () => {
    log.info("document window closed", { id: window.id, kind });
    if (appDocumentWindows.get(kind) === window) appDocumentWindows.delete(kind);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.warn("document window renderer crashed", { id: window.id, kind, reason: details.reason });
  });
  window.webContents.on("unresponsive", () => {
    log.warn("document window renderer unresponsive", { id: window.id, kind });
  });

  return window;
}

export function createTrayWindow(): BrowserWindow {
  // Phase 1.7 refinement: drop transparent:true, switch vibrancy from
  // 'under-window' to 'popover' (the macOS-native NSPopover material
  // that Raycast / Linear use). Native popover material renders
  // correctly across multi-monitor setups and avoids the Intel-iGPU
  // black-background regression that plagued transparent+vibrancy
  // combos. backgroundColor stays fully transparent so the popover
  // material shows through.
  //
  // 2026-05-04: `type: 'panel'` — Electron PR #34388 wires NSPanel +
  // NSWindowStyleMaskNonactivatingPanel under this option. This is
  // the macOS primitive every menubar capture tool (CleanShot X,
  // Shottr, SnagIt) uses to keep its tray popover from activating
  // the owning app on show. Without this, every show()/focus() on
  // the tray window made PwrSnap the frontmost app, and when the
  // user clicked an item and the tray hid, Cocoa cascaded focus to
  // the next-key window of our app — the Library — popping it
  // unexpectedly into view. The non-activating panel never makes
  // the app frontmost, so there's no cascade target. PR #40307
  // (Electron 28+) additionally suppressed the
  // `activateIgnoringOtherApps` call on `focus()` for panel
  // windows, so even calls inside our render path can't accidentally
  // re-activate the app.
  const window = new BrowserWindow({
    type: "panel",
    // Width must match TRAY_WIDTH in tray.ts. The renderer's
    // ResizeObserver only updates HEIGHT — width stays at whatever
    // the BrowserWindow was constructed with, so a stale value here
    // silently clips the right column of the mode grid.
    width: 440,
    // Start a touch shorter than the worst-case content height; the
    // renderer's ResizeObserver will setContentSize the moment its
    // first layout finishes (see wireTrayResizeChannel in tray.ts).
    height: 440,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: themedWebPreferences()
  });
  // ⚠️  IMPORTANT — load-bearing for the renderer's resize-to-fit IPC
  // (see wireTrayResizeChannel in tray.ts). When a BrowserWindow is
  // constructed with explicit width/height, Electron records those
  // values as the IMPLICIT MINIMUM SIZE. Subsequent setContentSize
  // calls on macOS NSPanels (`type: 'panel'`) silently clamp at that
  // minimum — the call returns without error, but the content area
  // never grows or shrinks past the constructor frame. Symptom: the
  // popover is stuck at 440×440, with rows clipped off the bottom
  // even though the renderer is reporting the correct height over
  // IPC. The fix is to immediately lift the min size to 0×0 so the
  // resize handler is free to set whatever the renderer measured.
  // Same trick is used in apps/desktop/e2e/fixtures/electron-app.ts
  // for the same reason (test fixture wants to shrink the window
  // below its initial frame).
  window.setMinimumSize(0, 0);
  // Hide from the macOS Window menu. The tray popover is conceptually
  // a popover, not a window — letting it appear as another "PwrSnap"
  // entry in the menu would confuse the user.
  window.excludedFromShownWindowsMenu = true;

  window.setWindowButtonVisibility?.(false);
  window.setMenuBarVisibility(false);
  loadRenderer(window, rendererTarget("tray"));

  // Disable pinch-to-zoom on the trackpad — the popover's a fixed-
  // layout UI, no legitimate reason to scale it on a gesture.
  // setVisualZoomLevelLimits is per-webContents and does NOT
  // propagate through the session, so it's safe to apply here
  // without affecting the library window.
  //
  // We deliberately do NOT call `setZoomFactor` to reset zoom.
  // Electron stores zoomFactor per-origin in the session's
  // HostZoomMap, and library + tray load from the same origin
  // (the dev server URL or `file://` in prod), so any setZoomFactor
  // call here would propagate to the library and reset its zoom
  // along with ours. The resize handler in tray.ts compensates by
  // multiplying renderer-measured CSS pixels by the current
  // zoomFactor before calling setContentSize, so the popover sizes
  // correctly at any zoom level the session happens to be at.
  window.webContents.setVisualZoomLevelLimits(1, 1);

  // Note: blur-dismiss is wired in tray.ts (with the 120ms debounce +
  // DevTools / cursor-bounds guards). createTrayWindow stays a pure
  // factory.
  return window;
}

export function positionTrayWindow(window: BrowserWindow, trayBounds: Rectangle): void {
  const winBounds = window.getBounds();
  // getDisplayMatching is more accurate than getDisplayNearestPoint for
  // tray icons on right-side displays whose origin x is large.
  const display = screen.getDisplayMatching(trayBounds);
  const margin = 4;
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + margin);
  // Clamp inside the work area so the popover never spills off-screen on
  // narrow displays or with the tray icon near the right edge.
  const wa = display.workArea;
  const clampedX = Math.min(Math.max(x, wa.x + margin), wa.x + wa.width - winBounds.width - margin);
  const clampedY = Math.min(Math.max(y, wa.y + margin), wa.y + wa.height - winBounds.height - margin);
  window.setPosition(clampedX, clampedY, false);
}

export function createFloatOverWindow(): BrowserWindow {
  // Sized to fit the standard variant of the toast until the renderer's
  // ResizeObserver posts the exact content height.
  const width = 392;
  const height = 700;

  // `type: 'panel'` — same rationale as the tray. The float-over is
  // a transient toast; we don't want any of its show()/focus()/
  // moveTop() calls to activate PwrSnap and trigger a focus cascade
  // back to the Library window. The non-activating panel guarantees
  // the app stays in the background regardless of what we call on
  // this window.
  const window = new BrowserWindow({
    type: "panel",
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    // Use the native window shadow so the visible shadow can extend
    // outside the BrowserWindow without enlarging the transparent
    // hit-test region around the toast.
    hasShadow: true,
    webPreferences: themedWebPreferences()
  });
  // ⚠️  Same gotcha as createTrayWindow — see that function's comment
  // for the full story. Lifting the implicit minimum size to 0×0
  // is what allows the renderer's `float-over:resize` IPC (handled
  // in float-over.ts/wireFloatOverResizeChannel) to actually move
  // the content area; without this, setContentSize is silently
  // clamped to the constructor's `width`/`height` floor.
  window.setMinimumSize(0, 0);
  // Hide from the macOS Window menu. The float-over is a transient
  // toast (and now stays parked off-screen between captures via
  // float-over.ts/parkOffScreen — `isVisible()` is `true` forever
  // after first show), so without this it would appear as a permanent
  // "PwrSnap Toast" entry in the Window menu.
  window.excludedFromShownWindowsMenu = true;

  // Floating level (NSWindowLevel 3) — the macOS-native level for
  // persistent toasts/HUDs (CleanShot X, Shottr, Loom, macshot all
  // use this). Sits above ordinary app windows but below
  // screen-saver-level overlays like our region selector — important
  // because Phase 3 of the choreography plan pre-shows the float-
  // over UNDER the selector, then hides the selector to reveal it.
  //
  // Earlier this was `pop-up-menu` (level 101). Apple's documentation
  // discourages levels above screen-saver for non-screen-saver
  // windows, and `pop-up-menu` is described as "above legitimate
  // menus" — wrong feel for a persistent panel. The level switch is
  // load-bearing for the pre-show choreography (selector at
  // screen-saver covers floating; the reverse would not work).
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setMenuBarVisibility(false);
  loadRenderer(window, rendererTarget("float-over"));

  // See createTrayWindow for the full story. Block pinch-zoom
  // (per-webContents, doesn't leak to library) but leave session-
  // wide zoomFactor alone — the resize handler in float-over.ts
  // converts CSS pixels → DIP via the current zoomFactor so the
  // toast sizes correctly even if the user zoomed in the library.
  window.webContents.setVisualZoomLevelLimits(1, 1);

  // Note: positioning + show are owned by `float-over.ts` so they
  // re-run on every capture (workArea may have shifted between shows,
  // and `ready-to-show` only fires on the FIRST load — subsequent
  // `loadURL` calls don't re-fire it). The window is constructed
  // hidden; `showFloatOverForCapture` anchors + shows it.

  return window;
}

/**
 * Floating recording-controller HUD (Fast Video Capture, issue #64).
 * Shown only while the recorder is active — created when state
 * transitions out of `idle`, destroyed when it returns to `idle` /
 * `ready` / `failed`. Carries the countdown digits during the
 * pre-roll, then a Stop + Cancel pair plus a live duration timer.
 *
 * Same NSPanel construction model as the float-over toast so it
 * never steals focus from the app the user is recording. Anchored
 * top-center of the active display by `recording-controller.ts`
 * (positioning lives next to the show/hide policy, not here).
 */
export function createRecordingControllerWindow(): BrowserWindow {
  // Tight defaults for the recording phase. The countdown phase
  // grows to ~220×180; the renderer posts a resize over IPC when it
  // flips between phases. setMinimumSize(0,0) below lifts the
  // implicit constructor floor so subsequent setContentSize calls
  // actually land (see CLAUDE.md "BrowserWindow sizing" note).
  const width = 280;
  const height = 60;
  const window = new BrowserWindow({
    type: "panel",
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: true,
    webPreferences: themedWebPreferences()
  });
  // Required after construction — every popover that resizes via
  // setContentSize at runtime needs this to lift the implicit min
  // size (see CLAUDE.md "BrowserWindow sizing" + tray/float-over
  // notes). Without it, switching from recording-phase to countdown-
  // phase gets silently clamped at 280×60.
  window.setMinimumSize(0, 0);
  window.excludedFromShownWindowsMenu = true;
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setMenuBarVisibility(false);
  // Hide this window from EVERY screen capture — our own SCStream,
  // macOS screencapture, QuickTime, third-party recorders. Maps to
  // NSWindow.sharingType = .none under the hood.
  //
  // Why per-window content protection instead of SCContentFilter PID
  // exclusion:
  //   - The PID approach excluded the HUD's renderer process, but
  //     also broke recording any OTHER PwrSnap window (Library,
  //     Settings) because Electron may share renderers across
  //     BrowserWindows — the daemon happily erased the recording
  //     subject from the captured frame because it shared a PID.
  //   - PID exclusion also depends on getOSProcessId() returning a
  //     real PID at filter-build time. If the HUD's renderer was
  //     still booting, we sent an empty exclude list and the HUD
  //     painted into the capture.
  //   - setContentProtection is a per-window flag set BEFORE the
  //     window ever shows, so there's no race and no "wrong window"
  //     collateral damage. Also makes the HUD invisible to OTHER
  //     recorders running alongside us — a property we couldn't get
  //     from our own filter no matter how clever it was.
  window.setContentProtection(true);
  loadRenderer(window, rendererTarget("recording-controller"));
  window.webContents.setVisualZoomLevelLimits(1, 1);
  return window;
}
