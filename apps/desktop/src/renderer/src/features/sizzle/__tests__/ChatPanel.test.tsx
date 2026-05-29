// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { ChatPanel } from "../ChatPanel";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom doesn't implement scrollIntoView; ChatPanel calls it on each
  // transcript update.
  Element.prototype.scrollIntoView = vi.fn();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

type Handler = (payload: unknown) => void;

function installApi(): {
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  const dispatch = vi.fn(async (name: string) => {
    if (name === "codex:newSession") return { ok: true, value: { sessionId: "s1", threadId: "t1" } };
    if (name === "codex:sendTurn") return { ok: true, value: { turnId: "turn1" } };
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

async function renderPanel(): Promise<{
  el: HTMLDivElement;
  dispatch: ReturnType<typeof vi.fn>;
  emit: (channel: string, payload: unknown) => void;
}> {
  const { dispatch, emit } = installApi();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ChatPanel, { projectId: "sz_1" }));
  });
  // Let the mount-time newSession dispatch resolve.
  await act(async () => {
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

describe("ChatPanel", () => {
  test("opens a session on mount", async () => {
    const { dispatch } = await renderPanel();
    expect(dispatch).toHaveBeenCalledWith("codex:newSession", { projectId: "sz_1" });
  });

  test("accumulates streamed deltas into one agent bubble", async () => {
    const { el, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.codexStreamDelta, {
        sessionId: "s1",
        turnId: "turn1",
        itemId: "m1",
        delta: "Hel"
      });
      emit(EVENT_CHANNELS.codexStreamDelta, {
        sessionId: "s1",
        turnId: "turn1",
        itemId: "m1",
        delta: "lo"
      });
    });
    const bubble = el.querySelector(".szl__chat-bubble--agent .szl__chat-bubble-text");
    expect(bubble?.textContent).toContain("Hello");
  });

  test("renders a tool-call card from the tool-call channel", async () => {
    const { el, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.codexToolCall, {
        sessionId: "s1",
        turnId: "turn1",
        toolCall: {
          callId: "c1",
          tool: "library_search",
          argumentsJson: "{}",
          ok: true,
          summary: "Found 3 captures"
        }
      });
    });
    const tool = el.querySelector(".szl__chat-tool");
    expect(tool?.textContent).toContain("library_search");
    expect(tool?.textContent).toContain("Found 3 captures");
  });

  test("approval card renders the offered decisions and Approve dispatches submitApproval", async () => {
    const { el, dispatch, emit } = await renderPanel();
    await act(async () => {
      emit(EVENT_CHANNELS.codexApprovalRequest, {
        sessionId: "s1",
        turnId: "turn1",
        requestId: "req1",
        request: {
          requestId: "req1",
          kind: "command",
          reason: "needs network",
          command: "curl https://example.com",
          cwd: "/tmp",
          availableDecisions: ["approve", "approveForSession", "decline", "cancel"]
        }
      });
    });
    const card = el.querySelector(".szl__chat-approval");
    expect(card).not.toBeNull();
    const buttons = Array.from(card!.querySelectorAll<HTMLButtonElement>(".szl__chat-approval-btn"));
    expect(buttons).toHaveLength(4);
    const approve = buttons.find((b) => b.textContent === "Approve")!;
    await act(async () => {
      approve.click();
    });
    expect(dispatch).toHaveBeenCalledWith("codex:submitApproval", {
      sessionId: "s1",
      turnId: "turn1",
      requestId: "req1",
      decision: "approve"
    });
  });
});
