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
import { EVENT_CHANNELS } from "@pwrsnap/shared";

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
 *   • default `status` to "complete" — the kit no longer threads a
 *     failed/interrupted status onto the persisted assistant message (live
 *     turn state is conveyed by the `thread_updated` status + the
 *     `turn_interrupted` event, which the renderer already reacts to),
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
  return (event: ChatControllerEvent): void => {
    switch (event.type) {
      case "thread_updated": {
        const base = toLibraryThreadView(event.thread, options.fixedThreadConfig);
        const thread = options.decorateThread?.(base) ?? base;
        options.observeThread?.(thread);
        if (options.shouldSend?.(thread.threadId) === false) return;
        send(channels.threadUpdated, { thread });
        return;
      }
      case "stream_delta":
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
      case "message_committed":
        if (options.shouldSend?.(event.threadId) === false) return;
        send(channels.messageCommitted, {
          threadId: event.threadId,
          message: toChatMessage(event.message, options.messageStatusFor?.(event) ?? "complete")
        });
        return;
      case "turn_interrupted":
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
        const request: ChatApprovalRequest = {
          threadId: event.threadId,
          turnId: event.turnId,
          approvalId: event.approval.id,
          summary: event.approval.summary ?? `Approve: ${event.approval.method}`,
          ...(typeof (event.approval.params as { detail?: unknown } | null)?.detail === "string"
            ? { detail: (event.approval.params as { detail: string }).detail }
            : {})
        };
        if (options.onApprovalRequested?.(request) === false) return;
        if (options.shouldSend?.(event.threadId) === false) return;
        send(channels.approvalRequested, request);
        return;
      }
      default:
        return;
    }
  };
}
