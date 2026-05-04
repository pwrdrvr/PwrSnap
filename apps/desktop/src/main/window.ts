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
  const window = new BrowserWindow({
    width: 380,
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

  window.setWindowButtonVisibility?.(false);
  window.setMenuBarVisibility(false);
  loadRenderer(window, rendererTarget("tray"));

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

  const window = new BrowserWindow({
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

  // Bump to a window level that sits above ordinary app windows
  // even when our app is not frontmost. After a capture commits,
  // we activate the previous app via NSRunningApplication —
  // putting our app in the background. The float-over needs to
  // appear over the user's previous app's windows so they can see
  // the toast. "floating" (the default for alwaysOnTop:true) is
  // below "screen-saver"; we use "pop-up-menu" which is high
  // enough to clear most ordinary windows but low enough to not
  // fight with system UI like Mission Control.
  window.setAlwaysOnTop(true, "pop-up-menu");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setMenuBarVisibility(false);
  loadRenderer(window, rendererTarget("float-over"));

  window.once("ready-to-show", () => {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const margin = 24;
    const x = wa.x + wa.width - width - margin;
    const y = wa.y + wa.height - height - margin;
    window.setPosition(x, y, false);
    window.showInactive();
  });

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
