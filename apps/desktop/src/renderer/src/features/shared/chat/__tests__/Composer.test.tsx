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
    root?.render(
      createElement(Composer, {
        shortcutPlatform: "darwin",
        ...props
      })
    );
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

function getStop(el: HTMLElement): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(
    '[data-testid="composer-stop"]'
  );
  if (btn === null) throw new Error("stop button not found");
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
  test("defaults to provider-neutral AI copy", async () => {
    const el = await renderComposer({ onSubmit: vi.fn().mockResolvedValue(undefined) });
    expect(getTextarea(el).placeholder).toBe("Message AI…");
  });

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

  test("shows an accessible Stop only during an active turn and blocks Enter sends", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit, onStop, turnState: "active" });
    const ta = getTextarea(el);
    await typeInto(ta, "next-message draft");

    expect(el.querySelector('[data-testid="composer-send"]')).toBeNull();
    expect(getStop(el).getAttribute("aria-label")).toBe("Stop response");
    expect(ta.disabled).toBe(false);

    await pressKey(ta, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ta.value).toBe("next-message draft");
  });

  test("double-clicking Stop invokes the cancellation callback once", async () => {
    const stop = deferred<void>();
    const onStop = vi.fn().mockReturnValue(stop.promise);
    const el = await renderComposer({
      onSubmit: vi.fn().mockResolvedValue(undefined),
      onStop,
      turnState: "active"
    });

    await act(async () => {
      getStop(el).click();
      getStop(el).click();
      await Promise.resolve();
    });
    expect(onStop).toHaveBeenCalledTimes(1);

    await act(async () => {
      stop.resolve();
      await stop.promise;
    });
  });

  test("stopping disables Stop and lifecycle changes preserve a typed draft", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onStop = vi.fn().mockResolvedValue(undefined);
    const el = await renderComposer({ onSubmit, onStop, turnState: "active" });
    const ta = getTextarea(el);
    await typeInto(ta, "keep this draft");

    await act(async () => {
      root?.render(createElement(Composer, { onSubmit, onStop, turnState: "stopping" }));
      await Promise.resolve();
    });
    expect(getStop(el).disabled).toBe(true);
    expect(getTextarea(el).value).toBe("keep this draft");

    await act(async () => {
      root?.render(createElement(Composer, { onSubmit, onStop, turnState: "idle" }));
      await Promise.resolve();
    });
    expect(el.querySelector('[data-testid="composer-stop"]')).toBeNull();
    expect(getSend(el)).not.toBeNull();
    expect(getTextarea(el).value).toBe("keep this draft");
  });

  test("a rejected send keeps the draft for retry", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("offline"));
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "retry me");

    await pressKey(ta, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ta.value).toBe("retry me");
    expect(getSend(el).disabled).toBe(false);
  });

  test("a synchronous submit throw releases the latch and keeps the draft", async () => {
    const onSubmit = vi.fn(() => {
      throw new Error("offline");
    }) as unknown as ComposerProps["onSubmit"];
    const el = await renderComposer({ onSubmit });
    const ta = getTextarea(el);
    await typeInto(ta, "retry sync failure");

    await pressKey(ta, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ta.value).toBe("retry sync failure");
    expect(getSend(el).disabled).toBe(false);
  });

  test("hydrates an opt-in external draft and reports edits without clearing on rejection", async () => {
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn().mockRejectedValue(new Error("offline"));
    const el = await renderComposer({
      onSubmit,
      initialText: "restored draft",
      onDraftChange
    });
    const ta = getTextarea(el);
    expect(ta.value).toBe("restored draft");

    await typeInto(ta, "updated draft");
    expect(onDraftChange).toHaveBeenLastCalledWith("updated draft");
    await pressKey(ta, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ta.value).toBe("updated draft");
    expect(onDraftChange).not.toHaveBeenCalledWith("");
  });

  test("reports an empty external draft after a successful submit", async () => {
    const onDraftChange = vi.fn();
    const el = await renderComposer({
      onSubmit: vi.fn().mockResolvedValue(undefined),
      initialText: "send me",
      onDraftChange
    });
    await pressKey(getTextarea(el), { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  test("does not clear a newer draft typed while the submitted message settles", async () => {
    const sending = deferred<void>();
    const onDraftChange = vi.fn();
    const el = await renderComposer({
      onSubmit: vi.fn().mockReturnValue(sending.promise),
      onDraftChange
    });
    const textarea = getTextarea(el);
    await typeInto(textarea, "first message");
    await pressKey(textarea, { key: "Enter" });
    await typeInto(textarea, "next message");

    await act(async () => {
      sending.resolve();
      await sending.promise;
      await Promise.resolve();
    });

    expect(textarea.value).toBe("next message");
    expect(onDraftChange).toHaveBeenLastCalledWith("next message");
  });

  test("does not clear a newer external draft written after the submitting composer unmounts", async () => {
    const sending = deferred<void>();
    let nextRevision = 2;
    let storedDraft: { text: string; revision: number } | null = {
      text: "first message",
      revision: 1
    };
    const onDraftChange = vi.fn((text: string): number => {
      const revision = nextRevision++;
      storedDraft = text === "" ? null : { text, revision };
      return revision;
    });
    const onDraftClear = vi.fn((revision: number): void => {
      if (storedDraft?.revision === revision) storedDraft = null;
    });

    const el = await renderComposer({
      onSubmit: vi.fn().mockReturnValue(sending.promise),
      initialText: "first message",
      initialDraftRevision: 1,
      onDraftChange,
      onDraftClear
    });
    await pressKey(getTextarea(el), { key: "Enter" });

    await act(async () => {
      root?.render(
        createElement(Composer, {
          key: "remounted",
          onSubmit: vi.fn().mockResolvedValue(undefined),
          initialText: "first message",
          initialDraftRevision: 1,
          onDraftChange,
          onDraftClear
        })
      );
      await Promise.resolve();
    });
    await typeInto(getTextarea(el), "newer remounted draft");

    await act(async () => {
      sending.resolve();
      await sending.promise;
      await Promise.resolve();
    });

    expect(storedDraft).toEqual({ text: "newer remounted draft", revision: 2 });
    expect(onDraftClear).toHaveBeenCalledWith(1);
    expect(getTextarea(el).value).toBe("newer remounted draft");
  });
});
