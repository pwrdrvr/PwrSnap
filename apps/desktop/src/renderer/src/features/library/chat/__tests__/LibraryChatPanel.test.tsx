// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { LibraryChatThreadView } from "@pwrsnap/shared";
import { LibraryChatPanel } from "../LibraryChatPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function makeThread(threadId: string, name: string): LibraryChatThreadView {
  return {
    threadId,
    name,
    createdAt: "",
    modifiedAt: "",
    anchorCaptureId: "cap-1",
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status: { kind: "idle" }
  };
}

function installApi(seedThreads: LibraryChatThreadView[] = []): ReturnType<typeof vi.fn> {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string, req?: { threadId?: string }) => {
    if (name === "codex:libraryChat:list") return { ok: true, value: { threads: seedThreads } };
    if (name === "codex:libraryChat:history") return { ok: true, value: { messages: [] } };
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
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on,
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return dispatch;
}

async function renderPanel(seedThreads: LibraryChatThreadView[] = []): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const dispatch = installApi(seedThreads);
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
  return { el: container, dispatch };
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("LibraryChatPanel", () => {
  test("archives a thread when its close chip is clicked", async () => {
    const first = makeThread("t1", "Old chat");
    const second = makeThread("t2", "Keep chat");
    const { el, dispatch } = await renderPanel([first, second]);

    const close = el.querySelector<HTMLButtonElement>(".ps-libchat-thread-close")!;
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
});
