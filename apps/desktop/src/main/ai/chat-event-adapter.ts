// Adapter: maps the kit `ChatThreadController`'s neutral `ChatControllerEvent`
// union onto PwrSnap's six existing per-surface IPC channels, building
// PwrSnap's `LibraryChatThreadView` / `ChatMessage` / status payloads from the
// kit's neutral `NormalizedThreadView` / `NormalizedMessage` / event payloads.
// The RENDERER IS UNCHANGED — it still receives exactly the same payloads on
// the same `events:libraryChat:*` / `events:sizzleChat:*` channels.
//
// Event → channel map (per surface):
//   thread_updated      → threadUpdated      { thread: LibraryChatThreadView }
//   stream_delta        → streamDelta        LibraryChatStreamDeltaEvent
//   tool_call           → toolCall           LibraryChatToolCallEvent
//   message_committed   → messageCommitted   { threadId, message: ChatMessage }
//   turn_interrupted    → turnInterrupted    LibraryChatTurnInterruptedEvent
//   approval_requested  → approvalRequested  ChatApprovalRequest

import type { ChatBroadcast as KitChatBroadcast, ChatControllerEvent } from "@pwrdrvr/agent-client";
import type {
  NormalizedMessage,
  NormalizedThreadStatus,
  NormalizedThreadView
} from "@pwrdrvr/agent-core";
import type {
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

/** The six `events:*Chat:*` channels a surface broadcasts on. Each surface
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
    reasoning: config?.reasoning ?? null
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
export function toChatMessage(message: NormalizedMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: [{ kind: "text", text: message.text }],
    status: "complete",
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
  send: ChatBroadcast
): KitChatBroadcast {
  return (event: ChatControllerEvent): void => {
    switch (event.type) {
      case "thread_updated":
        send(channels.threadUpdated, { thread: toLibraryThreadView(event.thread) });
        return;
      case "stream_delta":
        send(channels.streamDelta, {
          threadId: event.threadId,
          turnId: event.turnId,
          messageId: event.messageId,
          delta: event.delta
        });
        return;
      case "tool_call":
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
        send(channels.messageCommitted, {
          threadId: event.threadId,
          message: toChatMessage(event.message)
        });
        return;
      case "turn_interrupted":
        // The only path that interrupts a turn in PwrSnap is the user verb
        // (`codex:*Chat:interrupt`), so the reason is always user-initiated.
        send(channels.turnInterrupted, {
          threadId: event.threadId,
          turnId: event.turnId,
          reason: "user_interrupted"
        });
        return;
      case "approval_requested":
        send(channels.approvalRequested, {
          threadId: event.threadId,
          turnId: event.turnId,
          approvalId: event.approval.id,
          summary: event.approval.summary ?? `Approve: ${event.approval.method}`,
          ...(typeof (event.approval.params as { detail?: unknown } | null)?.detail === "string"
            ? { detail: (event.approval.params as { detail: string }).detail }
            : {})
        });
        return;
      default:
        return;
    }
  };
}
