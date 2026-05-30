// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { SizzleChatPanel } from "../SizzleChatPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function makeThread(threadId: string, name: string): unknown {
  return {
    threadId,
    name,
    createdAt: "",
    modifiedAt: "",
    anchorCaptureId: "sz_1",
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status: { kind: "idle" }
  };
}

function installApi(seedThreads: unknown[] = []): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
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
          status: { kind: "idle" }
        }
      };
    }
    if (name === "codex:sizzleChat:send") return { ok: true, value: { turnId: "turn1" } };
    if (name === "codex:sizzleChat:history") return { ok: true, value: { messages: [] } };
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
  return { dispatch, emit };
}

async function renderPanel(seedThreads: unknown[] = []): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
}> {
  const { dispatch, emit } = installApi(seedThreads);
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
  return { el: container, dispatch, emit };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
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
          status: { kind: "idle" }
        }
      });
    });
    expect(el.textContent).toContain("My reel chat");
  });
});
