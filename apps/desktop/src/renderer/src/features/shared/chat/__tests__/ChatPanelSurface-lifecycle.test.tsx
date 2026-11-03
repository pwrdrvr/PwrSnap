// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage, LibraryChatThreadView } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { ChatPanelSurface } from "../ChatPanelSurface";
import { clearChatDraftsForTests } from "../chat-draft-store";

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
  clearChatDraftsForTests();
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
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
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
    updated: EVENT_CHANNELS.libraryChatThreadUpdated,
    approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested,
    approvalResolved: EVENT_CHANNELS.libraryChatApprovalResolved
  } : {
    delta: EVENT_CHANNELS.sizzleChatStreamDelta,
    commit: EVENT_CHANNELS.sizzleChatMessageCommitted,
    interrupted: EVENT_CHANNELS.sizzleChatTurnInterrupted,
    updated: EVENT_CHANNELS.sizzleChatThreadUpdated,
    approvalRequested: EVENT_CHANNELS.sizzleChatApprovalRequested,
    approvalResolved: EVENT_CHANNELS.sizzleChatApprovalResolved
  };

  async function mount(
    interrupt: () => Promise<unknown> = async () => ({ ok: true }),
    approval: () => Promise<unknown> = async () => ({ ok: true })
  ) {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const dispatch = vi.fn(async (name: string) => {
      if (name.endsWith(":list")) return { ok: true, value: { threads: [thread("a", "turn-a"), thread("b", null)] } };
      if (name.endsWith(":history")) return { ok: true, value: { messages: [] } };
      if (name.endsWith(":interrupt")) return interrupt();
      if (name.endsWith(":approval")) return approval();
      if (name.endsWith(":send")) return { ok: true, value: { turnId: "turn-third" } };
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
    const commit = (status: ChatMessage["status"], turnId = "turn-a") => emit(channels.commit, {
      threadId: "a", turnId, message: {
        id: turnId === "turn-a" ? "message-a" : turnId,
        role: "assistant", content: [{ kind: "text", text: "answer" }],
        status, createdAt: "2026-11-01T00:00:00.000Z"
      }
    });
    return { emit, select, delta, commit, dispatch };
  }

  function stopButton(): HTMLButtonElement | null {
    return container!.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]');
  }

  test("a delayed delta from another turn cannot retire the current live Stop", async () => {
    const acknowledgement = deferred<unknown>();
    const interrupt = vi.fn(() => acknowledgement.promise);
    const { emit, commit } = await mount(interrupt);
    await act(async () => stopButton()!.click());
    await act(async () => emit(channels.delta, {
      threadId: "a", turnId: "turn-before-a", messageId: "old-message", delta: "late old delta"
    }));
    const disabled = stopButton()?.disabled;
    await act(async () => stopButton()!.click());
    await act(async () => {
      commit("complete");
      acknowledgement.resolve({ ok: true, value: undefined });
      await acknowledgement.promise;
    });
    expect(disabled).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["resolve", "before C send", "view"], ["reject", "before C send", "view"],
    ["resolve", "after C Stop", "view"], ["reject", "after C Stop", "view"],
    ["resolve", "before C send", "delta"], ["reject", "before C send", "delta"],
    ["resolve", "after C Stop", "delta"], ["reject", "after C Stop", "delta"]
  ] as const)("A's %s %s cannot revive Stop after B runs entirely offscreen (%s admission)", async (outcome, timing, admission) => {
    const first = deferred<unknown>();
    const other = deferred<unknown>();
    const third = deferred<unknown>();
    const interrupt = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(third.promise);
    const { emit, commit, select, dispatch } = await mount(interrupt);
    const settleFirst = async () => {
      await act(async () => {
        if (outcome === "resolve") first.resolve({ ok: true, value: undefined });
        else first.reject(new Error("retired A cancellation failed"));
        await first.promise.catch(() => undefined);
      });
    };
    await act(async () => stopButton()!.click());
    await select("b");
    // Keep another producer's Stop visible while A and its successor run
    // offscreen: retiring A must not clear this thread's request or view.
    await act(async () => emit(channels.updated, { thread: thread("b", "turn-other") }));
    await act(async () => stopButton()!.click());
    await act(async () => {
      commit("complete");
      emit(channels.updated, { thread: thread("a", null) });
      if (admission === "view") {
        emit(channels.updated, { thread: thread("a", "turn-next") });
      } else {
        emit(channels.delta, { threadId: "a", turnId: "turn-next", messageId: "turn-next", delta: "offscreen B" });
      }
    });
    const otherStoppingAtBStart = stopButton()?.disabled;
    await act(async () => {
      commit("complete", "turn-next");
      emit(channels.updated, { thread: thread("a", null) });
    });
    const otherStoppingAtBEnd = stopButton()?.disabled;
    await act(async () => {
      emit(channels.interrupted, { threadId: "b", turnId: "turn-other", reason: "user_interrupted" });
      other.resolve({ ok: true, value: undefined });
      await other.promise;
    });
    await select("a");
    const staleStopOnReturn = stopButton() !== null;
    if (timing === "before C send") await settleFirst();
    const textarea = container!.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "third question");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.click());
    const sends = dispatch.mock.calls.filter(([name]) => name.endsWith(":send")).length;
    const thirdReady = stopButton()?.disabled;
    await act(async () => stopButton()?.click());
    if (timing === "after C Stop") await settleFirst();
    const thirdStillStopping = stopButton()?.disabled;
    const errorAfterA = container!.querySelector('[role="alert"]')?.textContent ?? null;
    await act(async () => {
      commit("complete", "turn-third");
      third.resolve({ ok: true, value: undefined });
      await third.promise;
    });
    expect(otherStoppingAtBStart).toBe(true);
    expect(otherStoppingAtBEnd).toBe(true);
    expect(staleStopOnReturn).toBe(false);
    expect(sends).toBe(1);
    expect(thirdReady).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(3);
    expect(thirdStillStopping).toBe(true);
    expect(errorAfterA).toBeNull();
    expect(stopButton()).toBeNull();
  });

  test.each([
    ["resolve", "before B Stop"], ["reject", "before B Stop"],
    ["resolve", "after B Stop"], ["reject", "after B Stop"]
  ] as const)("A's late %s %s cannot own B or its successor", async (outcome, timing) => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const third = deferred<unknown>();
    const interrupt = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { emit, commit, select } = await mount(interrupt);
    await act(async () => stopButton()!.click());
    await act(async () => {
      commit("complete");
      emit(channels.updated, { thread: thread("a", "turn-next") });
    });
    const admittedB = { disabled: stopButton()?.disabled, cancellations: interrupt.mock.calls.length };
    if (timing === "after B Stop") await act(async () => stopButton()!.click());
    await select("b");
    await select("a");
    const navigatedB = stopButton()?.disabled;
    await act(async () => {
      if (outcome === "resolve") first.resolve({ ok: true, value: undefined });
      else first.reject(new Error("retired A cancellation failed"));
      await first.promise.catch(() => undefined);
    });
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(admittedB).toEqual({ disabled: false, cancellations: 1 });
    expect(navigatedB).toBe(timing === "after B Stop");
    expect(stopButton()?.disabled).toBe(timing === "after B Stop");
    if (timing === "before B Stop") await act(async () => stopButton()!.click());
    await act(async () => stopButton()!.click());
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(stopButton()?.disabled).toBe(true);
    await act(async () => commit("complete", "turn-next"));
    expect(stopButton()?.disabled).toBe(true);
    await act(async () => {
      second.resolve({ ok: true, value: undefined });
      await second.promise;
    });
    expect(stopButton()).toBeNull();
    await act(async () => emit(channels.updated, { thread: thread("a", "turn-third") }));
    expect(stopButton()?.disabled).toBe(false);
    await act(async () => stopButton()!.click());
    expect(interrupt).toHaveBeenCalledTimes(3);
    await act(async () => {
      commit("complete", "turn-third");
      third.resolve({ ok: true, value: undefined });
      await third.promise;
    });
    expect(stopButton()).toBeNull();
  });

  test.each(["resolve", "reject"] as const)(
    "B completing without Stop cannot resurrect A's guard before a third turn (%s)",
    async (outcome) => {
      const first = deferred<unknown>();
      const third = deferred<unknown>();
      const interrupt = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(third.promise);
      const { emit, commit, select } = await mount(interrupt);
      await act(async () => stopButton()!.click());
      await act(async () => {
        commit("complete");
        emit(channels.updated, { thread: thread("a", "turn-next") });
      });
      await select("b");
      await select("a");
      await act(async () => commit("complete", "turn-next"));
      const completedBHasStop = stopButton() !== null;
      await act(async () => emit(channels.updated, { thread: thread("a", "turn-third") }));
      const thirdDisabled = stopButton()?.disabled;
      await act(async () => stopButton()!.click());
      await act(async () => {
        if (outcome === "resolve") first.resolve({ ok: true, value: undefined });
        else first.reject(new Error("retired A cancellation failed"));
        await first.promise.catch(() => undefined);
      });
      expect(completedBHasStop).toBe(false);
      expect(thirdDisabled).toBe(false);
      expect(interrupt).toHaveBeenCalledTimes(2);
      expect(stopButton()?.disabled).toBe(true);
      expect(container!.querySelector('[role="alert"]')).toBeNull();
      await act(async () => {
        commit("complete", "turn-third");
        third.resolve({ ok: true, value: undefined });
        await third.promise;
      });
      expect(stopButton()).toBeNull();
    }
  );

  test("an old Stop cannot replace a next-turn approval submission across navigation", async () => {
    const first = deferred<unknown>();
    const next = deferred<unknown>();
    const approval = deferred<unknown>();
    const interrupt = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const { emit, commit, select, dispatch } = await mount(interrupt, () => approval.promise);
    await act(async () => stopButton()!.click());
    const request = { threadId: "a", turnId: "turn-next", approvalId: "approval-next", summary: "Approve B?" };
    await act(async () => {
      commit("complete");
      emit(channels.updated, { thread: thread("a", "turn-next") });
      emit(channels.updated, { thread: {
        ...thread("a", "turn-next"),
        status: { kind: "awaiting_approval", approvalId: request.approvalId },
        pendingApproval: request
      } });
      emit(channels.approvalRequested, request);
    });
    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="ps-approval-approve"]')!.click());
    await select("b");
    await select("a");
    expect(container!.querySelector('[data-testid="ps-approval"]')?.getAttribute("aria-busy")).toBe("true");
    expect(dispatch.mock.calls.filter(([name]) => name.endsWith(":approval"))).toHaveLength(1);
    await act(async () => {
      approval.resolve({ ok: true, value: undefined });
      await approval.promise;
    });
    expect(container!.querySelector('[data-testid="ps-approval"]')?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      emit(channels.approvalResolved, { ...request, decision: "approve" });
      emit(channels.updated, { thread: thread("a", "turn-next") });
    });
    const nextDisabled = stopButton()?.disabled;
    await act(async () => stopButton()!.click());
    await act(async () => {
      first.reject(new Error("retired A cancellation failed"));
      await first.promise.catch(() => undefined);
    });
    expect(container!.querySelector('[data-testid="ps-approval"]')).toBeNull();
    expect(nextDisabled).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(stopButton()?.disabled).toBe(true);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      commit("complete", "turn-next");
      next.resolve({ ok: true, value: undefined });
      await next.promise;
    });
    expect(stopButton()).toBeNull();
  });

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
