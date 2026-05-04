// Preload — narrow renderer-facing surface. The renderer never imports
// from the main process directly; everything goes through the typed
// command-bus dispatch.
//
// Why a single `dispatch` method instead of per-domain methods? The
// preload is the contextBridge boundary; every method we expose has a
// runtime cost (function pointer marshaled into the renderer's V8
// isolate) and an attack-surface cost. One typed dispatcher fits every
// command without growing the surface, and matches the pattern Phase 7
// uses for HTTP RPC + the future MCP transport.
//
// Renderer-side typing comes from `@pwrsnap/shared`: import
// `CommandName, Req, Res, Result, PwrSnapError` and the dispatch is
// fully typed with autocomplete. See apps/desktop/src/renderer/src/lib/
// command-bus.ts (Phase 1.4) for the renderer-side helper.

import { contextBridge, ipcRenderer } from "electron";
// Import from the `/ipc` subpath, NOT the package barrel — the barrel
// re-exports the Zod overlay schemas, whose `z.object(...)` calls have
// construction side-effects Vite can't tree-shake. Pulling the barrel
// would force a `require("zod")` at preload load time, and Electron's
// sandbox: true (which we always run with) doesn't allow arbitrary
// requires from a preload, so the file would fail silently and
// pwrsnapApi never reach the renderer.
import { IPC_CMD } from "@pwrsnap/shared/ipc";

// Internal (non-command-bus) channel for the region selector to commit
// its result back to main. Kept narrow: the preload exposes one
// purpose-built method (`submitRegion`), not a generic `send`.
const REGION_SELECTOR_RESULT_CHANNEL = "region-selector:result";
// Main pushes the on-screen window list to the selector renderer right
// after pickRegion shows it, so ⇧-hover snap-to-window hit-tests run
// locally with no IPC round-trip per mouse move.
const REGION_SELECTOR_WINDOW_LIST_CHANNEL = "region-selector:window-list";
// Diagnostic — renderer ships its view of the world (innerWidth,
// devicePixelRatio, etc.) back to main so we can see in the regular
// terminal log whether the renderer's CSS coord space matches the
// display.bounds we're translating against.
const REGION_SELECTOR_DIAGNOSTICS_CHANNEL = "region-selector:diagnostics";

// Tray content auto-sizes to fit. The renderer measures itself with a
// ResizeObserver and asks main to setContentSize so the popover never
// has dead space at the bottom or clips a row.
const TRAY_RESIZE_CHANNEL = "tray:resize";

// Single window entry shipped to the renderer for snap-to-window.
// Keep this in sync with the renderer's RegionSelector type.
export type WindowSnapEntry = {
  windowId: number;
  pid: number;
  bundleId: string | null;
  appName: string | null;
  title: string | null;
  /** True for windows owned by PwrSnap itself (library, float-over,
   *  selector windows). The renderer keeps these in the hit-test
   *  list as occluders but never snaps to them. */
  ownedByUs: boolean;
  /** Z-order index in the original CGWindow scan; 0 = frontmost.
   *  The hit-test walks ascending z to find the topmost window
   *  whose RAW bounds contain the cursor. */
  zIndex: number;
  /** Visible-region bounding box, window-local. This is the rect we
   *  paint as the snap highlight — reflects the part of the window
   *  the user can actually see. */
  rect: { x: number; y: number; w: number; h: number };
  /** Raw window bounds, window-local. The hit-test uses these
   *  (along with z-order) so it stays consistent with what the OS
   *  considers "topmost at this point." */
  rawRect: { x: number; y: number; w: number; h: number };
};

const pwrsnapApi = {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  /**
   * Dispatch a command-bus command. Returns the typed Result envelope
   * — success carries the response, failure carries a structured
   * PwrSnapError. Renderers never throw across the boundary; they
   * inspect `result.ok`.
   */
  dispatch(name: string, req: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CMD, name, req);
  },
  /**
   * Subscribe to a server → client event. Returns an unsubscribe
   * function. Used by `useLibrary.ts` etc. with `useSyncExternalStore`.
   */
  on(channel: string, handler: (payload: unknown) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.off(channel, wrapped);
    };
  },
  /**
   * Region-selector renderer → main signal. Called on commit (with rect
   * + displayId) or on cancel (with `ok: false`). Main re-validates
   * everything; this channel is just a transport.
   */
  submitRegion(payload: {
    ok: boolean;
    rect?: { x: number; y: number; w: number; h: number };
    displayId?: number;
    /** When committing via snap-to-window (⇧ hover), the CGWindowID
     *  of the snapped window so main can verify + tag the capture. */
    snappedWindowId?: number;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_RESULT_CHANNEL, payload);
  },
  /**
   * Subscribe to the snap-to-window window-list snapshot main pushes
   * after the selector is shown. The renderer uses this for local
   * hit-testing on ⇧ hover.
   */
  onWindowListSnapshot(
    handler: (payload: { windows: WindowSnapEntry[] }) => void
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(payload as { windows: WindowSnapEntry[] });
    ipcRenderer.on(REGION_SELECTOR_WINDOW_LIST_CHANNEL, wrapped);
    return () => ipcRenderer.off(REGION_SELECTOR_WINDOW_LIST_CHANNEL, wrapped);
  },
  /**
   * Tray renderer → main: tell main to size the tray window's content
   * to the measured DOM bounds. Called from a ResizeObserver in
   * TrayMenu.tsx so the popover stays tight as content changes.
   */
  requestTrayResize(payload: { width: number; height: number }): void {
    ipcRenderer.send(TRAY_RESIZE_CHANNEL, payload);
  },
  /**
   * Diagnostic — region selector renderer → main. Ships the
   * renderer's window dimensions + devicePixelRatio so main can log
   * them next to the selector window's getContentBounds. Lets us
   * confirm whether the renderer's CSS coord space matches what
   * main thinks the content bounds are.
   */
  reportSelectorDiagnostics(payload: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    devicePixelRatio: number;
    screenWidth: number;
    screenHeight: number;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_DIAGNOSTICS_CHANNEL, payload);
  }
};

export type PwrsnapApi = typeof pwrsnapApi;

contextBridge.exposeInMainWorld("pwrsnapApi", pwrsnapApi);
