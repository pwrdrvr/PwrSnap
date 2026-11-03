// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage, LibraryChatThreadView } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { ChatPanelSurface } from "../ChatPanelSurface";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function flushFrames(): Promise<void> {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function thread(threadId: string, turnId: string | null): LibraryChatThreadView {
  return {
    threadId, name: threadId, anchorCaptureId: "scope-1", archived: false,
    pinned: false, createdAt: "2026-11-01T00:00:00.000Z",
    modifiedAt: "2026-11-01T00:00:00.000Z", lastMessagePreview: "",
    provider: "codex", model: null, reasoning: null, pendingApproval: null,
    status: turnId === null ? { kind: "idle" } : { kind: "streaming", turnId }
  };
}

describe.each(["library", "sizzle"] as const)("%s turn view ownership", (surface) => {
  const channels = surface === "library" ? {
    delta: EVENT_CHANNELS.libraryChatStreamDelta,
    commit: EVENT_CHANNELS.libraryChatMessageCommitted,
    interrupted: EVENT_CHANNELS.libraryChatTurnInterrupted,
    updated: EVENT_CHANNELS.libraryChatThreadUpdated
  } : {
    delta: EVENT_CHANNELS.sizzleChatStreamDelta,
    commit: EVENT_CHANNELS.sizzleChatMessageCommitted,
    interrupted: EVENT_CHANNELS.sizzleChatTurnInterrupted,
    updated: EVENT_CHANNELS.sizzleChatThreadUpdated
  };

  async function mount(interrupt: () => Promise<unknown> = async () => ({ ok: true })) {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const dispatch = vi.fn(async (name: string) => {
      if (name.endsWith(":list")) return { ok: true, value: { threads: [thread("a", "turn-a"), thread("b", null)] } };
      if (name.endsWith(":history")) return { ok: true, value: { messages: [] } };
      if (name.endsWith(":interrupt")) return interrupt();
      return { ok: true, value: undefined };
    });
    window.pwrsnapApi = {
      dispatch,
      on: (channel: string, handler: (payload: unknown) => void) => {
        const listeners = handlers.get(channel) ?? new Set();
        listeners.add(handler);
        handlers.set(channel, listeners);
        return () => listeners.delete(handler);
      },
      startCaptureDrag: () => undefined
    } as unknown as NonNullable<Window["pwrsnapApi"]>;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ChatPanelSurface surface={surface} scopeId="scope-1" testId="panel" />);
    });
    const emit = (channel: string, payload: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler(payload);
    };
    const select = async (id: string) => {
      await act(async () => container!.querySelector<HTMLButtonElement>(`button[title="${id}"]`)!.click());
      await flushFrames();
      expect(container?.querySelector(".is-active .ps-libchat-thread-name")?.textContent).toBe(id);
    };
    const delta = (text: string) => emit(channels.delta, {
      threadId: "a", turnId: "turn-a", messageId: "message-a", delta: text
    });
    const commit = (status: ChatMessage["status"]) => emit(channels.commit, {
      threadId: "a", turnId: "turn-a", message: {
        id: "message-a", role: "assistant", content: [{ kind: "text", text: "answer" }],
        status, createdAt: "2026-11-01T00:00:00.000Z"
      }
    });
    return { emit, select, delta, commit, dispatch };
  }

  test.each(["complete", "interrupted"] as const)(
    "a background %s commit rejects stale deltas and streaming views on return",
    async (status) => {
      const { emit, select, delta, commit } = await mount();
      await act(async () => delta("answer"));
      await flushFrames();
      expect(container?.textContent).toContain("answer");
      await select("b");
      await act(async () => {
        commit(status);
        emit(channels.updated, { thread: thread("a", null) });
        delta(" stale suffix");
        emit(channels.updated, { thread: thread("a", "turn-a") });
      });
      await select("a");
      expect(container?.textContent).not.toContain("stale suffix");
      expect(container?.querySelector('[data-testid="composer-stop"]')).toBeNull();
    }
  );

  test("an interruption received offscreen retires its stream before navigation returns", async () => {
    const { emit, select, delta } = await mount();
    await act(async () => delta("partial"));
    await flushFrames();
    expect(container?.textContent).toContain("partial");
    await select("b");
    await act(async () => {
      emit(channels.interrupted, { threadId: "a", turnId: "turn-a", reason: "user_interrupted" });
      emit(channels.updated, { thread: thread("a", null) });
      delta(" stale suffix");
    });
    await select("a");
    expect(container?.textContent).not.toContain("stale suffix");
    expect(container?.querySelector('[data-testid="composer-stop"]')).toBeNull();
  });

  test("navigation preserves a pending Stop guard even after completion", async () => {
    const acknowledgement = deferred<unknown>();
    const { select, commit, dispatch } = await mount(() => acknowledgement.promise);
    await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.click());
    await select("b");
    await select("a");
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(true);
    await act(async () => container?.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.click());
    expect(dispatch.mock.calls.filter(([name]) => name.endsWith(":interrupt"))).toHaveLength(1);
    await act(async () => commit("complete"));
    expect(container?.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]')?.disabled).toBe(true);
    await act(async () => {
      acknowledgement.resolve({ ok: true, value: undefined });
      await acknowledgement.promise;
    });
    expect(container?.querySelector('[data-testid="composer-stop"]')).toBeNull();
  });
});
