// IPC channel name constants. Bare `<domain>:<verb>` — no `pwrsnap:`
// prefix (matches PwrAgnt convention).
//
// One central `cmd` channel carries every command-bus dispatch via
// ipcRenderer.invoke('cmd', name, req); transports pick the channel name
// out of the registry. Event channels (server → client broadcasts) use
// the typed map below.

import type { CaptureRecord } from "./protocol";

export const IPC_CMD = "cmd" as const;

/** Renderer -> main native file drag bridge. This cannot flow through
 * ipcRenderer.invoke('cmd') alone because Electron's startDrag needs
 * the sending WebContents from the drag-start event. */
export const IPC_CAPTURE_DRAG_START = "capture:drag-start" as const;

export const EVENT_CHANNELS = {
  capturesChanged: "events:captures:changed",
  overlaysChanged: "events:overlays:changed",
  uploadProgress: "events:upload:progress",
  aiRunUpdated: "events:ai-run:updated",
  renderProgress: "events:render:progress",
  recordingState: "events:recording:state",
  settingsChanged: "events:settings:changed",
  /**
   * Main → every BrowserWindow: latest auto-updater status. Drives the
   * library window's update banner. The payload shape is
   * `AppUpdateStatus` (see protocol.ts) — discriminated union over
   * `status: "idle" | "checking" | "no-update" | "available" |
   * "downloading" | "downloaded" | "error" | "skipped"`. Fired by
   * apps/desktop/src/main/auto-updater.ts on every electron-updater
   * event transition.
   */
  appUpdateStatus: "events:app-update:status",
  /**
   * Main → renderer navigation signal for the Settings window. Sent by
   * `settings:open` when the window is already focused and the caller
   * supplied a `page`. The renderer's `useActivePage` hook subscribes
   * and flips its hash through the already-validated `setActivePage`.
   *
   * This replaces the prior `webContents.executeJavaScript` approach
   * so the bus contract stays transport-agnostic — HTTP/MCP callers
   * can't `executeJavaScript`, and string-interpolating untrusted
   * `req.page` into a JS template would be an injection footgun.
   *
   * Payload type: `SettingsNavigateEvent` (below).
   */
  settingsNavigate: "events:settings:navigate",
  /**
   * Drives the float-over renderer's state machine. Lets main own the
   * lifecycle (pre-show under selector, populate-after-commit, sync
   * cancel-without-flicker) without `loadURL` reloads — the renderer
   * stays mounted across captures so stale exit-animation timers
   * can't fire from a previous mount.
   *
   * Payload type: `FloatOverEvent` (see protocol.ts).
   */
  floatOverState: "events:float-over:state",
  /**
   * Main → float-over renderer: a native/global copy shortcut fired
   * while the toast was visible. The renderer uses this to play the
   * same Low / Med / High copied flash that a pointer click would.
   *
   * Payload: `{ preset: RenderPreset }`.
   */
  floatOverCopyPulse: "events:float-over:copy-pulse",
  /**
   * Tells a popover renderer (tray or float-over) to re-measure its
   * content and re-post the resize IPC. Sent by main when the
   * webContents `zoom-changed` fires — Electron's ResizeObserver
   * doesn't reliably fire on zoom changes, so we drive the re-measure
   * explicitly. Renderer should bypass any "no-op" cache and post
   * unconditionally.
   *
   * Payload: empty object `{}` (the channel itself is the signal).
   */
  popoverRemeasure: "events:popover:remeasure",
  /**
   * Tells the Library renderer to navigate to a specific capture and
   * open it in Focus mode. Used by `library:openInLibrary` so the
   * float-over toast's Edit button can hand off into the inline
   * editor without spawning a separate window.
   *
   * Payload: `{ captureId: string }`.
   */
  libraryOpenCapture: "events:library:open-capture",
  /**
   * Renderer → main perf signals for the dev seeder's measurement
   * pipeline (Phase 5 of the perf plan). The renderer dispatches
   * `library:firstPaint` from a `useLayoutEffect` after the grid
   * commits its first row; the seeder times window-create →
   * firstPaint to characterize cold-load. Also carries the result
   * payload of a scroll probe (see `perfScrollProbeRequest`).
   *
   * Payload type: `PerfMarkPayload`. Discriminated union — add new
   * marks as new union members; `assertNever` on the read side
   * catches missed cases.
   */
  perfMark: "events:perf:mark",
  /**
   * Main → renderer scroll-probe trigger. The seeder sends a
   * `ScrollProbeRequest`; the Library renderer programmatically
   * scrolls its virtualizer at fixed velocity for the requested
   * duration, RAF-counts dropped frames, and posts the result back
   * via `perfMark` as a `perf:scrollProbe:result` payload.
   *
   * One-way send — gated by an awaiter on the main side that
   * resolves on the matching `perfMark` arrival.
   */
  perfScrollProbeRequest: "events:perf:scrollProbe:request"
} as const;

