// Behaviour-level coverage for the kit→PwrSnap event adapter — the
// PwrSnap-owned seam that keeps the renderer unchanged after the chat
// controller migrated to @pwrdrvr/agent-client. Asserts each neutral
// ChatControllerEvent lands on the right per-surface channel with the
// renderer's existing payload shape, and that the type renames
// (anchorId → anchorCaptureId, NormalizedMessage → ChatMessage,
// neutral status → discriminated LibraryChatThreadStatus) are correct.

import { describe, expect, it, vi } from "vitest";
import {
  CHAT_APPROVAL_DETAIL_MAX_BYTES,
  CHAT_APPROVAL_DETAIL_MAX_LINES,
  CHAT_APPROVAL_SUMMARY_MAX_BYTES,
  EVENT_CHANNELS,
  type ChatApprovalRequest
} from "@pwrsnap/shared";
import type { ChatControllerEvent } from "@pwrdrvr/agent-client";
import {
  makeChatBroadcast,
  toChatMessage,
  toLibraryThreadView,
  type ChatChannelSet
} from "../chat-event-adapter";

const LIBRARY_CHANNELS: ChatChannelSet = {
  threadUpdated: EVENT_CHANNELS.libraryChatThreadUpdated,
  streamDelta: EVENT_CHANNELS.libraryChatStreamDelta,
  toolCall: EVENT_CHANNELS.libraryChatToolCall,
  messageCommitted: EVENT_CHANNELS.libraryChatMessageCommitted,
  turnInterrupted: EVENT_CHANNELS.libraryChatTurnInterrupted,
  approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested,
  approvalResolved: EVENT_CHANNELS.libraryChatApprovalResolved,
  approvalSuperseded: EVENT_CHANNELS.libraryChatApprovalSuperseded
};

describe("toLibraryThreadView", () => {
  it("renames anchorId → anchorCaptureId and maps the discriminated status", () => {
    expect(
      toLibraryThreadView({
        threadId: "t1",
        name: "Chat",
        createdAt: "a",
        modifiedAt: "b",
        anchorId: "cap_9",
        archived: false,
        pinned: true,
        lastMessagePreview: "hi",
        status: { kind: "streaming", turnId: "turn_1" }
      })
    ).toEqual({
      threadId: "t1",
      name: "Chat",
      createdAt: "a",
      modifiedAt: "b",
      anchorCaptureId: "cap_9",
      archived: false,
      pinned: true,
      lastMessagePreview: "hi",
      status: { kind: "streaming", turnId: "turn_1" },
      provider: null,
      model: null,
      reasoning: null,
      pendingApproval: null
    });
  });

  it("preserves a null anchor and awaiting_approval status", () => {
    const view = toLibraryThreadView({
      threadId: "t2",
      name: "Chat",
      createdAt: "a",
      modifiedAt: "b",
      anchorId: null,
      archived: true,
      pinned: false,
      lastMessagePreview: "",
      status: { kind: "awaiting_approval", approvalId: "ap_1" }
    });
    expect(view.anchorCaptureId).toBeNull();
    expect(view.status).toEqual({ kind: "awaiting_approval", approvalId: "ap_1" });
  });
});

describe("toChatMessage", () => {
  it("wraps the kit's flat text in a text content block and defaults status", () => {
    const msg = toChatMessage({
      id: "m1",
      role: "assistant",
      text: "hello world",
      createdAt: 1_700_000_000_000
    });
    expect(msg).toEqual({
      id: "m1",
      role: "assistant",
      content: [{ kind: "text", text: "hello world" }],
      status: "complete",
      createdAt: new Date(1_700_000_000_000).toISOString()
    });
  });

  it("falls back to a generated createdAt when the kit omits one", () => {
    const msg = toChatMessage({ id: "m2", role: "user", text: "hi" });
    expect(typeof msg.createdAt).toBe("string");
    expect(msg.content).toEqual([{ kind: "text", text: "hi" }]);
  });
});

