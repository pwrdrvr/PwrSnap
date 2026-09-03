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

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import { shortcutPlatformFromString } from "@pwrsnap/shared/shortcut-semantics";

// **Re-enable pinch gestures.** Electron disables visual zoom by
// default, and "disabled" here means more than "no zooming
// happens" — Chromium silently drops the synthetic ctrl+wheel
// events that the OS dispatches for macOS trackpad pinch. From
// the renderer's point of view, pinch becomes a no-op event
// stream. setVisualZoomLevelLimits(1, N) with N > 1 RE-ENABLES
// the dispatch (see Electron's `webContents.setVisualZoomLevelLimits`
// docs, which explicitly say "Visual zoom is disabled by default
// in Electron. To re-enable it, call w.webContents.setVisualZoomLevelLimits(1, 3)").
//
// Subtle: setVisualZoomLevelLimits(1, 1) does NOT re-enable —
// min===max means no zoom range, and Chromium still treats it as
// "no pinch interest." Need a non-degenerate range, even if we
// preventDefault every event before the browser visually zooms.
//
// Calling from the preload (via webFrame, instead of from main
// via webContents) takes effect on every renderer reload (Cmd+R)
// without a main-process restart, and applies before any input
// event reaches the page's JavaScript — so the very first pinch
// after window load is delivered to us. Applies to every PwrSnap
// renderer (library, settings, tray, float-over, capture); the
// non-editor surfaces have no pinch handler at all, so the worst
// case is that a stray pinch over a fixed-layout window briefly
// visual-zooms before snapping back — acceptable.
try {
  webFrame.setVisualZoomLevelLimits(1, 3);
} catch {
  // setVisualZoomLevelLimits can throw if called before the frame
  // is fully initialized in some Electron versions. Swallow — the
  // main-side fallback covers this.
}
// Import from the `/ipc` subpath, NOT the package barrel — the barrel
// re-exports the Zod overlay schemas, whose `z.object(...)` calls have
// construction side-effects Vite can't tree-shake. Pulling the barrel
// would force a `require("zod")` at preload load time, and Electron's
// sandbox: true (which we always run with) doesn't allow arbitrary
// requires from a preload, so the file would fail silently and
// pwrsnapApi never reach the renderer.
import {
  EVENT_CHANNELS,
  IPC_CAPTURE_DRAG_START,
  IPC_CART_ZIP_DRAG_START,
  IPC_CMD,
  IPC_VIDEO_DRAG_START
} from "@pwrsnap/shared/ipc";
import type {
  RenderPreset,
  VideoPreset
} from "@pwrsnap/shared/protocol";
import type { PerfMarkPayload } from "@pwrsnap/shared/ipc";
import { parseAppearanceArg } from "@pwrsnap/shared/appearance-arg";
import { resolveDroppedFilePath } from "./dropped-file-path";

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
// Renderer → main: the selector acks that the frozen snapshot has painted
// through either the mapped RGBA canvas path or the PNG <img> fallback.
// Main waits for this before
// showing the (still-hidden) selector window, so it never appears as an
// empty transparent overlay flashing the live screen behind it.
const REGION_SELECTOR_PAINTED_CHANNEL = "region-selector:painted";
const REGION_SELECTOR_SNAPSHOT_READ_CHANNEL = "region-selector:snapshot-read";
const REGION_SELECTOR_PRESENTATION_REQUEST_CHANNEL = "region-selector:presentation-request";
const REGION_SELECTOR_PRESENTED_CHANNEL = "region-selector:presented";

