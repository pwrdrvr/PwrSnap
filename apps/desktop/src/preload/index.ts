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
import { EVENT_CHANNELS, IPC_CAPTURE_DRAG_START, IPC_CMD } from "@pwrsnap/shared/ipc";
import type { RenderPreset } from "@pwrsnap/shared/protocol";
import type { PerfMarkPayload } from "@pwrsnap/shared/ipc";

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
// Main → renderer: forwarded keystrokes from globalShortcut while
// the selector is visible. Belt-and-braces for macOS keyboard-focus
// quirks where the renderer's keydown listener doesn't fire until
// the user has clicked the window once.
const REGION_SELECTOR_KEY_CHANNEL = "region-selector:key";
// Main → renderer: per-show selector mode signal. Sent right before
// `win.show()` so the selector renderer can configure UI for
// 'auto' | 'region' | 'window' before the first paint.
const REGION_SELECTOR_MODE_CHANNEL = "region-selector:mode";

// Tray content auto-sizes to fit. The renderer measures itself with a
// ResizeObserver and asks main to setContentSize so the popover never
// has dead space at the bottom or clips a row.
const TRAY_RESIZE_CHANNEL = "tray:resize";
// Float-over toast applies the same trick — the BrowserWindow is
// constructed at a generous fixed height because we don't know the
// content size in advance, but as soon as the renderer mounts it
// measures `.fo` and asks main to shrink the window to fit. Stops
// the empty body region below the toast from rendering as a grayish
// "tail" (its box-shadow bleeding into transparent space) and from
// extending the window's bottom edge into the Dock area.
const FLOAT_OVER_RESIZE_CHANNEL = "float-over:resize";

// Single window entry shipped to the renderer for snap-to-window.
// Keep this in sync with the renderer's RegionSelector type.
export type WindowSnapEntry = {
  windowId: number;
  pid: number;
  bundleId: string | null;
  appName: string | null;
  title: string | null;
  /** True when the candidate belongs to this PwrSnap process. This
   *  is diagnostic only: normal PwrSnap user windows are valid snap
   *  targets, while capture chrome is hidden before enumeration. */
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
    /** Always set when the user committed straight from a window
     *  snap (no drag, no resize). Used by main for source-app
     *  metadata. */
    snappedWindowId?: number;
    /** True when the user opted into full-window capture by holding
     *  ⇧ at commit time. Routes main to `screencapture -l <id>`
     *  instead of `-R <rect>`. */
    fullWindow?: boolean;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_RESULT_CHANNEL, payload);
  },
  /**
   * Subscribe to the snap-to-window window-list snapshot main pushes
   * after the selector is shown. The renderer uses this for local
   * hit-testing on ⇧ hover. Payload includes display.bounds so the
   * renderer can scale rect coords into its CSS pixel space — on
   * macOS scaled-mode displays the two coord systems differ.
   */
  onWindowListSnapshot(
    handler: (payload: {
      windows: WindowSnapEntry[];
      displayBounds: { width: number; height: number };
      cursor?: { x: number; y: number };
    }) => void
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(
        payload as {
          windows: WindowSnapEntry[];
          displayBounds: { width: number; height: number };
          cursor?: { x: number; y: number };
        }
      );
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
   * Float-over renderer → main: tell main to size the toast window's
   * content to the measured DOM bounds (toast height + box-shadow
   * padding). Called from a ResizeObserver in FloatOverHost.tsx on
   * every state transition (idle → loading → loaded → idle), so the
   * window always tracks the visible toast and the Dock-overlap +
   * shadow-tail artifacts both go away.
   */
  requestFloatOverResize(payload: { width: number; height: number }): void {
    ipcRenderer.send(FLOAT_OVER_RESIZE_CHANNEL, payload);
  },
  /**
   * Renderer -> main native file drag. Main validates the capture id,
   * prepares the rendered file, and calls WebContents.startDrag using
   * this sender. Renderer never receives privileged filesystem paths.
   */
  startCaptureDrag(payload: { captureId: string; preset: RenderPreset }): void {
    ipcRenderer.send(IPC_CAPTURE_DRAG_START, payload);
  },
  /**
   * Subscribe to forwarded-key events from main. globalShortcut on
   * the main side reaches here when macOS withholds keystrokes from
   * the selector window's renderer (typical right after show, before
   * the user has clicked). Renderer treats these as if the user
   * pressed the key directly.
   */
  onSelectorKey(handler: (payload: { key: string }) => void): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(payload as { key: string });
    ipcRenderer.on(REGION_SELECTOR_KEY_CHANNEL, wrapped);
    return () => ipcRenderer.off(REGION_SELECTOR_KEY_CHANNEL, wrapped);
  },
  /**
   * Subscribe to the per-show selector mode + snapshot signal. Main
   * fires this right before `win.show()` so the renderer can:
   *   1. Reconfigure between 'auto' (snap + drag), 'region' (drag-
   *      only, no snap candidates), and 'window' (snap-only, no
   *      drag).
   *   2. Mount the frozen-screen snapshot via `<img src=screenUrl>`
   *      as a full-window background. The renderer paints the
   *      snapshot, the user drags against it, and on commit the
   *      capture handler crops THAT snapshot (not the live screen).
   *
   * `screenUrl` is a `pwrsnap-screen://r/<id>` URL; it stays valid
   * until the selector dismisses.
   */
  onSelectorMode(
    handler: (payload: {
      mode: "auto" | "region" | "window";
      screenUrl?: string;
    }) => void
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(
        payload as {
          mode: "auto" | "region" | "window";
          screenUrl?: string;
        }
      );
    ipcRenderer.on(REGION_SELECTOR_MODE_CHANNEL, wrapped);
    return () => ipcRenderer.off(REGION_SELECTOR_MODE_CHANNEL, wrapped);
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
  },
  /**
   * Renderer → main perf signal. Phase 5 of the perf-seeder plan —
   * the seeder reads these marks to compute first-paint cold-load
   * latency. Discriminated-union payload (`PerfMarkPayload`) means
   * new mark kinds can be added without growing the API surface.
   */
  perfMark(payload: PerfMarkPayload): void {
    ipcRenderer.send(EVENT_CHANNELS.perfMark, payload);
  }
};

export type PwrsnapApi = typeof pwrsnapApi;

contextBridge.exposeInMainWorld("pwrsnapApi", pwrsnapApi);
