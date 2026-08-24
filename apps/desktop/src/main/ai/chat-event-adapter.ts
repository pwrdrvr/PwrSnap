// Adapter: maps the kit `ChatThreadController`'s neutral `ChatControllerEvent`
// union onto PwrSnap's per-surface IPC channels, building
// PwrSnap's `LibraryChatThreadView` / `ChatMessage` / status payloads from the
// kit's neutral `NormalizedThreadView` / `NormalizedMessage` / event payloads.
//
// Event → channel map (per surface):
//   thread_updated      → threadUpdated      { thread: LibraryChatThreadView }
//   stream_delta        → streamDelta        LibraryChatStreamDeltaEvent
//   tool_call           → toolCall           LibraryChatToolCallEvent
//   message_committed   → messageCommitted   { threadId, message: ChatMessage }
//   turn_interrupted    → turnInterrupted    LibraryChatTurnInterruptedEvent
//   approval_requested  → approvalRequested  ChatApprovalRequest
// Broker terminal events use approvalResolved / approvalSuperseded directly.

import type { ChatBroadcast as KitChatBroadcast, ChatControllerEvent } from "@pwrdrvr/agent-client";
import type {
  NormalizedMessage,
  NormalizedThreadStatus,
  NormalizedThreadView
} from "@pwrdrvr/agent-core";
import type {
  ChatApprovalRequest,
  ChatMessage,
  EventPayloads,
  LibraryChatThreadStatus,
  LibraryChatThreadView,
  TypedEventChannel
} from "@pwrsnap/shared";
import { EVENT_CHANNELS, parseChatApprovalRequest } from "@pwrsnap/shared";

/** Typed broadcast — accepts any typed event channel. Default impl sends to
 *  every live BrowserWindow. */
export type ChatBroadcast = <C extends TypedEventChannel>(
  channel: C,
  payload: EventPayloads[C]
) => void;

/** The `events:*Chat:*` channels a surface broadcasts on. Each surface
 *  (Library, Sizzle) passes its own set so one event adapter serves either —
 *  the channel constants differ, the payload types are identical. */
export type ChatChannelSet = {
  threadUpdated:
    | typeof EVENT_CHANNELS.libraryChatThreadUpdated
    | typeof EVENT_CHANNELS.sizzleChatThreadUpdated;
  streamDelta:
    | typeof EVENT_CHANNELS.libraryChatStreamDelta
    | typeof EVENT_CHANNELS.sizzleChatStreamDelta;
  toolCall:
    | typeof EVENT_CHANNELS.libraryChatToolCall
    | typeof EVENT_CHANNELS.sizzleChatToolCall;
  messageCommitted:
    | typeof EVENT_CHANNELS.libraryChatMessageCommitted
    | typeof EVENT_CHANNELS.sizzleChatMessageCommitted;
  turnInterrupted:
    | typeof EVENT_CHANNELS.libraryChatTurnInterrupted
    | typeof EVENT_CHANNELS.sizzleChatTurnInterrupted;
  approvalRequested:
    | typeof EVENT_CHANNELS.libraryChatApprovalRequested
    | typeof EVENT_CHANNELS.sizzleChatApprovalRequested;
  approvalResolved:
    | typeof EVENT_CHANNELS.libraryChatApprovalResolved
    | typeof EVENT_CHANNELS.sizzleChatApprovalResolved;
  approvalSuperseded:
    | typeof EVENT_CHANNELS.libraryChatApprovalSuperseded
    | typeof EVENT_CHANNELS.sizzleChatApprovalSuperseded;
};

type MessageCommittedEvent = Extract<ChatControllerEvent, { type: "message_committed" }>;

