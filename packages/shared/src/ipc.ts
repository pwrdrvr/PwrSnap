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
  popoverRemeasure: "events:popover:remeasure"
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
