// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatApprovalRequest, ChatMessage, LibraryChatThreadView } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { SizzleChatPanel } from "../SizzleChatPanel";
import { clearChatDraftsForTests } from "../../shared/chat/chat-draft-store";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function makeThread(
  threadId: string,
  name: string,
  modifiedAt = "2026-05-30T10:00:00.000Z",
  status: LibraryChatThreadView["status"] = { kind: "idle" }
): LibraryChatThreadView {
  return {
    threadId,
    name,
    createdAt: modifiedAt,
    modifiedAt,
    anchorCaptureId: "sz_1",
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status,
    pendingApproval: null,
    provider: null,
    model: null,
    reasoning: null
  };
}

type ApiOptions = {
  interrupt?: () => Promise<unknown>;
  send?: () => Promise<unknown>;
  history?: () => Promise<unknown>;
};

function installApi(seedThreads: LibraryChatThreadView[] = [], options: ApiOptions = {}): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
  handlerCount: () => number;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:sizzleChat:list") return { ok: true, value: { threads: seedThreads } };
    if (name === "codex:sizzleChat:create") {
      return {
        ok: true,
        value: {
          threadId: "t1",
          name: "Chat",
          createdAt: "",
          modifiedAt: "",
          anchorCaptureId: "sz_1",
          archived: false,
          pinned: false,
          lastMessagePreview: "",
          status: { kind: "idle" },
          pendingApproval: null,
          provider: null,
          model: null,
          reasoning: null
        }
      };
    }
    if (name === "codex:sizzleChat:send") {
      return options.send?.() ?? { ok: true, value: { turnId: "turn1" } };
    }
    if (name === "codex:sizzleChat:interrupt") {
      return options.interrupt?.() ?? { ok: true, value: undefined };
    }
    if (name === "codex:sizzleChat:history") {
      return options.history?.() ?? { ok: true, value: { messages: [] } };
    }
    return { ok: true, value: undefined };
  });
  const on = (channel: string, handler: Handler): (() => void) => {
    const set = handlers.get(channel) ?? new Set<Handler>();
    set.add(handler);
    handlers.set(channel, set);
    return () => set.delete(handler);
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  };
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return {
    dispatch,
    emit,
    handlerCount: () =>
      [...handlers.values()].reduce((count, handlersForChannel) => count + handlersForChannel.size, 0)
  };
}

async function renderPanel(
  seedThreads: LibraryChatThreadView[] = [],
  options: ApiOptions = {}
): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
  handlerCount: () => number;
}> {
  const api = installApi(seedThreads, options);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SizzleChatPanel, { projectId: "sz_1" }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { el: container, ...api };
}

async function typeInto(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  clearChatDraftsForTests();
});

