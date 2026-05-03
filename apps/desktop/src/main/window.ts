import { BrowserWindow, screen, type Rectangle } from "electron";
import { join } from "node:path";

const isDevelopment = process.env.NODE_ENV !== "production";

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash?: string };

export function getPreloadPath(): string {
  return join(__dirname, "../preload/index.cjs");
}

function rendererTarget(stage?: "tray" | "float-over"): RendererTarget {
  const hash = stage ? `stage=${stage}` : undefined;
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL + (hash ? `#${hash}` : "");
    return { kind: "url", url };
  }
  return {
    kind: "file",
    path: join(__dirname, "../renderer/index.html"),
    hash
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
    window.show();
    if (isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }
  });

  return window;
}

export function createTrayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 380,
    height: 580,
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
    hasShadow: true,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: baseWebPreferences
  });

  window.setWindowButtonVisibility?.(false);
  window.setMenuBarVisibility(false);
  loadRenderer(window, rendererTarget("tray"));

  window.on("blur", () => {
    if (!window.webContents.isDevToolsFocused()) {
      window.hide();
    }
  });

  return window;
}

export function positionTrayWindow(window: BrowserWindow, trayBounds: Rectangle): void {
  const winBounds = window.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + Math.floor(trayBounds.width / 2),
    y: trayBounds.y
  });
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