// One opaque epoch per preload execution. The renderer cannot choose or reuse
// it; main binds it to the current top-level WebFrameMain before admitting a
// Settings recorder lease. This distinguishes delayed IPC from a document
// that has already navigated away even when Chromium reuses a renderer PID.
const rendererDocumentId = crypto.randomUUID().replaceAll("-", "");

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
// Failed recording cards are content-sized as well. This channel is accepted
// only from the live recording-controller webContents in main.
const RECORDING_CONTROLLER_RESIZE_CHANNEL = "recording-controller:resize";
// Windows custom title-bar menu bar. The renderer fetches the top-level menu
// labels (`app-menu:model`) and, on click / Alt-mnemonic, asks main to pop the
// real native submenu at the button's location (`app-menu:popup`). See
// apps/desktop/src/main/app-menu-bridge.ts.
const APP_MENU_MODEL_CHANNEL = "app-menu:model";
const APP_MENU_POPUP_CHANNEL = "app-menu:popup";

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

export type SelectorMappedSnapshotDescriptor = {
  id: string;
  transport: "windows-shared-memory";
  version: 1;
  width: number;
  height: number;
  stride: number;
  pixelFormat: 1;
  byteLength: number;
};

type SelectorMappedSnapshotReadResult =
  | {
      ok: true;
      header: Omit<SelectorMappedSnapshotDescriptor, "id" | "transport">;
      data: Uint8Array;
    }
  | { ok: false; code: string };

function validatedSelectorSnapshotRead(value: unknown): SelectorMappedSnapshotReadResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, code: "malformed" };
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true) {
    return {
      ok: false,
      code: typeof result.code === "string" ? result.code.slice(0, 64) : "read_failed"
    };
  }
  if (typeof result.header !== "object" || result.header === null) {
    return { ok: false, code: "malformed" };
  }
  const header = result.header as Record<string, unknown>;
  const width = header.width;
  const height = header.height;
  const stride = header.stride;
  const byteLength = header.byteLength;
  if (
    header.version !== 1 ||
    header.pixelFormat !== 1 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(stride) ||
    !Number.isSafeInteger(byteLength) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (width as number) > 32_768 ||
    (height as number) > 32_768 ||
    (stride as number) !== (width as number) * 4 ||
    BigInt(stride as number) * BigInt(height as number) !== BigInt(byteLength as number) ||
    (byteLength as number) > 512 * 1024 * 1024 ||
    !(result.data instanceof Uint8Array) ||
    result.data.byteLength !== byteLength
  ) {
    return { ok: false, code: "malformed" };
  }
  return {
    ok: true,
    header: {
      version: 1,
      width: width as number,
      height: height as number,
      stride: stride as number,
      pixelFormat: 1,
      byteLength: byteLength as number
    },
    data: result.data
  };
}

