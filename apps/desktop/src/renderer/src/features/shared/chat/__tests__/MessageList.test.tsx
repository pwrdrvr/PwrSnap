// Unit coverage for the MessageList streaming primitive. Follows the
// project's renderer-test pattern (react-dom/client + act; no
// @testing-library in this repo — see RightActivityBar.test.tsx).
//
// Covers:
//   • text / tool_call / tool_result rendering; tool_result folds into
//     its tool_call card by callId, never rendered standalone.
//   • XSS safety: `<img src=x onerror=alert(1)>` text renders as LITERAL
//     characters, no injected DOM element.
//   • streaming: N delta callbacks coalesce to a single rAF flush; the
//     static list does not re-mount (a prior message's testid persists)
//     and the streamed text appears.
//   • scrolled-up state suppresses auto-scroll → the "Jump to latest"
//     affordance appears.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import type { ChatMessage } from "@pwrsnap/shared";
import { MessageList, type MessageListProps } from "../MessageList";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Controllable requestAnimationFrame: each rAF callback is queued and only
// runs when we call flushRaf(). Lets us assert coalescing deterministically.
let rafQueue: FrameRequestCallback[] = [];
let rafId = 0;

beforeEach(() => {
  rafQueue = [];
  rafId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    rafId += 1;
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (): void => {
    // We don't dequeue by id in this stub; the component guards late
    // flushes via its canceled ref, so a no-op cancel is faithful enough.
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function flushRaf(): void {
  const queued = rafQueue;
  rafQueue = [];
  for (const cb of queued) {
    cb(performance.now());
  }
}

async function render(props: MessageListProps): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(MessageList, props) as ReactElement);
    await Promise.resolve();
  });
  return container;
}

async function rerender(props: MessageListProps): Promise<void> {
  await act(async () => {
    root?.render(createElement(MessageList, props) as ReactElement);
    await Promise.resolve();
  });
}

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id">): ChatMessage {
  return {
    id: partial.id,
    role: partial.role ?? "assistant",
    content: partial.content ?? [],
    status: partial.status ?? "complete",
    createdAt: partial.createdAt ?? "2026-05-28T00:00:00.000Z",
    ...(partial.aiRunId !== undefined ? { aiRunId: partial.aiRunId } : {})
  };
}

describe("MessageList — content rendering", () => {
  test("renders a text block as a prose paragraph", async () => {
    const el = await render({
      messages: [
        msg({ id: "m1", content: [{ kind: "text", text: "hello world" }] })
      ]
    });
    const text = el.querySelector('[data-testid="message-list-text"]');
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe("hello world");
  });

  test("renders a tool_call as a collapsible card; args expand pretty-printed", async () => {
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [
            {
              kind: "tool_call",
              toolName: "library_list",
              argsJson: '{"limit":5,"q":"cats"}',
              callId: "call-1"
            }
          ]
        })
      ]
    });
    const card = el.querySelector('[data-testid="message-list-tool-call-1"]');
    expect(card).not.toBeNull();
    // Tool name surfaced.
    expect(card?.textContent).toContain("library_list");
    // Collapsed by default → no args pre yet.
    expect(
      el.querySelector('[data-testid="message-list-tool-args-call-1"]')
    ).toBeNull();
    // Expand.
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-testid="message-list-tool-toggle-call-1"]'
    );
    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    const pre = el.querySelector('[data-testid="message-list-tool-args-call-1"]');
    expect(pre).not.toBeNull();
    // Pretty-printed (JSON.parse → stringify with 2-space indent).
    expect(pre?.textContent).toBe('{\n  "limit": 5,\n  "q": "cats"\n}');
  });

  test("in-progress tool_call (no result) shows a spinner state", async () => {
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [
            {
              kind: "tool_call",
              toolName: "library_list",
              argsJson: "{}",
              callId: "call-1"
            }
          ]
        })
      ]
    });
    const card = el.querySelector('[data-testid="message-list-tool-call-1"]');
    expect(card?.getAttribute("data-state")).toBe("in_progress");
    expect(
      el.querySelector('[data-testid="message-list-tool-spinner"]')
    ).not.toBeNull();
  });

  test("tool_result folds into its tool_call card by callId (not standalone)", async () => {
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [
            {
              kind: "tool_call",
              toolName: "library_list",
              argsJson: "{}",
              callId: "call-1"
            }
          ]
        }),
        msg({
          id: "m2",
          content: [
            {
              kind: "tool_result",
              callId: "call-1",
              resultJson: '{"count":3}',
              isError: false
            }
          ]
        })
      ]
    });
    // Exactly one tool card in the whole list (the result did NOT render
    // its own standalone card).
    const cards = el.querySelectorAll('[data-testid^="message-list-tool-call"]');
    expect(cards.length).toBe(1);
    const card = el.querySelector('[data-testid="message-list-tool-call-1"]');
    expect(card?.getAttribute("data-state")).toBe("success");
    // Expand → result folded in.
    const toggle = el.querySelector<HTMLButtonElement>(
      '[data-testid="message-list-tool-toggle-call-1"]'
    );
    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    const resultPre = el.querySelector(
      '[data-testid="message-list-tool-result-call-1"]'
    );
    expect(resultPre).not.toBeNull();
    expect(resultPre?.textContent).toContain('"count": 3');
  });

  test("errored tool_result drives the error state", async () => {
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [
            {
              kind: "tool_call",
              toolName: "library_delete",
              argsJson: "{}",
              callId: "call-9"
            }
          ]
        }),
        msg({
          id: "m2",
          content: [
            {
              kind: "tool_result",
              callId: "call-9",
              resultJson: '{"message":"nope"}',
              isError: true
            }
          ]
        })
      ]
    });
    const card = el.querySelector('[data-testid="message-list-tool-call-9"]');
    expect(card?.getAttribute("data-state")).toBe("error");
    expect(card?.className).toContain("ml__tool--error");
  });
});