export type ChatEventAdapterOptions = {
  /** Every controller is built for one immutable backend tuple. Put that
   *  identity on every producer view instead of making renderers guess/merge. */
  fixedThreadConfig?: { provider: string | null; model: string | null; reasoning: string | null };
  /** Main-owned transient state (approval replay) decorates controller views. */
  decorateThread?: (view: LibraryChatThreadView) => LibraryChatThreadView;
  /** Observe truthful views even when owner routing suppresses renderer IPC. */
  observeThread?: (view: LibraryChatThreadView) => void;
  /** Fail-closed owner/surface router. */
  shouldSend?: (threadId: string) => boolean;
  /** Register the exact sanitized request with its originating controller.
   *  False means duplicate/terminal and suppresses another requested event. */
  onApprovalRequested?: (request: ChatApprovalRequest) => boolean;
  /** Fail closed on a malformed/unsafe request without letting that raw
   *  payload enter the broker or any renderer. The controller-bound callback
   *  can deny its original backend resolver by exact raw identity. */
  onInvalidApprovalRequested?: (identity: {
    threadId: string;
    turnId: string;
    approvalId: string;
  }) => void;
  /** A valid request belongs to an unattended/non-human thread. Deny it on
   *  the originating controller before broker registration; local-agent wait
   *  has no approval UI or identity with which to answer it. */
  onUnattendedApprovalRequested?: (identity: {
    threadId: string;
    turnId: string;
    approvalId: string;
  }) => void;
  /** Runs only after the controller has committed an assistant message to its
   *  journal. Approval cleanup may make the thread idle, so it must never run
   *  from the earlier raw backend terminal event. */
  onAssistantCommitted?: (threadId: string) => void;
  /** #471 can inject its backend terminal tracker here; the adapter remains
   *  producer-truthful and never requires a renderer-only status merge. */
  messageStatusFor?: (event: MessageCommittedEvent) => ChatMessage["status"];
};

/** Kit status → PwrSnap status (identical discriminated shapes). */
function toStatus(status: NormalizedThreadStatus): LibraryChatThreadStatus {
  switch (status.kind) {
    case "streaming":
      return { kind: "streaming", turnId: status.turnId };
    case "awaiting_approval":
      return { kind: "awaiting_approval", approvalId: status.approvalId };
    case "idle":
    default:
      return { kind: "idle" };
  }
}

/** Kit `NormalizedThreadView` → PwrSnap `LibraryChatThreadView`
 *  (anchorId → anchorCaptureId; status mapped through `toStatus`). */
export function toLibraryThreadView(
  view: NormalizedThreadView,
  /** The thread's persisted backend config (from PwrSnap's ChatThreadStore —
   *  the kit's neutral view doesn't carry it). Omitted → null (legacy threads /
   *  before the chip UI wires it through). */
  config?: { provider?: string | null; model?: string | null; reasoning?: string | null }
): LibraryChatThreadView {
  return {
    threadId: view.threadId,
    name: view.name,
    createdAt: view.createdAt,
    modifiedAt: view.modifiedAt,
    anchorCaptureId: view.anchorId,
    archived: view.archived,
    pinned: view.pinned,
    lastMessagePreview: view.lastMessagePreview,
    status: toStatus(view.status),
    provider: config?.provider ?? null,
    model: config?.model ?? null,
    reasoning: config?.reasoning ?? null,
    pendingApproval: null
  };
}

/** Kit `NormalizedMessage` → PwrSnap `ChatMessage`.
 *
 *  The kit's neutral message carries `{ id, role, text, parts?, createdAt? }`
 *  but no per-message lifecycle `status` and no PwrSnap content-block union.
 *  PwrSnap's renderer narrows on `content[]` blocks + `status`. We:
 *   • wrap the message's flat `text` in a single `{ kind: "text" }` block,
 *   • default `status` to "complete" — the shared terminal-lifecycle adapter
 *     widens this mapping when authoritative failed/interrupted status is
 *     available,
 *   • stamp `createdAt` from the kit's epoch-ms field (or now() as a floor).
 *
 *  Tool-call / tool-result content blocks were only ever produced by
 *  PwrSnap's own committed messages; the kit commits plain user/assistant
 *  text messages, so the text block is the faithful mapping.
 */
export function toChatMessage(
  message: NormalizedMessage,
  status: ChatMessage["status"] = "complete"
): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: [{ kind: "text", text: message.text }],
    status,
    createdAt:
      message.createdAt !== undefined
        ? new Date(message.createdAt).toISOString()
        : new Date().toISOString()
  };
}

