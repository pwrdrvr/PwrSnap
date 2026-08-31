// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChatApprovalRequest, ChatMessage, LibraryChatThreadView } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { LibraryChatPanel } from "../LibraryChatPanel";
import { clearChatDraftsForTests } from "../../../shared/chat/chat-draft-store";

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
    anchorCaptureId: "cap-1",
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
  create?: () => Promise<unknown>;
  interrupt?: () => Promise<unknown>;
  send?: () => Promise<unknown>;
  history?: () => Promise<unknown>;
  settings?: unknown;
};

function installApi(
  seedThreads: LibraryChatThreadView[] = [],
  options: ApiOptions = {}
): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
  handlerCount: () => number;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string, req?: { threadId?: string }) => {
    if (name === "settings:read" && options.settings !== undefined) {
      return { ok: true, value: options.settings };
    }
    if (name === "codex:libraryChat:list") return { ok: true, value: { threads: seedThreads } };
    if (name === "codex:libraryChat:create") return options.create?.();
    if (name === "codex:libraryChat:history") {
      return options.history?.() ?? { ok: true, value: { messages: [] } };
    }
    if (name === "codex:libraryChat:send") {
      return options.send?.() ?? { ok: true, value: { turnId: "turn-1" } };
    }
    if (name === "codex:libraryChat:interrupt") {
      return options.interrupt?.() ?? { ok: true, value: undefined };
    }
    if (name === "codex:libraryChat:archive") {
      const thread = seedThreads.find((t) => t.threadId === req?.threadId) ?? seedThreads[0]!;
      return { ok: true, value: { ...thread, archived: true } };
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
    for (const handler of handlers.get(channel) ?? []) handler(payload);
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
    root?.render(createElement(LibraryChatPanel, { anchorCaptureId: "cap-1" }));
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

describe("LibraryChatPanel", () => {
  test("a new chat shows editable backend chips; a started thread shows locked chips", async () => {
    // No threads → draft/greeting → editable Provider/Model/Reasoning chips.
    const { el } = await renderPanel([]);
    expect(el.querySelector('[data-testid="chat-backend-chips-draft"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="chat-backend-chips-locked"]')).toBeNull();
  });

  test("ignores thread updates scoped to another capture", async () => {
    const { el, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: {
          ...makeThread("foreign", "Other capture chat"),
          anchorCaptureId: "cap-other"
        }
      });
    });
    expect(el.textContent).not.toContain("Other capture chat");
  });

  test("an existing (resumed) thread shows the locked backend chips, not the draft", async () => {
    const { el } = await renderPanel([makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z")]);
    expect(el.querySelector('[data-testid="chat-backend-chips-locked"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="chat-backend-chips-draft"]')).toBeNull();
  });

  test("keeps Library drafts scoped to each thread and the new-chat draft", async () => {
    const first = makeThread("t1", "First chat", "2026-05-30T10:00:00.000Z");
    const second = makeThread("t2", "Second chat", "2026-05-30T11:00:00.000Z");
    const { el } = await renderPanel([first, second]);

    await typeInto(
      el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "second draft"
    );
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="First chat"]')!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value).toBe("");

    await typeInto(
      el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "first draft"
    );
    await act(async () => {
      el.querySelector<HTMLButtonElement>(".ps-libchat-newchat")!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value).toBe("");

    await typeInto(
      el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "new draft"
    );
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="Second chat"]')!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("second draft");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="First chat"]')!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("first draft");

    await act(async () => {
      el.querySelector<HTMLButtonElement>(".ps-libchat-newchat")!.click();
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("new draft");
  });

  test("restores a Library thread draft after the panel unmounts", async () => {
    const thread = makeThread("t1", "Chat");
    const first = await renderPanel([thread]);
    await typeInto(
      first.el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!,
      "survives close"
    );
    await act(async () => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    const reopened = await renderPanel([thread]);
    expect(reopened.el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("survives close");
  });

  test("preserves a newer draft typed while the first thread is being created", async () => {
    const creating = deferred<unknown>();
    const sending = deferred<unknown>();
    const createdThread = makeThread("created", "Created chat");
    const { el } = await renderPanel([], {
      create: () => creating.promise,
      send: () => sending.promise,
      settings: {
        ai: {
          defaults: {
            libraryChat: { provider: "codex", model: "gpt-test", reasoning: "medium" }
          }
        }
      }
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "first message");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    await typeInto(textarea, "next message");

    await act(async () => {
      creating.resolve({ ok: true, value: createdThread });
      await creating.promise;
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("next message");

    await act(async () => {
      sending.resolve({ ok: true, value: { turnId: "turn-created" } });
      await sending.promise;
      await Promise.resolve();
    });
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!.value)
      .toBe("next message");
  });

  test("retains a thread's complete stream buffer while another thread is selected", async () => {
    const streaming = makeThread(
      "streaming",
      "Streaming chat",
      "2026-05-30T11:00:00.000Z",
      { kind: "streaming", turnId: "turn-streaming" }
    );
    const other = makeThread("other", "Other chat", "2026-05-30T10:00:00.000Z");
    const { el, emit } = await renderPanel([other, streaming]);

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "streaming",
        turnId: "turn-streaming",
        messageId: "message-streaming",
        delta: "prefix "
      });
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="Other chat"]')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "streaming",
        turnId: "turn-streaming",
        messageId: "message-streaming",
        delta: "suffix"
      });
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[title="Streaming chat"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(el.textContent).toContain("prefix suffix");
  });

  test("does not advertise or silently discard image attachments", async () => {
    const { el, dispatch } = await renderPanel([makeThread("t1", "Chat")]);
    const composer = el.querySelector<HTMLElement>('[data-testid="composer-root"]')!;
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    const image = new File(["image"], "capture.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type: image.type,
            getAsFile: () => image
          }
        ]
      }
    });

    await act(async () => {
      textarea.dispatchEvent(paste);
      await Promise.resolve();
    });

    expect(paste.defaultPrevented).toBe(false);
    expect(composer.classList.contains("ps-composer-dropzone")).toBe(false);
    expect(el.querySelector('[data-testid="composer-chips"]')).toBeNull();

    await typeInto(textarea, "text only");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledWith("codex:libraryChat:send", {
      threadId: "t1",
      text: "text only",
      anchorCaptureId: "cap-1"
    });
  });

  test("orders thread chips in creation order (oldest to newest), resumes most recent", async () => {
    const older = makeThread("t1", "Older chat", "2026-05-30T10:00:00.000Z");
    const newer = makeThread("t2", "Newer chat", "2026-05-30T11:00:00.000Z");
    const { el, dispatch } = await renderPanel([older, newer]);

    // Stable creation order — a chip never jumps to the front on activity.
    expect(
      Array.from(el.querySelectorAll(".ps-libchat-thread-name")).map((node) => node.textContent)
    ).toEqual(["Older chat", "Newer chat"]);
    // But on open we still resume the most-recently-active thread.
    expect(dispatch).toHaveBeenCalledWith("codex:libraryChat:history", { threadId: "t2" });
  });

  test("archives a thread when its close chip is clicked", async () => {
    const first = makeThread("t1", "Old chat", "2026-05-30T11:00:00.000Z");
    const second = makeThread("t2", "Keep chat", "2026-05-30T10:00:00.000Z");
    const { el, dispatch } = await renderPanel([first, second]);

    // Target by name, not position — the list is in creation order now.
    const shells = Array.from(el.querySelectorAll(".ps-libchat-thread-shell"));
    const target = shells.find(
      (s) => s.querySelector(".ps-libchat-thread-name")?.textContent === "Old chat"
    )!;
    const close = target.querySelector<HTMLButtonElement>(".ps-libchat-thread-close")!;
    await act(async () => {
      close.click();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledWith("codex:libraryChat:archive", {
      threadId: "t1",
      archived: true
    });
    expect(el.textContent).not.toContain("Old chat");
    expect(el.textContent).toContain("Keep chat");
  });

  test("rehydrates a pending approval, keeps it on Result failure, and clears on resolved event", async () => {
    const pendingApproval: ChatApprovalRequest = {
      threadId: "t1",
      turnId: "turn-1",
      approvalId: "approval-1",
      summary: "Run the requested command?"
    };
    const thread = {
      ...makeThread("t1", "Pending chat"),
      status: { kind: "awaiting_approval" as const, approvalId: "approval-1" },
      pendingApproval
    };
    const { el, dispatch, emit } = await renderPanel([thread]);
    expect(el.textContent).toContain("Run the requested command?");

    dispatch.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "ai",
        code: "approval_transport_failed",
        message: "raw transport error that must stay hidden"
      }
    });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="ps-approval-approve"]')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="ps-approval"]')).not.toBeNull();
    expect(el.textContent).toContain("request is still pending");
    expect(el.textContent).not.toContain("raw transport error");
    expect(dispatch).toHaveBeenCalledWith("codex:libraryChat:approval", {
      threadId: "t1",
      turnId: "turn-1",
      approvalId: "approval-1",
      decision: "approve"
    });

    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatApprovalResolved, {
        threadId: "t1",
        turnId: "turn-1",
        approvalId: "approval-1",
        decision: "approve"
      });
    });
    expect(el.querySelector('[data-testid="ps-approval"]')).toBeNull();
  });

  test("a resumed streaming thread exposes one accessible Stop and blocks duplicate sends", async () => {
    const cancellation = deferred<unknown>();
    const thread = makeThread(
      "t1",
      "Active chat",
      "2026-05-30T10:00:00.000Z",
      { kind: "streaming", turnId: "turn-1" }
    );
    const { el, dispatch } = await renderPanel([thread], {
      interrupt: () => cancellation.promise
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "draft for later");
    const stop = el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!;

    expect(stop.getAttribute("aria-label")).toBe("Stop response");
    expect(el.querySelector('[data-testid="composer-send"]')).toBeNull();
    await act(async () => {
      stop.click();
      stop.click();
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:libraryChat:interrupt")
    ).toEqual([["codex:libraryChat:interrupt", { threadId: "t1" }]]);
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:libraryChat:send")
    ).toHaveLength(0);
    expect(textarea.value).toBe("draft for later");

    await act(async () => {
      cancellation.resolve({ ok: true, value: undefined });
      await cancellation.promise;
    });
  });

  test("successful Stop preserves partial output, marks it interrupted, and keeps the draft", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m1",
        delta: "partial answer"
      });
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "next question");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "partial answer" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      await Promise.resolve();
    });

    expect(el.textContent).toContain("partial answer");
    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("interrupted");
    expect(el.querySelector('[data-testid="message-list-interrupted-m1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
    expect(textarea.value).toBe("next question");
  });

  test("keeps sends blocked until the interrupt command itself settles", async () => {
    const cancellation = deferred<unknown>();
    const thread = makeThread(
      "t1",
      "Chat",
      "2026-05-30T10:00:00.000Z",
      { kind: "streaming", turnId: "turn-1" }
    );
    const { el, emit, dispatch } = await renderPanel([thread], {
      interrupt: () => cancellation.promise
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "next question");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "partial" }],
          status: "interrupted",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(true);
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:libraryChat:send")
    ).toHaveLength(0);
    expect(textarea.value).toBe("next question");

    await act(async () => {
      cancellation.resolve({ ok: true, value: undefined });
      await cancellation.promise;
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
    expect(el.querySelector('[data-testid="composer-send"]')).not.toBeNull();
  });

  test("Stop failure keeps the partial turn active and makes Stop retryable", async () => {
    const { el, emit, dispatch } = await renderPanel([makeThread("t1", "Chat")], {
      interrupt: async () => ({
        ok: false,
        error: { kind: "ai", code: "codex_unreachable", message: "cancel failed" }
      })
    });
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m1",
        delta: "still working"
      });
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "keep this");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(el.querySelector('[role="alert"]')?.textContent).toContain("cancel failed");
    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("streaming");
    expect(el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(false);
    expect(textarea.value).toBe("keep this");

    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      dispatch.mock.calls.filter(([command]) => command === "codex:libraryChat:interrupt")
    ).toHaveLength(2);
  });

  test("a stale interrupted event cannot clear or relabel a newer turn", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m1",
        delta: "first answer"
      });
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "first answer" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn-2"
        })
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("complete");
    expect(el.querySelector('[data-testid="composer-stop"]')).not.toBeNull();
  });

  test("natural completion wins a late interrupted event", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m1",
        delta: "finished"
      });
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m1",
          role: "assistant",
          content: [{ kind: "text", text: "finished" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("complete");
    expect(el.querySelector('[data-testid="message-list-interrupted-m1"]')).toBeNull();
  });

  test("late events for an interrupted turn cannot reactivate or replace it", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m1",
        delta: "kept partial"
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m-late",
        delta: "late replacement"
      });
      emit(EVENT_CHANNELS.libraryChatToolCall, {
        threadId: "t1",
        turnId: "turn-1",
        callId: "late-tool",
        tool: "library_search",
        ok: true,
        summary: "Late tool"
      });
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn-1"
        })
      });
    });

    expect(el.textContent).toContain("kept partial");
    expect(el.textContent).not.toContain("late replacement");
    expect(el.querySelector('[data-testid="message-list-msg-m1"]')?.getAttribute("data-status"))
      .toBe("interrupted");
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
  });

  test("a correlated zero-delta late commit cannot settle a newer turn", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn-1"
        })
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:01.000Z", {
          kind: "streaming",
          turnId: "turn-2"
        })
      });
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m-late",
          role: "assistant",
          content: [{ kind: "text", text: "turn one partial" }],
          status: "interrupted",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
    });

    expect(el.querySelector('[data-testid="message-list-msg-m-late"]')?.getAttribute("data-status"))
      .toBe("interrupted");
    expect(el.querySelector('[data-testid="composer-stop"]')).not.toBeNull();
  });

  test("interrupt-before-commit keeps a late zero-delta assistant commit interrupted", async () => {
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")]);
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn-1"
        })
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-1",
        message: {
          id: "m-late",
          role: "assistant",
          content: [{ kind: "text", text: "late partial" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
    });

    expect(
      el.querySelector('[data-testid="message-list-msg-m-late"]')?.getAttribute("data-status")
    ).toBe("interrupted");
  });

  test("a late send result cannot resurrect Stop after the turn already completed", async () => {
    const send = deferred<unknown>();
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")], {
      send: () => send.promise
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "fast answer");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      emit(EVENT_CHANNELS.libraryChatThreadUpdated, {
        thread: makeThread("t1", "Chat", "2026-05-30T10:00:00.000Z", {
          kind: "streaming",
          turnId: "turn-fast"
        })
      });
      emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
        threadId: "t1",
        turnId: "turn-fast",
        message: {
          id: "m-fast",
          role: "assistant",
          content: [{ kind: "text", text: "done" }],
          status: "complete",
          createdAt: "2026-08-23T00:00:00.000Z"
        }
      });
      send.resolve({ ok: true, value: { turnId: "turn-fast" } });
      await send.promise;
      await Promise.resolve();
    });

    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
    expect(el.querySelector('[data-testid="composer-send"]')).not.toBeNull();
  });

  test("send failure preserves the composer draft and stays inline", async () => {
    const { el } = await renderPanel([makeThread("t1", "Chat")], {
      send: async () => ({
        ok: false,
        error: { kind: "ai", code: "codex_unreachable", message: "send failed" }
      })
    });
    const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await typeInto(textarea, "please retry");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(textarea.value).toBe("please retry");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain("send failed");
    expect(el.querySelector('[data-testid="composer-root"]')).not.toBeNull();
  });

  test("a delayed history response cannot erase a live interrupted partial", async () => {
    const history = deferred<unknown>();
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")], {
      history: () => history.promise
    });
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m-live",
        delta: "live partial"
      });
      emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
        threadId: "t1",
        turnId: "turn-1",
        reason: "user_interrupted"
      });
      history.resolve({
        ok: true,
        value: {
          messages: [
            {
              id: "m-old",
              role: "assistant",
              content: [{ kind: "text", text: "older history" }],
              status: "complete",
              createdAt: "2026-08-22T00:00:00.000Z"
            } satisfies ChatMessage
          ]
        }
      });
      await history.promise;
      await Promise.resolve();
    });

    expect(el.textContent).toContain("older history");
    expect(el.textContent).toContain("live partial");
    expect(el.querySelector('[data-testid="message-list-msg-m-live"]')?.getAttribute("data-status"))
      .toBe("interrupted");
  });

  test("terminal history beats a stale live streaming placeholder", async () => {
    const history = deferred<unknown>();
    const { el, emit } = await renderPanel([makeThread("t1", "Chat")], {
      history: () => history.promise
    });
    await act(async () => {
      emit(EVENT_CHANNELS.libraryChatStreamDelta, {
        threadId: "t1",
        turnId: "turn-1",
        messageId: "m-same",
        delta: "stale partial"
      });
      history.resolve({
        ok: true,
        value: {
          messages: [
            {
              id: "m-same",
              role: "assistant",
              content: [{ kind: "text", text: "terminal failure" }],
              status: "failed",
              createdAt: "2026-08-23T00:00:00.000Z"
            } satisfies ChatMessage
          ]
        }
      });
      await history.promise;
      await Promise.resolve();
    });

    expect(el.textContent).toContain("terminal failure");
    expect(el.textContent).not.toContain("stale partial");
    expect(el.querySelector('[data-testid="message-list-msg-m-same"]')?.getAttribute("data-status"))
      .toBe("failed");
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
  });

  test("unmount removes all chat event subscriptions", async () => {
    const { handlerCount } = await renderPanel([makeThread("t1", "Chat")]);
    expect(handlerCount()).toBeGreaterThan(0);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(handlerCount()).toBe(0);
  });
});
