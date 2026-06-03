// Behaviour-level coverage for the kit→PwrSnap event adapter — the
// PwrSnap-owned seam that keeps the renderer unchanged after the chat
// controller migrated to @pwrdrvr/agent-client. Asserts each neutral
// ChatControllerEvent lands on the right per-surface channel with the
// renderer's existing payload shape, and that the type renames
// (anchorId → anchorCaptureId, NormalizedMessage → ChatMessage,
// neutral status → discriminated LibraryChatThreadStatus) are correct.

import { describe, expect, it, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
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
  approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested
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
      status: { kind: "streaming", turnId: "turn_1" }
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
});