describe("makeChatBroadcast", () => {
  function capture() {
    const send = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send);
    return { send, broadcast };
  }

  it("thread_updated → threadUpdated with the converted view", () => {
    const { send, broadcast } = capture();
    const event: ChatControllerEvent = {
      type: "thread_updated",
      thread: {
        threadId: "t1",
        name: "Chat",
        createdAt: "a",
        modifiedAt: "b",
        anchorId: "cap_1",
        archived: false,
        pinned: false,
        lastMessagePreview: "",
        status: { kind: "idle" }
      }
    };
    broadcast(event);
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatThreadUpdated, {
      thread: expect.objectContaining({ anchorCaptureId: "cap_1", status: { kind: "idle" } })
    });
  });

  it("puts the controller's fixed backend identity on every thread_updated", () => {
    const send = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      fixedThreadConfig: {
        provider: "acp:gemini",
        model: "gemini-2.5-pro",
        reasoning: "high"
      }
    });

    broadcast({
      type: "thread_updated",
      thread: {
        threadId: "t-fixed",
        name: "Fixed",
        createdAt: "a",
        modifiedAt: "b",
        anchorId: null,
        archived: false,
        pinned: false,
        lastMessagePreview: "",
        status: { kind: "idle" }
      }
    });

    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatThreadUpdated, {
      thread: expect.objectContaining({
        provider: "acp:gemini",
        model: "gemini-2.5-pro",
        reasoning: "high"
      })
    });
  });

  it("decorates and observes a thread before owner routing filters its IPC", () => {
    const order: string[] = [];
    const send = vi.fn();
    const decorateThread = vi.fn((thread) => {
      order.push("decorate");
      return { ...thread, name: "decorated" };
    });
    const observeThread = vi.fn((thread) => {
      order.push("observe");
      expect(thread.name).toBe("decorated");
    });
    const shouldSend = vi.fn(() => {
      order.push("filter");
      return false;
    });
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      decorateThread,
      observeThread,
      shouldSend
    });

    broadcast({
      type: "thread_updated",
      thread: {
        threadId: "mcp-thread",
        name: "raw",
        createdAt: "a",
        modifiedAt: "b",
        anchorId: null,
        archived: false,
        pinned: false,
        lastMessagePreview: "",
        status: { kind: "idle" }
      }
    });

    expect(order).toEqual(["decorate", "observe", "filter"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("stream_delta → streamDelta verbatim", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "stream_delta",
      threadId: "t1",
      turnId: "turn_1",
      messageId: "m1",
      delta: "tok"
    });
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatStreamDelta, {
      threadId: "t1",
      turnId: "turn_1",
      messageId: "m1",
      delta: "tok"
    });
  });

  it("tool_call → toolCall with ok derived from status and label as summary", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "tool_call",
      threadId: "t1",
      turnId: "turn_1",
      toolCall: {
        id: "call_1",
        name: "library_search",
        kind: "search",
        label: "Searched the library",
        status: "completed"
      }
    });
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatToolCall, {
      threadId: "t1",
      turnId: "turn_1",
      callId: "call_1",
      tool: "library_search",
      ok: true,
      summary: "Searched the library"
    });
  });

  it("tool_call with failed status reports ok: false", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "tool_call",
      threadId: "t1",
      turnId: "turn_1",
      toolCall: {
        id: "call_2",
        name: "draw_arrow",
        kind: "other",
        label: "Couldn't: drew an arrow",
        status: "failed"
      }
    });
    const call = send.mock.calls.find((c) => c[0] === EVENT_CHANNELS.libraryChatToolCall);
    expect(call?.[1]).toMatchObject({ ok: false });
  });

  it("message_committed → messageCommitted with a converted ChatMessage", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "message_committed",
      threadId: "t1",
      message: { id: "m1", role: "assistant", text: "done", createdAt: 1 }
    });
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatMessageCommitted, {
      threadId: "t1",
      message: expect.objectContaining({
        id: "m1",
        role: "assistant",
        content: [{ kind: "text", text: "done" }],
        status: "complete"
      })
    });
  });

  it("runs post-journal assistant cleanup even when owner routing suppresses renderer IPC", () => {
    const send = vi.fn();
    const onAssistantCommitted = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      shouldSend: () => false,
      onAssistantCommitted
    });

    broadcast({
      type: "message_committed",
      threadId: "mcp-thread",
      message: { id: "assistant-final", role: "assistant", text: "done", createdAt: 1 }
    });
    broadcast({
      type: "message_committed",
      threadId: "mcp-thread",
      message: { id: "user-message", role: "user", text: "question", createdAt: 2 }
    });

    expect(send).not.toHaveBeenCalled();
    expect(onAssistantCommitted).toHaveBeenCalledTimes(1);
    expect(onAssistantCommitted).toHaveBeenCalledWith("mcp-thread");
  });

  it("uses the producer-side terminal message-status lookup", () => {
    const send = vi.fn();
    const messageStatusFor = vi.fn(() => "failed" as const);
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, { messageStatusFor });
    const event: ChatControllerEvent = {
      type: "message_committed",
      threadId: "t1",
      message: { id: "m-failed", role: "assistant", text: "partial", createdAt: 1 }
    };

    broadcast(event);

    expect(messageStatusFor).toHaveBeenCalledWith(event);
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatMessageCommitted, {
      threadId: "t1",
      message: expect.objectContaining({ id: "m-failed", status: "failed" })
    });
  });

  it("turn_interrupted → turnInterrupted with the user_interrupted reason", () => {
    const { send, broadcast } = capture();
    broadcast({ type: "turn_interrupted", threadId: "t1", turnId: "turn_1" });
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatTurnInterrupted, {
      threadId: "t1",
      turnId: "turn_1",
      reason: "user_interrupted"
    });
  });

  it("approval_requested → approvalRequested with a derived summary + detail", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "approval_requested",
      threadId: "t1",
      turnId: "turn_1",
      approval: {
        id: "ap_1",
        method: "item/commandExecution/requestApproval",
        kind: "exec",
        summary: "Run a command",
        params: { detail: "ls -la" }
      }
    });
    expect(send).toHaveBeenCalledWith(EVENT_CHANNELS.libraryChatApprovalRequested, {
      threadId: "t1",
      turnId: "turn_1",
      approvalId: "ap_1",
      summary: "Run a command",
      detail: "ls -la"
    });
  });

  it("approval_requested falls back to the method when no summary is present", () => {
    const { send, broadcast } = capture();
    broadcast({
      type: "approval_requested",
      threadId: "t1",
      turnId: "turn_1",
      approval: {
        id: "ap_2",
        method: "item/fileChange/requestApproval",
        kind: "patch",
        params: null
      }
    });
    const call = send.mock.calls.find(
      (c) => c[0] === EVENT_CHANNELS.libraryChatApprovalRequested
    );
    expect(call?.[1]).toEqual({
      threadId: "t1",
      turnId: "turn_1",
      approvalId: "ap_2",
      summary: "Approve: item/fileChange/requestApproval"
    });
  });

  it("denies an MCP-owned approval before broker registration or human IPC", () => {
    const send = vi.fn();
    const onApprovalRequested = vi.fn((_request: ChatApprovalRequest) => true);
    const onUnattendedApprovalRequested = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      onApprovalRequested,
      onUnattendedApprovalRequested,
      shouldSend: () => false
    });

    broadcast({
      type: "approval_requested",
      threadId: "mcp-thread",
      turnId: "turn-secret",
      approval: {
        id: "ap-secret",
        method: "item/commandExecution/requestApproval",
        kind: "exec",
        summary: "Run a command",
        params: {
          detail: "Visible by the existing chat policy",
          command: "never-forward-this-field",
          arguments: { token: "never-forward-this-value" }
        }
      }
    });

    expect(onUnattendedApprovalRequested).toHaveBeenCalledWith({
      threadId: "mcp-thread",
      turnId: "turn-secret",
      approvalId: "ap-secret"
    });
    expect(onApprovalRequested).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("strips controls and bidi while byte/line bounding huge approval text before broker and IPC", () => {
    const send = vi.fn();
    const onApprovalRequested = vi.fn((_request: ChatApprovalRequest) => true);
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      onApprovalRequested
    });

    broadcast({
      type: "approval_requested",
      threadId: "thread-hostile",
      turnId: "turn-hostile",
      approval: {
        id: "approval-hostile",
        method: "item/commandExecution/requestApproval",
        kind: "exec",
        summary: `Run\u0000\u202e${"🙂".repeat(1_000)}`,
        params: {
          detail: Array.from(
            { length: CHAT_APPROVAL_DETAIL_MAX_LINES + 20 },
            (_, index) => `line-${index}\u0007\u2066${"x".repeat(300)}`
          ).join("\n"),
          command: "never-forward-this-field"
        }
      }
    });

    expect(onApprovalRequested).toHaveBeenCalledTimes(1);
    const request = onApprovalRequested.mock.calls[0]![0] as ChatApprovalRequest;
    expect(Buffer.byteLength(request.summary, "utf8")).toBeLessThanOrEqual(
      CHAT_APPROVAL_SUMMARY_MAX_BYTES
    );
    expect(Buffer.byteLength(request.detail ?? "", "utf8")).toBeLessThanOrEqual(
      CHAT_APPROVAL_DETAIL_MAX_BYTES
    );
    expect((request.detail ?? "").split("\n").length).toBeLessThanOrEqual(
      CHAT_APPROVAL_DETAIL_MAX_LINES
    );
    expect(`${request.summary}${request.detail ?? ""}`).not.toMatch(
      /[\u0000\u0007\u202e\u2066]/u
    );
    expect(request).not.toHaveProperty("params");
    expect(send).toHaveBeenCalledWith(
      EVENT_CHANNELS.libraryChatApprovalRequested,
      request
    );
  });

  it("rejects hostile exact IDs before broker registration or renderer broadcast", () => {
    const send = vi.fn();
    const onApprovalRequested = vi.fn(() => true);
    const onInvalidApprovalRequested = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      onApprovalRequested,
      onInvalidApprovalRequested
    });

    for (const [threadId, turnId, approvalId] of [
      ["thread\u202espoofed", "turn-safe", "approval-safe"],
      ["thread-safe", "turn\u0000control", "approval-safe"],
      ["thread-safe", "turn-safe", "a".repeat(257)]
    ]) {
      broadcast({
        type: "approval_requested",
        threadId,
        turnId,
        approval: {
          id: approvalId,
          method: "item/fileChange/requestApproval",
          kind: "patch",
          summary: "Approve?",
          params: null
        }
      });
    }

    expect(onInvalidApprovalRequested).toHaveBeenCalledTimes(3);
    expect(onApprovalRequested).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses every renderer event arm when owner routing denies the thread", () => {
    const send = vi.fn();
    const onApprovalRequested = vi.fn(() => true);
    const onUnattendedApprovalRequested = vi.fn();
    const broadcast = makeChatBroadcast(LIBRARY_CHANNELS, send, {
      shouldSend: () => false,
      onApprovalRequested,
      onUnattendedApprovalRequested
    });
    const events: ChatControllerEvent[] = [
      {
        type: "thread_updated",
        thread: {
          threadId: "mcp-thread",
          name: "Hidden",
          createdAt: "a",
          modifiedAt: "b",
          anchorId: null,
          archived: false,
          pinned: false,
          lastMessagePreview: "",
          status: { kind: "idle" }
        }
      },
      {
        type: "stream_delta",
        threadId: "mcp-thread",
        turnId: "turn-1",
        messageId: "message-1",
        delta: "hidden"
      },
      {
        type: "tool_call",
        threadId: "mcp-thread",
        turnId: "turn-1",
        toolCall: {
          id: "call-1",
          name: "library_search",
          kind: "search",
          label: "Hidden",
          status: "completed"
        }
      },
      {
        type: "message_committed",
        threadId: "mcp-thread",
        message: { id: "message-1", role: "assistant", text: "hidden" }
      },
      { type: "turn_interrupted", threadId: "mcp-thread", turnId: "turn-1" },
      {
        type: "approval_requested",
        threadId: "mcp-thread",
        turnId: "turn-1",
        approval: {
          id: "approval-1",
          method: "item/fileChange/requestApproval",
          kind: "patch",
          params: null
        }
      }
    ];

    for (const event of events) broadcast(event);

    expect(send).not.toHaveBeenCalled();
    expect(onApprovalRequested).not.toHaveBeenCalled();
    expect(onUnattendedApprovalRequested).toHaveBeenCalledTimes(1);
  });
});
