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

/** Renderer -> main native file drag bridge for VIDEO exports
 *  (GIF / MP4). Same wedge as `IPC_CAPTURE_DRAG_START`: the bus path
 *  can't carry `event.sender.startDrag`, so we use a plain
 *  `ipcRenderer.send` with a payload identifying the
 *  `(captureId, format, preset)` to drag. The main listener
 *  dispatches `video:prepareDrag` on the bus then calls startDrag. */
export const IPC_VIDEO_DRAG_START = "video:drag-start" as const;

export const EVENT_CHANNELS = {
  capturesChanged: "events:captures:changed",
  overlaysChanged: "events:overlays:changed",
  uploadProgress: "events:upload:progress",
  aiRunUpdated: "events:ai-run:updated",
  renderProgress: "events:render:progress",
  /**
   * Main → every BrowserWindow: recording-service lifecycle update.
   * Payload type: `RecordingState`. Discriminated union over
   * `phase: "idle" | "preflight" | "countdown" | "recording" |
   *  "stopping" | "processing" | "ready" | "failed"`. Drives the
   * tray's Stop-Recording row, the selector's countdown overlay,
   * and the float-over's video-loaded transition. Renderers that
   * mount mid-flight call `recording:state` once for the snapshot,
   * then subscribe for subsequent transitions.
   */
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
   * Main → renderer storage accounting progress. Full scans are
   * singleton and async; this event lets detailed storage UI update
   * from cached/partial snapshots while the command that requested the
   * scan awaits final totals.
   *
   * Payload type: `StorageSnapshotUpdate`.
   */
  storageSnapshotUpdated: "events:storage:snapshot-updated",
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
  perfScrollProbeRequest: "events:perf:scrollProbe:request",
  sizzleRenderProgress: "events:sizzle:render:progress",
  /**
   * Main → every BrowserWindow: the list of sizzle projects changed
   * (create / update / delete / toggleScene / render-completion). The
   * Library sidebar's "Sizzle Reels" section + the DetailRail Project
   * tab subscribe to this so they refresh without polling. The payload
   * is the new project list so subscribers don't have to round-trip
   * `sizzle:list`. Type: `{ projects: SizzleProject[] }`.
   */
  sizzleProjectsChanged: "events:sizzle:projects:changed",
  /**
   * Main → every BrowserWindow: the single global Project Asset Cart
   * changed (toggle / reorder / remove / rename / clear / commit). The
   * Library's cell checkboxes + the DetailRail Cart tab subscribe so
   * they reflect the cart without polling. Payload is the full cart so
   * subscribers don't round-trip `cart:get`.
   * Type: `{ cart: DraftCart }`.
   */
  cartChanged: "events:cart:changed",
  /**
   * Main → every BrowserWindow: PwrSnap just changed the OS clipboard's
   * image contents (clipboard:copy, clipboard:copyLayerFragment, or
   * any future write). Fires AFTER the write completes so subscribers
   * that re-read the clipboard (e.g. to refresh a "paste available"
   * UI state) see the new contents.
   *
   * Also fires from the matching native menu refresh path so the
   * "File > New > Paste from Clipboard" menu item enables
   * synchronously after an in-app copy without waiting for the user
   * to dismiss-and-reopen the menu.
   *
   * Does NOT fire for clipboard writes from OTHER apps — Electron
   * doesn't surface a portable system-clipboard-changed signal, and
   * polling NSPasteboard's changeCount has its own pitfalls.
   * External writes still surface to the menu through the existing
   * `menu-will-show` listener (which re-reads the clipboard on each
   * open) and through the BrowserWindow focus handler.
   *
   * Payload: empty object `{}` — the channel itself is the signal;
   * subscribers re-query whatever they need.
   */
  clipboardChanged: "events:clipboard:changed",
  /**
   * Main → every BrowserWindow: a Library chat thread's metadata
   * changed (created, renamed, archived, anchor moved, status flipped
   * to streaming/awaiting-approval/idle, or last-message preview
   * updated). The thread-list rail subscribes so it refreshes without
   * polling. Payload: `{ thread: LibraryChatThreadView }`.
   */
  libraryChatThreadUpdated: "events:libraryChat:thread:updated",
  /**
   * Main → renderer: a streaming assistant-message delta for an
   * in-flight turn. High-frequency — the renderer MUST coalesce these
   * via requestAnimationFrame rather than setState-per-delta (plan
   * §F10 T2). Payload: `LibraryChatStreamDeltaEvent`.
   */
  libraryChatStreamDelta: "events:libraryChat:stream:delta",
  /**
   * Main → renderer: the agent invoked a tool mid-turn. Drives the
   * live activity chips ("Drew an arrow", "Searched the library") +
   * the working indicator so the turn doesn't look frozen while the
   * agent runs tools before producing text. Payload:
   * `LibraryChatToolCallEvent`.
   */
  libraryChatToolCall: "events:libraryChat:tool:call",
  /**
   * Main → renderer: a chat message was committed to the thread (user
   * message persisted before turn/start, or an assistant message
   * finalized at turn end). The renderer appends / replaces by
   * `message.id`. Payload: `LibraryChatMessageCommittedEvent`.
   */
  libraryChatMessageCommitted: "events:libraryChat:message:committed",
  /**
   * Main → renderer: a turn was interrupted (Codex disconnected, user
   * interrupted, or app is quitting). The renderer marks the in-flight
   * assistant message `interrupted` and surfaces a Retry affordance
   * (plan §F11 G15). Payload: `LibraryChatTurnInterruptedEvent`.
   */
  libraryChatTurnInterrupted: "events:libraryChat:turn:interrupted",
  /**
   * Main → renderer: Codex requested an approval mid-turn. The renderer
   * shows a modal/card; the user's decision routes back via
   * `codex:libraryChat:approval`. Payload: `ChatApprovalRequest`.
   */
  libraryChatApprovalRequested: "events:libraryChat:approval:requested",
  /**
   * Main → renderer: the user just added a sensitive-data pattern in
   * Settings. The open chat panel shows a one-shot toast nudging
   * "try 'redact all <name>'" (plan §F11 G3). Payload: `{ name: string }`.
   */
  libraryChatPatternLearned: "events:libraryChat:pattern:learned"
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

// ---------------------------------------------------------------------
// Typed event payloads.
//
// Strictly opt-in — channels listed here get a typed payload on both
// the send side (main) and the subscribe side (renderer). Channels
// NOT listed continue to use the legacy `unknown` payload + per-call
// structural shape-check pattern.
//
// Add a row when a new channel gains a stable contract that callers
// rely on. Don't add rows speculatively — only when the type would
// catch a real divergence (e.g. multiple producers, multiple
// subscribers, schema growth over time).
// ---------------------------------------------------------------------

import type { DraftCart, SizzleProject, SizzleRenderProgressEvent } from "./protocol";
import type {
  ChatApprovalRequest,
  ChatMessage,
  LibraryChatThreadView
} from "./chat-schemas";

/** `events:libraryChat:stream:delta` payload. One streamed token-chunk
 *  for an in-flight assistant message. The renderer coalesces these by
 *  `messageId` via rAF (plan §F10 T2). */
export type LibraryChatStreamDeltaEvent = {
  threadId: string;
  turnId: string;
  messageId: string;
  delta: string;
};

/** `events:libraryChat:tool:call` payload. One tool invocation in an
 *  in-flight turn — `summary` is a friendly present-tense label for the
 *  activity chip; `ok` is false when the dispatch failed. */
export type LibraryChatToolCallEvent = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  ok: boolean;
  summary: string;
};

