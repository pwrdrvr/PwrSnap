// Pre-warmed singleton region-selector window. Cold BrowserWindow
// creation is 150–400ms; the ⌘⇧P → first-paint budget is 120ms. So
// we create the window once at boot (`show: false`), reload it on
// display-config change, and `show()` on shortcut. After capture,
// `hide()` rather than destroy.
//
// One window per display gives a per-display selector that already
// fits the display's coordinate space — no virtual-coord remap needed
// when the user drags. For Phase 1 we ship a single primary-display
// selector to keep complexity down; multi-display support is a
// trivial generalization in Phase 1.5+.
//
// The window itself is frameless, transparent, alwaysOnTop at level
// 'screen-saver', hasShadow:false (window shadow would be captured),
// CSS-only — pure positioning + a 1.5px accent border. NO
// `backdrop-filter` — single biggest cause of jank over Splashtop.

import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import { join } from "node:path";
import { getMainLogger } from "../log";
import { getPreloadPath } from "../window";

const log = getMainLogger("pwrsnap:region-selector");

let selectorWindow: BrowserWindow | null = null;
let pendingResolver: ((result: SelectorResult) => void) | null = null;

export type SelectorResult =
  | { ok: true; rect: { x: number; y: number; w: number; h: number }; displayId: number }
  | { ok: false; reason: "cancelled" | "destroyed" };

const SELECTOR_RESULT_CHANNEL = "region-selector:result";

/**
 * Create the pre-warmed window. Idempotent. Call once at boot.
 */
export function preWarmRegionSelector(): void {
  if (selectorWindow !== null && !selectorWindow.isDestroyed()) return;

  const display = screen.getPrimaryDisplay();
  selectorWindow = createSelectorWindow(display);

  // Wire the result channel once. Renderer posts back on commit / cancel.
  ipcMain.on(SELECTOR_RESULT_CHANNEL, (_event, payload: unknown) => {
    if (pendingResolver === null) return;
    const resolver = pendingResolver;
    pendingResolver = null;
    if (isSelectorPayload(payload) && payload.ok) {
      resolver({ ok: true, rect: payload.rect, displayId: payload.displayId });
    } else {
      resolver({ ok: false, reason: "cancelled" });
    }
    selectorWindow?.hide();
  });

  // Re-create on display config change so the window always matches the
  // active display's bounds.
  screen.on("display-metrics-changed", () => {
    rebuildSelector();
  });
  screen.on("display-added", () => rebuildSelector());
  screen.on("display-removed", () => rebuildSelector());
}

/**
 * Show the selector and resolve when the user commits or cancels.
 * If a prior selector invocation is still pending, the prior promise
 * resolves with `cancelled` and the new request takes over.
 */
export async function pickRegion(): Promise<SelectorResult> {
  if (selectorWindow === null || selectorWindow.isDestroyed()) {
    preWarmRegionSelector();
  }
  const win = selectorWindow;
  if (win === null) {
    return { ok: false, reason: "destroyed" };
  }

  if (pendingResolver !== null) {
    const previous = pendingResolver;
    pendingResolver = null;
    previous({ ok: false, reason: "cancelled" });
  }

  const result = await new Promise<SelectorResult>((resolve) => {
    pendingResolver = resolve;
    win.show();
    win.focus();
  });
  return result;
}

function createSelectorWindow(display: Display): BrowserWindow {
  const { bounds } = display;
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
    hasShadow: false,
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The renderer needs the display id baked in so it can post the
      // right value back to main on commit. Pass via a query string.
      additionalArguments: [`--display-id=${display.id}`]
    }
  });

  // Highest-of-windows ordering — clears menu bar / other overlays.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const target = rendererTarget(display.id);
  if (target.kind === "url") {
    void window.loadURL(target.url);
  } else {
    void window.loadFile(target.path, { hash: target.hash });
  }

  log.info("region selector pre-warmed", { displayId: display.id, bounds });
  return window;
}

function rebuildSelector(): void {
  if (selectorWindow !== null && !selectorWindow.isDestroyed()) {
    selectorWindow.destroy();
  }
  selectorWindow = null;
  preWarmRegionSelector();
}

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash: string };

function rendererTarget(displayId: number): RendererTarget {
  const hash = `stage=region&displayId=${displayId}`;
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    return {
      kind: "url",
      url: `${process.env.ELECTRON_RENDERER_URL}#${hash}`
    };
  }
  return {
    kind: "file",
    path: join(__dirname, "../renderer/index.html"),
    hash
  };
}

function isSelectorPayload(value: unknown): value is {
  ok: true;
  rect: { x: number; y: number; w: number; h: number };
  displayId: number;
} {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true) return false;
  const rect = v.rect as Record<string, unknown> | undefined;
  if (rect === undefined) return false;
  return (
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.w === "number" &&
    typeof rect.h === "number" &&
    typeof v.displayId === "number"
  );
}

export function disposeRegionSelector(): void {
  if (selectorWindow !== null && !selectorWindow.isDestroyed()) {
    selectorWindow.destroy();
  }
  selectorWindow = null;
  ipcMain.removeAllListeners(SELECTOR_RESULT_CHANNEL);
}

export const REGION_SELECTOR_RESULT_CHANNEL = SELECTOR_RESULT_CHANNEL;