describe("SizzleChatPanel", () => {
  test("lists threads scoped to the project on mount + shows the greeting", async () => {
    const { el, dispatch } = await renderPanel();
    expect(dispatch).toHaveBeenCalledWith("codex:sizzleChat:list", { anchorCaptureId: "sz_1" });
    // No threads ⇒ greeting state.
    expect(el.querySelector('[data-testid="sizzle-chat-panel"]')).not.toBeNull();
    expect(el.textContent).toContain("Reel composer");
  });

  test("auto-resumes the reel's most-recent thread instead of the greeting", async () => {
    const { el, dispatch } = await renderPanel([makeThread("t1", "Earlier chat")]);
    // The existing thread is auto-selected → its history is loaded and the
    // greeting is gone (the conversation reopens on reel switch / relaunch).
    expect(dispatch).toHaveBeenCalledWith("codex:sizzleChat:history", { threadId: "t1" });
    expect(el.textContent).not.toContain("Describe the video you want");
    expect(el.textContent).toContain("Earlier chat");
  });

  test("keeps Sizzle drafts scoped across thread switches", async () => {
    const first = makeThread("t1", "First reel", "2026-05-30T10:00:00.000Z");
    const second = makeThread("t2", "Second reel", "2026-05-30T11:00:00.000Z");
    const { el } = await renderPanel([first, second]);
    await typeInto(
      el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "second reel draft"
    );

    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="First reel"]')!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value).toBe("");
    await typeInto(
      el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "first reel draft"
    );

    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="Second reel"]')!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("second reel draft");
  });

  test("restores a Sizzle draft after Hide-style panel unmount", async () => {
    const thread = makeThread("t1", "Reel chat");
    const first = await renderPanel([thread]);
    await typeInto(
      first.el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "survives hide"
    );
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    const reopened = await renderPanel([thread]);
    expect(reopened.el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("survives hide");
  });

  test("orders thread chips in creation order (oldest to newest), resumes most recent", async () => {
    const older = makeThread("t1", "Older chat", "2026-05-30T10:00:00.000Z");
    const newer = makeThread("t2", "Newer chat", "2026-05-30T11:00:00.000Z");
    const { el, dispatch } = await renderPanel([older, newer]);

    expect(
      Array.from(el.querySelectorAll(".ps-libchat-thread-name")).map((node) => node.textContent)
    ).toEqual(["Older chat", "Newer chat"]);
    expect(dispatch).toHaveBeenCalledWith("codex:sizzleChat:history", { threadId: "t2" });
  });

  test("starting the first chat does NOT create a duplicate thread tile", async () => {
    // Repro of the reported bug: sending the first message both (a) gets
    // the created thread back and optimistically prepends it AND (b)
    // receives the controller's threadUpdated broadcast for the same
    // thread. If the optimistic add doesn't dedup, the SAME thread shows
    // as two tiles. create() returns thread "t1"; we also broadcast t1.
    const { el, emit } = await renderPanel();

    // The controller's create broadcast lands first (strip = [t1]).
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: makeThread("t1", "Chat 2026-05-29")
      });
    });

    // The user sends their first message → onSubmit creates t1 and adds it.
    const ta = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )!.set!;
      setter.call(ta, "make a reel");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly one tile for the one thread.
    expect(el.querySelectorAll(".ps-libchat-thread")).toHaveLength(1);
  });

  test("a thread-updated broadcast adds the thread to the strip", async () => {
    const { el, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: {
          threadId: "t1",
          name: "My reel chat",
          createdAt: "",
          modifiedAt: "",
          anchorCaptureId: "sz_1",
          archived: false,
          pinned: false,
          lastMessagePreview: "",
          status: { kind: "idle" },
          pendingApproval: null,
          provider: null,
          model: null,
          reasoning: null
        }
      });
    });
    expect(el.textContent).toContain("My reel chat");
  });

  test("ignores thread updates belonging to another Sizzle project", async () => {
    const { el, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: {
          ...makeThread("other-thread", "Other project chat"),
          anchorCaptureId: "sz_other"
        }
      });
    });
    expect(el.textContent).not.toContain("Other project chat");
    expect(el.querySelectorAll(".ps-libchat-thread")).toHaveLength(0);
  });

  test("keeps the project approval retryable after a Result error until its resolved event", async () => {
    const pendingApproval: ChatApprovalRequest = {
      threadId: "t1",
      turnId: "turn-1",
      approvalId: "approval-1",
      summary: "Run the render helper?"
    };
    const thread: LibraryChatThreadView = {
      ...makeThread("t1", "Pending reel chat"),
      status: { kind: "awaiting_approval", approvalId: "approval-1" },
      pendingApproval
    };
    const { el, dispatch, emit } = await renderPanel([thread]);
    expect(el.textContent).toContain("Run the render helper?");

    dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "ai",
        code: "approval_transport_failed",
        message: "private raw failure"
      }
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="ps-approval-approve"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="ps-approval-retry"]')).not.toBeNull();
    expect(el.textContent).not.toContain("private raw failure");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="ps-approval-retry"]')?.click();
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenLastCalledWith("codex:sizzleChat:approval", {
      threadId: "t1",
      turnId: "turn-1",
      approvalId: "approval-1",
      decision: "approve"
    });
    expect(el.querySelector('[data-testid="ps-approval"]')).not.toBeNull();

    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatApprovalResolved, {
        threadId: "t1",
        turnId: "turn-1",
        approvalId: "approval-1",
        decision: "approve"
      });
    });
    expect(el.querySelector('[data-testid="ps-approval"]')).toBeNull();
  });

  test("a streaming reel chat exposes Stop and dispatches the Sizzle interrupt once", async () => {
    const thread = makeThread(
      "t1",
      "Active reel",
      "2026-05-30T10:00:00.000Z",
      { kind: "streaming", turnId: "turn1" }
    );
    const { el, dispatch } = await renderPanel([thread]);
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "next reel instruction");

    await act(async () => {
      const stop = el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!;
      expect(stop.getAttribute("aria-label")).toBe("Stop response");
      stop.click();
      stop.click();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:sizzleChat:interrupt")
    ).toEqual([["codex:sizzleChat:interrupt", { threadId: "t1" }]]);
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:sizzleChat:send")
    ).toHaveLength(0);
    expect(textarea.value).toBe("next reel instruction");
  });

  test("switching threads gives the new active turn its own Stop guard", async () => {
    const firstStop = deferred<unknown>();
    let stopCalls = 0;
    const older = makeThread(
      "t2",
      "Second reel chat",
      "2026-05-30T10:00:00.000Z",
      { kind: "streaming", turnId: "turn2" }
    );
    const newer = makeThread(
      "t1",
      "First reel chat",
      "2026-05-30T11:00:00.000Z",
      { kind: "streaming", turnId: "turn1" }
    );
    const { el, dispatch } = await renderPanel([older, newer], {
      interrupt: () => {
        stopCalls += 1;
        return stopCalls === 1
          ? firstStop.promise
          : Promise.resolve({ ok: true, value: undefined });
      }
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      const secondShell = Array.from(el.querySelectorAll(".ps-libchat-thread-shell")).find(
        (shell) => shell.querySelector(".ps-libchat-thread-name")?.textContent === "Second reel chat"
      )!;
      secondShell.querySelector<HTMLButtonElement>(".ps-libchat-thread")!.click();
      await Promise.resolve();
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:sizzleChat:interrupt")
    ).toEqual([
      ["codex:sizzleChat:interrupt", { threadId: "t1" }],
      ["codex:sizzleChat:interrupt", { threadId: "t2" }]
    ]);

    await act(async () => {
      firstStop.resolve({ ok: true, value: undefined });
      await firstStop.promise;
    });
  });

  test("Stop retains streamed reel output and marks the partial bubble interrupted", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m1",
        delta: "three-scene draft"
      });
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "keep this next draft");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      emit(EVENT_CHANNELS.sizzleChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "three-scene draft" }],
          status: "interrupted",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
      await Promise.resolve();
    });

    expect(el.textContent).toContain("three-scene draft");
    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("interrupted");
    expect(el.querySelector('[data-testid="message-list-interrupted-m1"]')).not.toBeNull();
    expect(textarea.value).toBe("keep this next draft");
  });

  test("keeps Sizzle sends blocked until the interrupt command settles", async () => {
    const cancellation = deferred<unknown>();
    const thread = makeThread(
      "t1",
      "Reel chat",
      "2026-05-30T10:00:00.000Z",
      { kind: "streaming", turnId: "turn1" }
    );
    const { el, emit, dispatch } = await renderPanel([thread], {
      interrupt: () => cancellation.promise
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "next reel draft");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      emit(EVENT_CHANNELS.sizzleChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "partial reel" }],
          status: "interrupted",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(true);
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:sizzleChat:send")
    ).toHaveLength(0);
    expect(textarea.value).toBe("next reel draft");

    await act(async () => {
      cancellation.resolve({ ok: true, value: undefined });
      await cancellation.promise;
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
    expect(el.querySelector('[data-testid="composer-send"]')).not.toBeNull();
  });

  test("Sizzle Stop failure leaves the turn active and retryable", async () => {
    const { el, emit, dispatch } = await renderPanel([makeThread("t1", "Reel chat")], {
      interrupt: async () => ({
        ok: false,
        error: { kind: "ai", code: "codex_unreachable", message: "session cancel failed" }
      })
    });
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m1",
        delta: "partial reel"
      });
    });

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("session cancel failed");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(false);
    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("streaming");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:sizzleChat:interrupt")
    ).toHaveLength(2);
  });

  test("a stale reel interruption cannot clear a newer active turn", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m1",
        delta: "finished reel plan"
      });
      emit(EVENT_CHANNELS.sizzleChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "finished reel plan" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: makeThread("t1", "Reel chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn2"
        })
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("complete");
    expect(el.querySelector('[data-testid="composer-stop"]')).not.toBeNull();
  });

  test("natural completion wins a late Sizzle interruption", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m1",
        delta: "finished reel"
      });
      emit(EVENT_CHANNELS.sizzleChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "finished reel" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("complete");
  });

  test("late Sizzle events cannot reactivate an interrupted turn", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m1",
        delta: "kept reel partial"
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m-late",
        delta: "late reel replacement"
      });
      emit(EVENT_CHANNELS.sizzleChatToolCall, {
        threadId: "t1",
        turnId: "turn1",
        callId: "late-tool",
        tool: "sizzle_edit",
        ok: true,
        summary: "Late edit"
      });
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: makeThread("t1", "Reel chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn1"
        })
      });
    });

    expect(el.textContent).toContain("kept reel partial");
    expect(el.textContent).not.toContain("late reel replacement");
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
  });

  test("a correlated late Sizzle commit cannot settle a newer turn", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: makeThread("t1", "Reel chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn1"
        })
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
      emit(EVENT_CHANNELS.sizzleChatThreadUpdated, {
        thread: makeThread("t1", "Reel chat", "2026-05-30T10:00:01.000Z", {
          kind: "streaming",
          turnId: "turn2"
        })
      });
      emit(EVENT_CHANNELS.sizzleChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn1",
        message: {
          id: "m-late",
          role: "assistant",
          content: [{ kind: "text", text: "turn one reel" }],
          status: "interrupted",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m-late"]')?.getAttribute("data-status"))
      .toBe("interrupted");
    expect(el.querySelector('[data-testid="composer-stop"]')).not.toBeNull();
  });

  test("delayed Sizzle history cannot erase a live interrupted partial", async () => {
    const history = deferred<unknown>();
    const { el, emit } = await renderPanel([makeThread("t1", "Reel chat")], {
      history: () => history.promise
    });
    await act(async () => {
      emit(EVENT_CHANNELS.sizzleChatStreamDelta, {
        threadId: "t1",
        turnId: "turn1",
        messageId: "m-live",
        delta: "live reel partial"
      });
      emit(EVENT_CHANNELS.sizzleChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn1",
        reason: "user_interrupted"
      });
      history.resolve({
        ok: true,
        value: {
          messages: [
            {
              id: "m-old",
              role: "assistant",
              content: [{ kind: "text", text: "older reel history" }],
              status: "complete",
              createdAt: "2026-08-22T00:00:00.000Z"
            } satisfies ChatMessage
          ]
        }
      });
      await history.promise;
      await Promise.resolve();
    });

    expect(el.textContent).toContain("older reel history");
    expect(el.textContent).toContain("live reel partial");
    expect(el.querySelector('[data-testid="message-list-msg-m-live"]')?.getAttribute("data-status"))
      .toBe("interrupted");
  });

  test("unmount removes every Sizzle chat event subscription", async () => {
    const { handlerCount } = await renderPanel([makeThread("t1", "Reel chat")]);
    expect(handlerCount()).toBeGreaterThan(0);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(handlerCount()).toBe(0);
  });
});