/** `events:libraryChat:message:committed` payload. A full message
 *  landed (user message persisted, or assistant message finalized). */
export type LibraryChatMessageCommittedEvent = {
  threadId: string;
  message: ChatMessage;
};

/** `events:libraryChat:turn:interrupted` payload. */
export type LibraryChatTurnInterruptedEvent = {
  threadId: string;
  turnId: string;
  reason: "codex_disconnected" | "user_interrupted" | "app_quitting";
};

export type EventPayloads = {
  [EVENT_CHANNELS.sizzleProjectsChanged]: { projects: SizzleProject[] };
  [EVENT_CHANNELS.sizzleRenderProgress]: SizzleRenderProgressEvent;
  [EVENT_CHANNELS.cartChanged]: { cart: DraftCart };
  [EVENT_CHANNELS.libraryChatThreadUpdated]: { thread: LibraryChatThreadView };
  [EVENT_CHANNELS.libraryChatStreamDelta]: LibraryChatStreamDeltaEvent;
  [EVENT_CHANNELS.libraryChatToolCall]: LibraryChatToolCallEvent;
  [EVENT_CHANNELS.libraryChatMessageCommitted]: LibraryChatMessageCommittedEvent;
  [EVENT_CHANNELS.libraryChatTurnInterrupted]: LibraryChatTurnInterruptedEvent;
  [EVENT_CHANNELS.libraryChatApprovalRequested]: ChatApprovalRequest;
  [EVENT_CHANNELS.libraryChatPatternLearned]: { name: string };
};

/** Channel constants that carry a typed payload entry in
 *  `EventPayloads`. Useful as the parameter type for a typed
 *  broadcaster helper. */
export type TypedEventChannel = keyof EventPayloads;
