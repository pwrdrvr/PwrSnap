// IPC channel name constants. Bare `<domain>:<verb>` — no `pwrsnap:`
// prefix (matches PwrAgnt convention).
//
// One central `cmd` channel carries every command-bus dispatch via
// ipcRenderer.invoke('cmd', name, req); transports pick the channel name
// out of the registry. Event channels (server → client broadcasts) use
// the typed map below.

export const IPC_CMD = "cmd" as const;

export const EVENT_CHANNELS = {
  capturesChanged: "events:captures:changed",
  overlaysChanged: "events:overlays:changed",
  uploadProgress: "events:upload:progress",
  aiRunUpdated: "events:ai-run:updated",
  renderProgress: "events:render:progress",
  recordingState: "events:recording:state",
  settingsChanged: "events:settings:changed",
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
 *   - `show-loaded` — capture committed; populate the toast with the
 *     captureId. Renderer fetches the record and starts the
 *     auto-dismiss countdown.
 *   - `cancel`      — selector cancelled; hide the toast SYNCHRONOUSLY
 *     with no exit animation. Used so the user never sees the
 *     pre-shown placeholder when they Esc out of the selector.
 *   - `dismiss`     — user explicitly dismissed (X button, Esc on the
 *     toast itself, auto-dismiss countdown). Plays the exit animation.
 */
export type FloatOverEvent =
  | { kind: "show-idle" }
  | { kind: "show-loaded"; captureId: string }
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
