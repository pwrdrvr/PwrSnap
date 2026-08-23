// @vitest-environment jsdom
// Editor chat is an integration wrapper around the real capture-scoped Library
// chat surface. Dispatching Send alone must never manufacture local AI output.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type ChatMessage,
  type LibraryChatThreadView
} from "@pwrsnap/shared";
import { ChatPanel } from "../panels/ChatPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameId += 1;
    const current = frameId;
    queueMicrotask(() => callback(0));
    return current;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
type Handler = (payload: unknown) => void;

interface ApiOptions {
  threads?: LibraryChatThreadView[];
  history?: ChatMessage[];
  listError?: { kind: "ai"; code: string; message: string };
  modelError?: { kind: "ai"; code: string; message: string };
  sendError?: { kind: "ai"; code: string; message: string };
}

interface TestApi {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => Promise<void>;
  listenerCount: () => number;
}

function makeThread(
  threadId: string,
  status: LibraryChatThreadView["status"] = { kind: "idle" }
): LibraryChatThreadView {
  return {
    threadId,
    name: "Capture chat",
    createdAt: "2026-08-23T10:00:00.000Z",
    modifiedAt: "2026-08-23T10:00:00.000Z",
    anchorCaptureId: "cap_chat_1",
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status,
    pendingApproval: null,
    provider: "codex",
    model: "gpt-test",
    reasoning: "medium"
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  text: string,
  status: ChatMessage["status"] = "complete"
): ChatMessage {
  return {
    id,
    role,
    content: [{ kind: "text", text }],
    status,
    createdAt: "2026-08-23T10:00:00.000Z"
  };
}

function installApi(options: ApiOptions = {}): TestApi {
  const handlers = new Map<string, Set<Handler>>();
  const seedThreads = options.threads ?? [];
  const created = makeThread("thread-created");
  const dispatch = vi.fn(async (name: string, request?: { threadId?: string }) => {
    if (name === "settings:read") {
      return {
        ok: true,
        value: {
          ai: {
            acp: { enabledAgentIds: [] },
            defaults: {
              libraryChat: { provider: "codex", model: "gpt-test", reasoning: "medium" }
            }
          }
        }
      };
    }
    if (name === "codex:models") {
      if (options.modelError !== undefined) return { ok: false, error: options.modelError };
      return {
        ok: true,
        value: {
          models: [
            {
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              description: "",
              hidden: false,
              inputModalities: ["text", "image"],
              defaultServiceTier: null,
              isDefault: true
            }
          ]
        }
      };
    }
    if (name === "codex:libraryChat:list") {
      if (options.listError !== undefined) return { ok: false, error: options.listError };
      return { ok: true, value: { threads: seedThreads } };
    }
    if (name === "codex:libraryChat:history") {
      return { ok: true, value: { messages: options.history ?? [] } };
    }
    if (name === "codex:libraryChat:create") return { ok: true, value: created };
    if (name === "codex:libraryChat:send") {
      if (options.sendError !== undefined) return { ok: false, error: options.sendError };
      return { ok: true, value: { turnId: "turn-real" } };
    }
    if (name === "codex:libraryChat:interrupt") return { ok: true, value: undefined };
    if (name === "codex:libraryChat:archive") {
      const thread = seedThreads.find((candidate) => candidate.threadId === request?.threadId);
      return { ok: true, value: { ...(thread ?? created), archived: true } };
    }
    return { ok: true, value: undefined };
  });
  const on = (channel: string, handler: Handler): (() => void) => {
    const listeners = handlers.get(channel) ?? new Set<Handler>();
    listeners.add(handler);
    handlers.set(channel, listeners);
    return () => listeners.delete(handler);
  };
  window.pwrsnapApi = {
    dispatch,
    on,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return {
    dispatch,
    emit: async (channel, payload) => {
      await act(async () => {
        for (const handler of handlers.get(channel) ?? []) handler(payload);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    listenerCount: () =>
      [...handlers.values()].reduce((count, listeners) => count + listeners.size, 0)
  };
}

async function renderPanel(options: ApiOptions = {}): Promise<{ el: HTMLDivElement; api: TestApi }> {
  const api = installApi(options);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ChatPanel, { captureId: "cap_chat_1" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { el: container, api };
}

async function enterText(el: HTMLDivElement, value: string): Promise<HTMLTextAreaElement> {
  const textarea = el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  if (textarea === null) throw new Error("composer input missing");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  return textarea;
}

async function click(el: Element | null): Promise<void> {
  if (!(el instanceof HTMLButtonElement)) throw new Error("button missing");
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  delete window.pwrsnapApi;
});

describe("Editor ChatPanel", () => {
  test("sends through capture-scoped persisted chat and renders only bus-delivered AI output", async () => {
    const { el, api } = await renderPanel();
    expect(el.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
    expect(api.dispatch).toHaveBeenCalledWith("codex:libraryChat:list", {
      anchorCaptureId: "cap_chat_1"
    });

    await enterText(el, "make the arrows orange");
    await click(el.querySelector('[data-testid="composer-send"]'));

    expect(api.dispatch).toHaveBeenCalledWith(
      "codex:libraryChat:create",
      expect.objectContaining({ anchorCaptureId: "cap_chat_1", provider: "codex" })
    );
    expect(api.dispatch).toHaveBeenCalledWith("codex:libraryChat:send", {
      threadId: "thread-created",
      text: "make the arrows orange",
      anchorCaptureId: "cap_chat_1"
    });
    expect(el.querySelector('[data-role="assistant"]')).toBeNull();
    expect(el.textContent).not.toContain("Dynamic tools aren't wired to AI yet");

    await api.emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
      threadId: "thread-created",
      message: message("user-real", "user", "make the arrows orange")
    });
    await api.emit(EVENT_CHANNELS.libraryChatStreamDelta, {
      threadId: "thread-created",
      turnId: "turn-real",
      messageId: "assistant-real",
      delta: "Real streamed answer"
    });
    expect(el.textContent).toContain("Real streamed answer");

    await api.emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
      threadId: "thread-created",
      message: message("assistant-real", "assistant", "Real committed answer")
    });
    expect(el.textContent).toContain("Real committed answer");
    expect(el.textContent).not.toContain("pending");
  });

  test("shows a truthful unavailable state when the real chat command fails", async () => {
    const { el } = await renderPanel({
      listError: {
        kind: "ai",
        code: "codex_unreachable",
        message: "Codex is not installed or signed in."
      }
    });
    expect(el.textContent).toContain("Chat is unavailable");
    expect(el.textContent).toContain("Codex is not installed or signed in.");
    expect(el.querySelector('[data-testid="composer-input"]')).toBeNull();
    expect(el.querySelector('[data-role="assistant"]')).toBeNull();
  });

  test("disables new chat when the configured provider cannot report models", async () => {
    const { el } = await renderPanel({
      modelError: {
        kind: "ai",
        code: "codex_unreachable",
        message: "Codex App Server is offline."
      }
    });
    expect(el.querySelector('[data-testid="chat-backend-unavailable"]')?.textContent).toBe(
      "Codex is unavailable. Codex App Server is offline."
    );
    expect(el.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.disabled).toBe(
      true
    );
    expect(el.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.disabled).toBe(
      true
    );
    expect(el.querySelector('[data-role="assistant"]')).toBeNull();
  });

  test("keeps the draft and transcript visible when sending fails", async () => {
    const { el } = await renderPanel({
      threads: [makeThread("thread-existing")],
      history: [message("prior-user", "user", "earlier")],
      sendError: {
        kind: "ai",
        code: "codex_unreachable",
        message: "Codex App Server is offline."
      }
    });
    const textarea = await enterText(el, "try this edit");
    await click(el.querySelector('[data-testid="composer-send"]'));

    expect(textarea.value).toBe("try this edit");
    expect(el.textContent).toContain("earlier");
    expect(el.textContent).toContain("Message not sent: Codex App Server is offline.");
    expect(el.querySelector('[data-role="assistant"]')).toBeNull();
  });

  test("delegates Stop and preserves the shared interrupted partial output", async () => {
    const running = makeThread("thread-running", { kind: "streaming", turnId: "turn-1" });
    const { el, api } = await renderPanel({
      threads: [running],
      history: [message("user-1", "user", "redact the email")]
    });

    await api.emit(EVENT_CHANNELS.libraryChatStreamDelta, {
      threadId: "thread-running",
      turnId: "turn-1",
      messageId: "assistant-1",
      delta: "I redacted part"
    });
    await click(el.querySelector('button[aria-label="Stop response"]'));
    expect(api.dispatch).toHaveBeenCalledWith("codex:libraryChat:interrupt", {
      threadId: "thread-running"
    });

    await api.emit(EVENT_CHANNELS.libraryChatTurnInterrupted, {
      threadId: "thread-running",
      turnId: "turn-1",
      reason: "user_interrupted"
    });
    await api.emit(EVENT_CHANNELS.libraryChatMessageCommitted, {
      threadId: "thread-running",
      turnId: "turn-1",
      message: message("assistant-1", "assistant", "I redacted part")
    });

    const partial = el.querySelector('[data-testid="message-list-msg-assistant-1"]');
    expect(partial?.getAttribute("data-status")).toBe("interrupted");
    expect(partial?.textContent).toContain("I redacted part");
  });

  test("unmount removes subscriptions without archiving or interrupting the persisted thread", async () => {
    const { api } = await renderPanel({ threads: [makeThread("thread-long-lived")] });
    expect(api.listenerCount()).toBeGreaterThan(0);
    await act(async () => {
      root?.unmount();
    });
    root = null;
    expect(api.listenerCount()).toBe(0);
    const commandNames = api.dispatch.mock.calls.map(([name]) => name);
    expect(commandNames).not.toContain("codex:libraryChat:archive");
    expect(commandNames).not.toContain("codex:libraryChat:interrupt");
  });
});