export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS];

/**
 * Float-over state-machine event. Main → renderer broadcast.
 *   - `show-idle`   — pre-show with no capture data; renderer paints an
 *     empty placeholder. Used when the selector opens — the float-over
 *     window is established at the floating window level UNDER the
 *     selector (which is at screen-saver level), so the user never
 *     sees it before the selector hides.
 *   - `show-loaded` — capture committed; populate the toast. Main
 *     includes the CaptureRecord when it already has it so the toast
 *     can paint without a renderer→main metadata round trip.
 *   - `cancel`      — selector cancelled; hide the toast SYNCHRONOUSLY
 *     with no exit animation. Used so the user never sees the
 *     pre-shown placeholder when they Esc out of the selector.
 *   - `dismiss`     — user explicitly dismissed (X button, Esc on the
 *     toast itself, auto-dismiss countdown). Plays the exit animation.
 */
export type FloatOverEvent =
  | { kind: "show-idle" }
  | { kind: "show-loaded"; captureId: string; record?: CaptureRecord | undefined }
  | { kind: "cancel" }
  | { kind: "dismiss" };

/**
 * Main → renderer scroll-probe trigger payload. The renderer drives
 * the actual scroll + frame-time measurement; main only times the
 * round-trip and writes the JSONL row.
 */
export type ScrollProbeRequest = {
  /** Total probe window in ms (e.g. 5000). */
  durationMs: number;
  /** Pixels to advance the scroll position each RAF tick. */
  pxPerFrame: number;
};

/**
 * `events:settings:changed` broadcast payload. Sent to every live
 * BrowserWindow after a successful `settings:write`, `settings:
 * replaceSecret`, or `settings:clearSecret`. Renderers replace their
 * local snapshot on receipt — both the persisted Settings shape and
 * the masked secret-status map are carried so a single subscribe
 * suffices for the whole Settings surface.
 *
 * Plaintext secret values never appear in this payload (or anywhere
 * else that crosses the IPC boundary) — only `{ configured, lastSetAt }`
 * per name.
 */
export type SettingsChangedEvent = {
  settings: import("./protocol").Settings;
  secrets: Record<
    import("./protocol").DesktopSettingsSecretName,
    import("./protocol").SecretStatus
  >;
};

/**
 * `events:settings:navigate` broadcast payload. Sent by main when
 * `settings:open` is called against an already-focused Settings
 * window and the caller supplied a `page`. The renderer flips its
 * hash through `setActivePage`, which re-validates the page id
 * against the same allowlist `useActivePage` uses for `hashchange`.
 */
export type SettingsNavigateEvent = {
  page: import("./protocol").SettingsPage;
};

/**
 * Renderer → main perf-mark payloads. New marks land here as new
 * union members; readers narrow with `kind` and call `assertNever`
 * on the never-arm so missed cases fail to typecheck.
 *
 * `timeOriginMs` carries the renderer's `performance.timeOrigin` so
 * main can reconcile clock skew between processes when computing
 * cold-load latency.
 */
export type PerfMarkPayload =
  | {
      kind: "library:firstPaint";
      rowsRendered: number;
      timeOriginMs: number;
    }
  | {
      kind: "perf:scrollProbe:result";
      durationMs: number;
      frames: number;
      droppedFrames: number;
      droppedPct: number;
      p95FrameMs: number;
    }
  | {
      kind: "perf:scrollProbe:error";
      reason: "no_scroll_container" | "already_running";
    };
