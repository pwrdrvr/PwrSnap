// Pins the one shared copy-feedback hook: the copy goes through the
// `clipboard:copyText` bus verb and never `navigator.clipboard` on ANY path
// (the stub is installed for every test and checked after each), feedback
// is keyed by button id and resets after COPY_TEXT_FEEDBACK_MS, a repeat
// click re-arms the single timer instead of being cut short by the older
// one, a stale resolution neither overwrites newer feedback nor re-arms its
// timer, unmount clears the timer, and the bus Result comes back to the
// caller untouched.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { err, ok, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { COPY_TEXT_FEEDBACK_MS, useCopyText, type UseCopyTextValue } from "../useCopyText";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type CopyResult = Result<void>;

const OK: CopyResult = ok(undefined);
const CLIPBOARD_UNAVAILABLE: PwrSnapError = {
  kind: "clipboard",
  code: "clipboard_unavailable",
  message: "clipboard unavailable"
};

let host: HTMLDivElement;
let root: Root;
let latest: UseCopyTextValue | null = null;
let dispatch: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

function Harness(): ReactElement {
  const value = useCopyText();
  latest = value;
  return createElement(
    "output",
    null,
    value.feedback === null ? "" : `${value.feedback.id}:${value.feedback.status}`
  );
}

function hook(): UseCopyTextValue {
  if (latest === null) throw new Error("hook not mounted");
  return latest;
}

function installFakeApi(impl: (name: string, req: unknown) => Promise<Result<unknown>>): void {
  dispatch = vi.fn(impl);
  window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

/** A bus fake whose replies the test releases by hand, keyed by copied text. */
function installPendingApi(): (text: string, result: CopyResult) => void {
  const pending = new Map<string, (result: CopyResult) => void>();
  installFakeApi(
    (_name, req) =>
      new Promise<CopyResult>((resolve) => {
        pending.set((req as { text: string }).text, resolve);
      })
  );
  return (text, result) => {
    const resolve = pending.get(text);
    if (resolve === undefined) throw new Error(`no pending copy for ${JSON.stringify(text)}`);
    resolve(result);
  };
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
}

/** What the button would render right now. */
function shown(): string {
  return host.querySelector("output")?.textContent ?? "";
}

function click(id: string, text: string): Promise<CopyResult> {
  return act(() => hook().copy(id, text));
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  latest = null;
  installFakeApi(async () => OK);
  // Present for every test, so a bypass on ANY path (success, failure, a
  // fallback) trips the afterEach check rather than only where one test
  // happens to look.
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  unmount();
  host.remove();
  vi.useRealTimers();
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  expect(writeText).not.toHaveBeenCalled();
});

describe("useCopyText", () => {
  test("copies through clipboard:copyText, flips the clicked id, and resets after the feedback window", async () => {
    mount();
    expect(shown()).toBe("");

    const result = await click("claude", "claude mcp add pwrsnap");

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", { text: "claude mcp add pwrsnap" });
    expect(result).toEqual(OK);
    expect(hook().feedback).toEqual({ id: "claude", status: "copied" });
    expect(shown()).toBe("claude:copied");

    advance(COPY_TEXT_FEEDBACK_MS - 1);
    expect(shown()).toBe("claude:copied");
    advance(1);
    expect(shown()).toBe("");
    expect(hook().feedback).toBeNull();
  });

  test("routes through the bus chokepoint, not navigator.clipboard, whether the bus accepts or refuses", async () => {
    mount();
    await click("a", "text");
    expect(shown()).toBe("a:copied");

    installFakeApi(async () => err(CLIPBOARD_UNAVAILABLE));
    await click("a", "text");
    expect(shown()).toBe("a:failed");

    expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", { text: "text" });
    expect(writeText).not.toHaveBeenCalled();
  });

  test("a failed copy shows failed on the button, still resets, and hands the Result back untouched", async () => {
    installFakeApi(async () => err(CLIPBOARD_UNAVAILABLE));
    mount();

    const result = await click("codex", "codex mcp add pwrsnap");

    expect(result).toEqual(err(CLIPBOARD_UNAVAILABLE));
    expect(shown()).toBe("codex:failed");
    advance(COPY_TEXT_FEEDBACK_MS);
    expect(shown()).toBe("");
  });

  test("reports the preload-unavailable error as failed instead of throwing", async () => {
    delete (window as unknown as { pwrsnapApi?: unknown }).pwrsnapApi;
    mount();

    const result = await click("a", "text");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("preload_unavailable");
    expect(shown()).toBe("a:failed");
  });

  test("a repeat click re-arms the single timer instead of being cut short by the older one", async () => {
    mount();
    await click("a", "one");
    advance(1_000);
    await click("b", "two");
    expect(shown()).toBe("b:copied");

    // The first click's timer would have fired here (t = 1.5 s); it was cleared.
    advance(1_000);
    expect(shown()).toBe("b:copied");
    expect(vi.getTimerCount()).toBe(1);

    advance(500);
    expect(shown()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a repeat click on the same button keeps the feedback identity but still re-arms the timer", async () => {
    mount();
    await click("a", "one");
    const before = hook().feedback;
    advance(1_000);
    await click("a", "one");

    // Same object, so React bails out of the re-render a window full of log
    // lines would otherwise pay for; the deadline still moved to t = 2.5 s.
    expect(hook().feedback).toBe(before);
    advance(1_000);
    expect(shown()).toBe("a:copied");
    advance(500);
    expect(shown()).toBe("");
  });

  test("a copy that resolves after a newer one started neither overwrites the newer feedback nor re-arms its timer", async () => {
    const settle = installPendingApi();
    mount();

    let slow: Promise<CopyResult> | undefined;
    let fast: Promise<CopyResult> | undefined;
    act(() => {
      slow = hook().copy("a", "slow");
      fast = hook().copy("b", "fast");
    });
    expect(shown()).toBe("");

    await act(async () => {
      settle("fast", OK);
      await fast;
    });
    expect(shown()).toBe("b:copied");

    // The stale resolution lands 1 s into b's window. Had it re-armed the
    // timer, b would linger until t = 2.5 s; it must clear at t = 1.5 s.
    advance(1_000);
    await act(async () => {
      settle("slow", OK);
      expect(await slow).toEqual(OK);
    });
    expect(shown()).toBe("b:copied");
    expect(vi.getTimerCount()).toBe(1);

    advance(499);
    expect(shown()).toBe("b:copied");
    advance(1);
    expect(shown()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  test("unmount clears the pending reset timer", async () => {
    mount();
    await click("a", "one");
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a copy that resolves after unmount arms nothing", async () => {
    const settle = installPendingApi();
    mount();

    let copy: Promise<CopyResult> | undefined;
    act(() => {
      copy = hook().copy("a", "late");
    });
    unmount();

    await act(async () => {
      settle("late", OK);
      expect(await copy).toEqual(OK);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