/**
 * Build the kit controller's `broadcast` callback for one surface: it receives
 * the neutral `ChatControllerEvent` and re-broadcasts the PwrSnap payload on
 * the surface's channel set.
 */
export function makeChatBroadcast(
  channels: ChatChannelSet,
  send: ChatBroadcast,
  options: ChatEventAdapterOptions = {}
): KitChatBroadcast {
  // `message_committed` in agent-client 0.8.2 omits turnId. Retain only the
  // current association so panels can correlate a zero-delta assistant
  // commit with the Stop/terminal event that produced it. This is an
  // interrupt-specific compatibility seam; lifecycle status is annotated by
  // the shared terminal-status work.
  const activeTurnByThread = new Map<string, string>();
  return (event: ChatControllerEvent): void => {
    switch (event.type) {
      case "thread_updated": {
        if (event.thread.status.kind === "streaming") {
          activeTurnByThread.set(event.thread.threadId, event.thread.status.turnId);
        } else if (event.thread.status.kind === "idle") {
          activeTurnByThread.delete(event.thread.threadId);
        }
        const base = toLibraryThreadView(event.thread, options.fixedThreadConfig);
        const thread = options.decorateThread?.(base) ?? base;
        options.observeThread?.(thread);
        if (options.shouldSend?.(thread.threadId) === false) return;
        send(channels.threadUpdated, { thread });
        return;
      }
      case "stream_delta":
        activeTurnByThread.set(event.threadId, event.turnId);
        if (options.shouldSend?.(event.threadId) === false) return;
        send(channels.streamDelta, {
          threadId: event.threadId,
          turnId: event.turnId,
          messageId: event.messageId,
          delta: event.delta
        });
        return;
      case "tool_call":
        if (options.shouldSend?.(event.threadId) === false) return;
        send(channels.toolCall, {
          threadId: event.threadId,
          turnId: event.turnId,
          callId: event.toolCall.id,
          tool: event.toolCall.name,
          ok: event.toolCall.status !== "failed",
          summary: event.toolCall.label
        });
        return;
      case "message_committed": {
        const turnId =
          event.message.role === "assistant"
            ? activeTurnByThread.get(event.threadId)
            : undefined;
        try {
          if (options.shouldSend?.(event.threadId) !== false) {
            send(channels.messageCommitted, {
              threadId: event.threadId,
              ...(turnId !== undefined ? { turnId } : {}),
              message: toChatMessage(
                event.message,
                options.messageStatusFor?.(event) ?? "complete"
              )
            });
          }
        } finally {
          if (event.message.role === "assistant") {
            options.onAssistantCommitted?.(event.threadId);
          }
        }
        return;
      }
      case "turn_interrupted":
        if (activeTurnByThread.get(event.threadId) === event.turnId) {
          activeTurnByThread.delete(event.threadId);
        }
        if (options.shouldSend?.(event.threadId) === false) return;
        // The only path that interrupts a turn in PwrSnap is the user verb
        // (`codex:*Chat:interrupt`), so the reason is always user-initiated.
        send(channels.turnInterrupted, {
          threadId: event.threadId,
          turnId: event.turnId,
          reason: "user_interrupted"
        });
        return;
      case "approval_requested": {
        const request = parseChatApprovalRequest({
          threadId: event.threadId,
          turnId: event.turnId,
          approvalId: event.approval.id,
          summary: event.approval.summary ?? `Approve: ${event.approval.method}`,
          ...(typeof (event.approval.params as { detail?: unknown } | null)?.detail === "string"
            ? { detail: (event.approval.params as { detail: string }).detail }
            : {})
        });
        if (request === null) {
          options.onInvalidApprovalRequested?.({
            threadId: event.threadId,
            turnId: event.turnId,
            approvalId: event.approval.id
          });
          return;
        }
        if (options.shouldSend?.(request.threadId) === false) {
          options.onUnattendedApprovalRequested?.({
            threadId: request.threadId,
            turnId: request.turnId,
            approvalId: request.approvalId
          });
          return;
        }
        if (options.onApprovalRequested?.(request) === false) return;
        send(channels.approvalRequested, request);
        return;
      }
      default:
        return;
    }
  };
}
