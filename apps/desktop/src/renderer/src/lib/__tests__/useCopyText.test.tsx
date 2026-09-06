// Pins the one shared copy-feedback hook: the copy goes through the
// `clipboard:copyText` bus verb (never navigator.clipboard), feedback is
// keyed by button id and resets after COPY_TEXT_FEEDBACK_MS, a repeat click
// re-arms the single timer instead of being cut short by the older one, a
// stale resolution never overwrites newer feedback, unmount clears the
// timer, and the bus Result comes back to the caller untouched.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { COPY_TEXT_FEEDBACK_MS, useCopyText, type UseCopyTextValue } from "../useCopyText";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type AnyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: string; code: string; message: string } };

const OK: AnyResult = { ok: true, value: undefined };

let host: HTMLDivElement;
let root: Root;
let mountedRoot = false;
let latest: UseCopyTextValue | null = null;
let dispatch: ReturnType<typeof vi.fn>;

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

function installFakeApi(impl: (name: string, req: unknown) => Promise<AnyResult>): void {
  dispatch = vi.fn(impl);
  window.pwrsnapApi = {
    dispatch,
    on: () => () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
}

function mount(): void {
  act(() => {
    root.render(createElement(Harness));
  });
  mountedRoot = true;
}

function unmount(): void {
  if (!mountedRoot) return;
  mountedRoot = false;
  act(() => {
    root.unmount();
  });
}

/** What the button would render right now. */
function shown(): string {
  return host.querySelector("output")?.textContent ?? "";
}

async function click(id: string, text: string): Promise<AnyResult> {
  let result: AnyResult | undefined;
  await act(async () => {
    result = (await hook().copy(id, text)) as AnyResult;
  });
  if (result === undefined) throw new Error("copy did not resolve");
  return result;
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
});

afterEach(() => {
  unmount();
  host.remove();
  vi.useRealTimers();
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

  test("never touches navigator.clipboard — the renderer is sandboxed and the bus is the chokepoint", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    try {
      mount();
      await click("a", "text");
      expect(writeText).not.toHaveBeenCalled();
      expect(dispatch).toHaveBeenCalledWith("clipboard:copyText", { text: "text" });
    } finally {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  test("a failed copy shows failed on the button, still resets, and hands the Result back untouched", async () => {
    const error = { kind: "unknown", code: "clipboard_unavailable", message: "clipboard unavailable" };
    installFakeApi(async () => ({ ok: false, error }));
    mount();

    const result = await click("codex", "codex mcp add pwrsnap");

    expect(result).toEqual({ ok: false, error });
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

  test("a copy that resolves after a newer one started does not overwrite the newer feedback", async () => {
    const pending = new Map<string, (result: AnyResult) => void>();
    installFakeApi(
      (_name, req) =>
        new Promise<AnyResult>((resolve) => {
          pending.set((req as { text: string }).text, resolve);
        })
    );
    mount();

    let slow: Promise<AnyResult> | undefined;
    let fast: Promise<AnyResult> | undefined;
    act(() => {
      slow = hook().copy("a", "slow") as Promise<AnyResult>;
      fast = hook().copy("b", "fast") as Promise<AnyResult>;
    });
    expect(shown()).toBe("");

    await act(async () => {
      pending.get("fast")?.(OK);
      await fast;
    });
    expect(shown()).toBe("b:copied");

    await act(async () => {
      pending.get("slow")?.(OK);
      expect(await slow).toEqual(OK);
    });
    expect(shown()).toBe("b:copied");
    expect(vi.getTimerCount()).toBe(1);
  });

  test("unmount clears the pending reset timer", async () => {
    mount();
    await click("a", "one");
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a copy that resolves after unmount arms nothing", async () => {
    let resolve: ((result: AnyResult) => void) | undefined;
    installFakeApi(
      () =>
        new Promise<AnyResult>((r) => {
          resolve = r;
        })
    );
    mount();

    let copy: Promise<AnyResult> | undefined;
    act(() => {
      copy = hook().copy("a", "late") as Promise<AnyResult>;
    });
    unmount();

    await act(async () => {
      resolve?.(OK);
      expect(await copy).toEqual(OK);
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