const pwrsnapApi = {
  platform: shortcutPlatformFromString(process.platform),
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node
  },
  /**
   * Resolve one user-selected/dropped browser File to its backing path.
   * Electron 32 removed File.path; webUtils is the supported replacement.
   * Expose this one operation, never the Electron or webUtils objects.
   */
  getPathForFile(file: File): string {
    return resolveDroppedFilePath(file, webUtils.getPathForFile);
  },
  /**
   * Dispatch a command-bus command. Returns the typed Result envelope
   * — success carries the response, failure carries a structured
   * PwrSnapError. Renderers never throw across the boundary; they
   * inspect `result.ok`.
   */
  dispatch(name: string, req: unknown): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CMD, name, req, rendererDocumentId);
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
    /** The terminal action the user chose at commit. Present ONLY for
     *  `"record"` — a snap commit ships the pre-chooser payload
     *  unchanged and main reads a missing `action` as `"snap"`. Main
     *  re-derives this against the persisted policy and never trusts a
     *  `"record"` it did not offer. */
    action?: "snap" | "record";
    /** Recording-only: whether the recording bakes in the mouse cursor,
     *  from the selector's `C` toggle. Omitted for image captures. */
    captureCursor?: boolean;
    /** Multi-window pick. Each entry is one picked window's EXTENT —
     *  a rectangle on the frozen screen, in the same global logical-px
     *  space as `rect`. `rect` is ALWAYS the union bounding box of
     *  these, so every existing consumer (rect validation, source-app
     *  resolution, cursor placement, recording) keeps working without
     *  knowing about extents at all. Absent for a single-target pick. */
    extents?: { x: number; y: number; w: number; h: number }[];
    /** What shape to keep inside the union box:
     *    - `"windows"`   — only the pixels inside `extents`; everything
     *                      else in the box goes transparent.
     *    - `"rectangle"` — the whole box, opaque (what the picker has
     *                      always produced).
     *  Only meaningful alongside `extents`. */
    outputMode?: "windows" | "rectangle";
  }): void {
    ipcRenderer.send(REGION_SELECTOR_RESULT_CHANNEL, payload);
  },
  /**
   * Region-selector renderer → main: the frozen-snapshot image for
   * `screenUrl` finished loading/decoding. Main gates `win.show()` on
   * this so the selector never appears before its background is
   * painted. Carries `screenUrl` so a stale ack from a superseded
   * capture can't satisfy the current wait.
   */
  notifySelectorSnapshotPainted(payload: {
    screenUrl: string;
    transport: "img" | "windows-shared-memory";
    decodeMs: number;
    mainToRendererBytes: number;
    canvasUploadBytes: number;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_PAINTED_CHANNEL, payload);
  },
  /** Read one copy of the currently active mapped selector snapshot. Main
   * authenticates this exact webContents/top-level frame and never exposes the
   * Win32 mapping name or handle across the context bridge. */
  async readSelectorSnapshot(id: string): Promise<SelectorMappedSnapshotReadResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, code: "invalid_id" };
    const value: unknown = await ipcRenderer.invoke(REGION_SELECTOR_SNAPSHOT_READ_CHANNEL, {
      id
    });
    return validatedSelectorSnapshotRead(value);
  },
  /** Diagnostic-only post-show acknowledgement. Main authenticates the
   * sender webContents plus invocation/generation before accepting it. */
  notifySelectorPresented(payload: {
    invocationId: string;
    generation: number;
    screenUrl: string;
  }): void {
    ipcRenderer.send(REGION_SELECTOR_PRESENTED_CHANNEL, payload);
  },
  /** Main emits this only after show/focus/moveTop. The renderer crosses
   * two animation-frame barriers before replying through the method above. */
  onSelectorPresentationRequest(
    handler: (payload: { invocationId: string; generation: number; screenUrl: string }) => void
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(payload as { invocationId: string; generation: number; screenUrl: string });
    ipcRenderer.on(REGION_SELECTOR_PRESENTATION_REQUEST_CHANNEL, wrapped);
    return () => ipcRenderer.off(REGION_SELECTOR_PRESENTATION_REQUEST_CHANNEL, wrapped);
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
  /** Failed recording HUD renderer → main content measurement. Main converts
   * CSS pixels through the inherited page zoom before resizing the window. */
  requestRecordingControllerResize(payload: { height: number }): void {
    ipcRenderer.send(RECORDING_CONTROLLER_RESIZE_CHANNEL, payload);
  },
  /**
   * Windows custom menu bar → main: fetch the current top-level application
   * menu entries (label + index) to paint as buttons in the title bar.
   */
  getAppMenuModel(): Promise<Array<{ index: number; label: string }>> {
    return ipcRenderer.invoke(APP_MENU_MODEL_CHANNEL) as Promise<
      Array<{ index: number; label: string }>
    >;
  },
  /**
   * Windows custom menu bar → main: pop the real native submenu for a top-level
   * entry at the button's window-relative bottom-left (DIP). Fire-and-forget.
   */
  popupAppMenu(payload: { index: number; x: number; y: number }): void {
    ipcRenderer.send(APP_MENU_POPUP_CHANNEL, payload);
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
   * Renderer -> main native file drag for a VIDEO export. Sibling of
   * `startCaptureDrag`. Payload identifies (captureId, format,
   * preset); main encodes (cache-hit if already done), extracts a
   * poster frame, and calls WebContents.startDrag with the encoded
   * file + poster icon. The dragged file is a human-friendly alias
   * (e.g. `Slack__med.mp4`) — never the raw render-cache path.
   */
  startVideoDrag(payload: {
    captureId: string;
    format: "gif" | "mp4";
    preset: VideoPreset;
    /** Optional explicit trim range; omitted = record's defaultRange. */
    range?: { start: number; end: number };
  }): void {
    ipcRenderer.send(IPC_VIDEO_DRAG_START, payload);
  },
  /**
   * Renderer -> main native file drag for the Project Asset Cart's Zip
   * export. Sibling of `startCaptureDrag`. Payload identifies the cart's
   * captureIds + preset (+ a suggested filename); main renders the images,
   * zips them to a temp file, and calls WebContents.startDrag with the
   * `.zip`. No save dialog — this is the drag-out path.
   */
  startCartZipDrag(payload: {
    captureIds: string[];
    preset: RenderPreset;
    suggestedName?: string;
  }): void {
    ipcRenderer.send(IPC_CART_ZIP_DRAG_START, payload);
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
   *   2. Mount the frozen-screen snapshot via mapped RGBA canvas when a
   *      descriptor is present, or `<img src=screenUrl>` otherwise. The renderer paints the
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
      snapshot?: SelectorMappedSnapshotDescriptor;
      /** Visual intent: `"video"` triggers the "Recording video"
       *  badge + alternate hint copy so the user knows commit
       *  starts a recording instead of taking a snap. Default
       *  `"snap"` keeps existing visuals unchanged. */
      intent?: "snap" | "video";
      /** Recording seed for the cursor toggle. `undefined` = ON. */
      cursor?: boolean;
      invocationId?: string;
      generation?: number;
      /** Snap-vs-Record policy for this show, from
       *  `settings.recording.quickCaptureAction`. `undefined` = "ask". */
      quickCaptureAction?: "ask" | "snap" | "record";
    }) => void
  ): () => void {
    const wrapped = (_event: unknown, payload: unknown) =>
      handler(
        payload as {
          mode: "auto" | "region" | "window";
          screenUrl?: string;
          snapshot?: SelectorMappedSnapshotDescriptor;
          intent?: "snap" | "video";
          cursor?: boolean;
          invocationId?: string;
          generation?: number;
          quickCaptureAction?: "ask" | "snap" | "record";
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

// Appearance bridge — synchronous theme delivery for the inline
// pre-React bootstrap in index.html.
//
// Main builds a `--pwrsnap-appearance=<json>` token into the window's
// `webPreferences.additionalArguments` after a sync read of the
// persisted theme; we parse it here and surface the result on
// `window.__pwrsnapAppearance`. The bootstrap reads from there before
// touching localStorage, so a cold launch in light theme paints light
// from the very first frame — no flash-of-dark-then-light gap.
//
// On the renderer side, `useAppearanceSync` continues to be the source
// of truth for in-session state and writes — this bridge is purely for
// the pre-mount first paint.
//
// The parser lives in `@pwrsnap/shared/appearance-arg` so it can be
// unit-tested without spinning up Electron, and so main + preload
// share the prefix + validation rules from one source of truth.
const appearanceArg = parseAppearanceArg(process.argv);
if (appearanceArg !== null) {
  contextBridge.exposeInMainWorld("__pwrsnapAppearance", appearanceArg);
}

const logFilePathToken = process.argv.find((arg) => arg.startsWith("--pwrsnap-log-file-path="));
if (logFilePathToken !== undefined) {
  const encodedPath = logFilePathToken.slice("--pwrsnap-log-file-path=".length);
  try {
    const value: unknown = JSON.parse(encodedPath);
    if (typeof value === "string" && value.length > 0) {
      contextBridge.exposeInMainWorld("__pwrsnapLogFilePath", value);
    }
  } catch {
    // Malformed bootstrap argument: logs:read remains the normal source.
  }
}