describe("MessageList — XSS safety", () => {
  test("HTML in text content renders as literal characters, not DOM", async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const el = await render({
      messages: [msg({ id: "m1", content: [{ kind: "text", text: payload }] })]
    });
    // No actual <img> element was injected.
    expect(el.querySelector("img")).toBeNull();
    const text = el.querySelector('[data-testid="message-list-text"]');
    // The raw markup shows up as literal text.
    expect(text?.textContent).toBe(payload);
    // And there is no element with the onerror attribute anywhere.
    expect(el.querySelector("[onerror]")).toBeNull();
  });
});

describe("MessageList — streaming", () => {
  test("coalesces N deltas into one rAF flush; static list does not re-mount", async () => {
    let emit: (full: string) => void = () => undefined;
    const unsubscribe = vi.fn();
    const subscribeToStream = vi.fn(
      (_id: string, onDelta: (full: string) => void) => {
        emit = onDelta;
        return unsubscribe;
      }
    );

    const messages: ChatMessage[] = [
      msg({ id: "prior", content: [{ kind: "text", text: "earlier" }] }),
      msg({ id: "live", role: "assistant", content: [], status: "streaming" })
    ];

    const el = await render({
      messages,
      streamingMessageId: "live",
      subscribeToStream
    });

    // The prior (static) message rendered.
    const priorNode = el.querySelector('[data-testid="message-list-msg-prior"]');
    expect(priorNode).not.toBeNull();
    expect(subscribeToStream).toHaveBeenCalledWith("live", expect.any(Function));

    // Fire a burst of deltas BEFORE any frame flushes.
    await act(async () => {
      emit("a");
      emit("ab");
      emit("abc");
      emit("abcd");
      await Promise.resolve();
    });
    // Coalesced: only ONE rAF was scheduled for the whole burst.
    expect(rafQueue.length).toBe(1);

    // Flush the frame.
    await act(async () => {
      flushRaf();
      await Promise.resolve();
    });

    const streaming = el.querySelector('[data-testid="message-list-streaming"]');
    expect(streaming).not.toBeNull();
    // Latest buffered text won (full-text semantics, not appended chunks).
    expect(streaming?.textContent).toContain("abcd");

    // The static prior message is the SAME DOM node (never re-mounted by
    // the streaming deltas) — identity is preserved.
    expect(el.querySelector('[data-testid="message-list-msg-prior"]')).toBe(
      priorNode
    );
  });

  test("unsubscribes on unmount", async () => {
    const unsubscribe = vi.fn();
    const subscribeToStream = vi.fn(() => unsubscribe);
    await render({
      messages: [msg({ id: "live", content: [], status: "streaming" })],
      streamingMessageId: "live",
      subscribeToStream
    });
    await act(async () => {
      root?.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    // Mark torn down so afterEach's unmount is a no-op.
    root = null;
  });
});

describe("MessageList — message status", () => {
  test("failed message shows Failed + Retry, wires onRetry", async () => {
    const onRetry = vi.fn();
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [{ kind: "text", text: "oops" }],
          status: "failed"
        })
      ],
      onRetry
    });
    expect(el.textContent).toContain("Failed");
    const retry = el.querySelector<HTMLButtonElement>(
      '[data-testid="message-list-retry-m1"]'
    );
    expect(retry).not.toBeNull();
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(onRetry).toHaveBeenCalledWith("m1");
  });

  test("interrupted message shows the Interrupted affordance", async () => {
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [{ kind: "text", text: "partial" }],
          status: "interrupted"
        })
      ]
    });
    expect(
      el.querySelector('[data-testid="message-list-interrupted-m1"]')
    ).not.toBeNull();
  });

  test("assistant message with aiRunId shows Reject run, wires onRejectAiRun", async () => {
    const onRejectAiRun = vi.fn();
    const el = await render({
      messages: [
        msg({
          id: "m1",
          content: [{ kind: "text", text: "did a thing" }],
          aiRunId: "run-7"
        })
      ],
      onRejectAiRun
    });
    const reject = el.querySelector<HTMLButtonElement>(
      '[data-testid="message-list-reject-run-run-7"]'
    );
    expect(reject).not.toBeNull();
    await act(async () => {
      reject?.click();
      await Promise.resolve();
    });
    expect(onRejectAiRun).toHaveBeenCalledWith("run-7");
  });
});

