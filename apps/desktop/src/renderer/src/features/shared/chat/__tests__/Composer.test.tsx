// Unit coverage for the Composer — the Library chat message input.
//
// Mirrors the codebase test convention (RightActivityBar.test.tsx /
// usePasteImage.test.tsx): plain React `createRoot` + `act`, no
// @testing-library/react (it isn't a dependency — see EditToolbar.test
// for the same note).
//
// Covers:
//   • ⏎ submits, ⇧⏎ inserts a newline (no submit), empty / whitespace
//     input does not submit.
//   • Double ⏎ rapidly → onSubmit called exactly ONCE (onSubmit
//     resolves slowly via a deferred promise; the in-flight guard
//     swallows the second).
//   • ⌘N keydown while the textarea has text → stopPropagation called
//     (does not bubble to window); Escape on an EMPTY textarea is
//     allowed to bubble.
//   • disabled prop disables the send button + textarea.

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
import { Composer, type ComposerProps } from "../Composer";

beforeAll(() => {
  (
    globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true
  });
  // jsdom doesn't implement objectURL; stub so attachment paths don't throw.
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL =
      () => "blob:stub";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
      () => undefined;
  }
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

async function renderComposer(
  props: Partial<ComposerProps> & Pick<ComposerProps, "onSubmit">
): Promise<HTMLDivElement> {
  await act(async () => {
    root?.render(createElement(Composer, props));
    await Promise.resolve();
  });
  if (container === null) throw new Error("no container");
  return container;
}

function getTextarea(el: HTMLElement): HTMLTextAreaElement {
  const ta = el.querySelector<HTMLTextAreaElement>(
    '[data-testid="composer-input"]'
  );
  if (ta === null) throw new Error("textarea not found");
  return ta;
}

function getSend(el: HTMLElement): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(
    '[data-testid="composer-send"]'
  );
  if (btn === null) throw new Error("send button not found");
  return btn;
}

// Set the controlled textarea value via the native setter + an input
// event so React's onChange fires (the React-controlled input idiom).
async function typeInto(ta: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

// Dispatch a keydown on the textarea. Returns the event so callers can
// assert on defaultPrevented etc.
async function pressKey(
  ta: HTMLTextAreaElement,
  init: KeyboardEventInit
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  await act(async () => {
    ta.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Composer", () => {
  test("Enter submits the trimmed text", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "hello world");
    await pressKey(ta, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hello world", []);
  });

  test("Cmd+Enter also submits", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "via cmd-enter");
    await pressKey(ta, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("via cmd-enter", []);
  });

  test("Shift+Enter inserts a newline and does NOT submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "line one");
    const event = await pressKey(ta, { key: "Enter", shiftKey: true });
    // We don't preventDefault on ⇧⏎ — the textarea owns the newline.
    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("empty / whitespace-only input does not submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    // Empty.
    await pressKey(ta, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    // Whitespace-only.
    await typeInto(ta, "   \n  \t ");
    await pressKey(ta, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("double Enter while sending → onSubmit fires exactly once", async () => {
    const d = deferred<void>();
    const onSubmit = vi.fn().mockReturnValue(d.promise);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "only once");
    // First Enter starts the in-flight submit.
    await pressKey(ta, { key: "Enter" });
    // Second Enter while still pending must be a no-op.
    await pressKey(ta, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // The draft must NOT have been cleared while in flight.
    expect(ta.value).toBe("only once");
    // Resolve and let the .finally() run → back to idle, draft cleared.
    await act(async () => {
      d.resolve();
      await d.promise;
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("Cmd+N while textarea has text → stopPropagation (does not bubble)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "drafting");

    const windowSaw = vi.fn();
    window.addEventListener("keydown", windowSaw);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "n",
        metaKey: true,
        bubbles: true
      });
      const stopSpy = vi.spyOn(event, "stopPropagation");
      await act(async () => {
        ta.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(stopSpy).toHaveBeenCalled();
      expect(windowSaw).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowSaw);
    }
  });

  test("Escape on an EMPTY textarea is allowed to bubble to window", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    // No text typed → empty.
    const windowSaw = vi.fn();
    window.addEventListener("keydown", windowSaw);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      });
      const stopSpy = vi.spyOn(event, "stopPropagation");
      await act(async () => {
        ta.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(stopSpy).not.toHaveBeenCalled();
      expect(windowSaw).toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowSaw);
    }
  });

  test("Escape while textarea HAS text → stopPropagation (shadowed)", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "half a draft");
    const windowSaw = vi.fn();
    window.addEventListener("keydown", windowSaw);
    try {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true
      });
      const stopSpy = vi.spyOn(event, "stopPropagation");
      await act(async () => {
        ta.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(stopSpy).toHaveBeenCalled();
      expect(windowSaw).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowSaw);
    }
  });

  test("disabled prop disables the textarea and the send button", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit, disabled: true });
    expect(getTextarea(el).disabled).toBe(true);
    expect(getSend(el).disabled).toBe(true);
  });

  test("send button is disabled when input is empty, enabled once text is typed", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    expect(getSend(el).disabled).toBe(true);
    await typeInto(getTextarea(el), "now enabled");
    expect(getSend(el).disabled).toBe(false);
  });

  test("clicking send submits and clears the draft on resolve", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "click submit");
    await act(async () => {
      getSend(el).click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith("click submit", []);
    expect(ta.value).toBe("");
  });
});
