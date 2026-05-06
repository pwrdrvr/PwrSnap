import { BrowserWindow, screen, type Rectangle } from "electron";
import { join } from "node:path";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:window");

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash?: string };

export function getPreloadPath(): string {
  return join(__dirname, "../preload/index.cjs");
}

function rendererTarget(stage?: "tray" | "float-over" | "edit", extraHash?: string): RendererTarget {
  const baseHash = stage ? `stage=${stage}` : undefined;
  const hash = baseHash !== undefined && extraHash !== undefined
    ? `${baseHash}&${extraHash}`
    : baseHash ?? extraHash;
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : "");
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

/**
 * Find the main library window (the only PwrSnap window whose URL
 * has no `stage=` fragment). Tray, float-over, region selector, edit
 * windows all carry distinct stage hashes; the library is the
 * residue. Returns null if no library is currently created/alive.
 *
 * Used by the capture flow to hide the library during the selector
 * lifecycle — Cocoa's next-key-window cascade would otherwise raise
 * (and un-minimize) the library when the tray popover closes.
 */
export function findMainLibraryWindow(): BrowserWindow | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const url = win.webContents.getURL();
    if (url.length > 0 && !/[#&?]stage=/.test(url)) {
      return win;
    }
  }
  return null;
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: "PwrSnap",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: "#0a0908",
    webPreferences: baseWebPreferences
  });

  loadRenderer(window, rendererTarget());

  window.once("ready-to-show", () => {
    log.info("main window ready-to-show", { id: window.id });
    window.show();
  });

  // Lifecycle diagnostics — these helped track down the
  // "library closes after ~10s" bug, which turned out to be
  // a duplicate-instance issue, not a true window-close.
  window.on("close", () => log.info("main window close event", { id: window.id }));
  window.on("closed", () => log.info("main window closed", { id: window.id }));
  window.webContents.on("render-process-gone", (_event, details) => {
    log.warn("main window renderer crashed", { id: window.id, reason: details.reason });
  });
  window.webContents.on("unresponsive", () => {
    log.warn("main window renderer unresponsive", { id: window.id });
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
    webPreferences: baseWebPreferences
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
  // Sized to fit the standard variant of the toast. Height is generous so
  // the annotation textarea + AI strip + footer never clip; the window is
  // transparent so the unused area below the toast is invisible.
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
    hasShadow: false,
    webPreferences: baseWebPreferences
  });
  // ⚠️  Same gotcha as createTrayWindow — see that function's comment
  // for the full story. Lifting the implicit minimum size to 0×0
  // is what allows the renderer's `float-over:resize` IPC (handled
  // in float-over.ts/wireFloatOverResizeChannel) to actually move
  // the content area; without this, setContentSize is silently
  // clamped to the constructor's `width`/`height` floor.
  window.setMinimumSize(0, 0);

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
 * Phase 2 Edit window — opens a dedicated, full-screen-ish window
 * sized for annotating a specific capture. Carries the captureId in
 * the URL hash so the renderer can fetch + render it; subsequent
 * edits route through `overlays:upsert`.
 *
 * Each call creates a fresh window: edit windows are per-capture,
 * not singletons. Closing one hides nothing else; the user can have
 * multiple captures open in parallel editor windows if they want.
 */
export function createEditWindow(captureId: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "PwrSnap Editor",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 18 },
    backgroundColor: "#0a0908",
    webPreferences: baseWebPreferences
  });

  loadRenderer(window, rendererTarget("edit", `captureId=${encodeURIComponent(captureId)}`));

  window.once("ready-to-show", () => {
    log.info("edit window ready-to-show", { id: window.id, captureId });
    window.show();
    window.focus();
  });

  return window;
}