describe("MessageList — sticky-bottom-only-if-at-bottom", () => {
  test("when scrolled up, new content does NOT yank; Jump-to-latest appears", async () => {
    const el = await render({
      messages: [msg({ id: "m1", content: [{ kind: "text", text: "first" }] })]
    });
    const scroll = el.querySelector<HTMLDivElement>(
      '[data-testid="message-list-scroll"]'
    );
    expect(scroll).not.toBeNull();

    // jsdom doesn't lay out, so force a scrollable geometry + a
    // scrolled-up position (far from the bottom).
    Object.defineProperty(scroll!, "scrollHeight", {
      value: 2000,
      configurable: true
    });
    Object.defineProperty(scroll!, "clientHeight", {
      value: 400,
      configurable: true
    });
    scroll!.scrollTop = 100; // distance to bottom = 2000 - 100 - 400 = 1500 > 64

    await act(async () => {
      scroll!.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    // Jump-to-latest pill is now visible.
    const jump = el.querySelector('[data-testid="message-list-jump"]');
    expect(jump).not.toBeNull();

    // Add a new message; the scroll position must NOT be yanked to bottom.
    await rerender({
      messages: [
        msg({ id: "m1", content: [{ kind: "text", text: "first" }] }),
        msg({ id: "m2", content: [{ kind: "text", text: "second" }] })
      ]
    });
    expect(scroll!.scrollTop).toBe(100);

    // Clicking the pill jumps to bottom and hides the pill.
    await act(async () => {
      (jump as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(scroll!.scrollTop).toBe(scroll!.scrollHeight);
    expect(el.querySelector('[data-testid="message-list-jump"]')).toBeNull();
  });

  test("at bottom, new content auto-scrolls and no Jump pill shows", async () => {
    const el = await render({
      messages: [msg({ id: "m1", content: [{ kind: "text", text: "first" }] })]
    });
    const scroll = el.querySelector<HTMLDivElement>(
      '[data-testid="message-list-scroll"]'
    );
    Object.defineProperty(scroll!, "scrollHeight", {
      value: 1000,
      configurable: true
    });
    Object.defineProperty(scroll!, "clientHeight", {
      value: 400,
      configurable: true
    });
    // At bottom: distance = 1000 - 600 - 400 = 0.
    scroll!.scrollTop = 600;
    await act(async () => {
      scroll!.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    // No pill while pinned.
    expect(el.querySelector('[data-testid="message-list-jump"]')).toBeNull();

    // New message → layout effect auto-scrolls to bottom.
    await rerender({
      messages: [
        msg({ id: "m1", content: [{ kind: "text", text: "first" }] }),
        msg({ id: "m2", content: [{ kind: "text", text: "second" }] })
      ]
    });
    expect(scroll!.scrollTop).toBe(scroll!.scrollHeight);
  });
});
