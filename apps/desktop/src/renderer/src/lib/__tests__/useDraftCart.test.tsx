// Tests for the useDraftCart hook — fetch-once-then-subscribe against
// the `cart:get` command + `events:cart:changed` broadcast. Uses the
// same manual createRoot + act harness as the other renderer tests
// (no @testing-library in this workspace) plus a tiny probe component
// that surfaces the hook's return into the DOM for assertions.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftCart } from "@pwrsnap/shared";
import { useDraftCart } from "../useDraftCart";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Captured subscribe handlers keyed by channel, so a test can fire a
// broadcast by invoking the registered callback directly.
let subscribers: Map<string, (payload: unknown) => void>;

function makeCart(overrides: Partial<DraftCart> = {}): DraftCart {
  return {
    name: "Untitled draft",
    captureIds: [],
    createdAt: "2026-05-28T00:00:00.000Z",
    modifiedAt: "2026-05-28T00:00:00.000Z",
    ...overrides
  };
}

function installFakeApi(getResult: unknown): { dispatch: ReturnType<typeof vi.fn> } {
  subscribers = new Map();
  const dispatch = vi.fn(async (name: string) => {
    if (name === "cart:get") return getResult;
    return { ok: true, value: undefined };
  });
  (globalThis as unknown as { window: Window }).window.pwrsnapApi = {
    dispatch,
    on: (channel: string, handler: (payload: unknown) => void) => {
      subscribers.set(channel, handler);
      return () => subscribers.delete(channel);
    },
    startCaptureDrag: () => undefined
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
  return { dispatch };
}

// Probe component: renders the cart name + id list into the DOM so
// tests can read the hook's current value from textContent.
function CartProbe(): ReactElement {
  const { cart, loading } = useDraftCart();
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "loading" }, String(loading)),
    createElement("span", { "data-testid": "name" }, cart.name),
    createElement("span", { "data-testid": "ids" }, cart.captureIds.join(","))
  );
}

async function renderProbe(getResult: unknown): Promise<{
  read: (testid: string) => string;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const { dispatch } = installFakeApi(getResult);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CartProbe));
  });
  await act(async () => {
    await Promise.resolve();
  });
  const read = (testid: string): string =>
    container?.querySelector(`[data-testid="${testid}"]`)?.textContent ?? "";
  return { read, dispatch };
}

beforeEach(() => {
  subscribers = new Map();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("useDraftCart", () => {
  test("fetches the cart once on mount via cart:get", async () => {
    const { read, dispatch } = await renderProbe({
      ok: true,
      value: makeCart({ name: "Loaded", captureIds: ["a", "b"] })
    });
    expect(dispatch).toHaveBeenCalledWith("cart:get", {});
    expect(read("name")).toBe("Loaded");
    expect(read("ids")).toBe("a,b");
    expect(read("loading")).toBe("false");
  });

  test("updates live when events:cart:changed fires", async () => {
    const { read } = await renderProbe({
      ok: true,
      value: makeCart({ captureIds: ["a"] })
    });
    expect(read("ids")).toBe("a");

    // Fire a broadcast through the captured subscriber.
    const handler = subscribers.get("events:cart:changed");
    expect(handler).toBeDefined();
    await act(async () => {
      handler!({ cart: makeCart({ name: "After", captureIds: ["a", "b", "c"] }) });
    });
    expect(read("name")).toBe("After");
    expect(read("ids")).toBe("a,b,c");
  });

  test("ignores malformed broadcast payloads (defensive guard)", async () => {
    const { read } = await renderProbe({
      ok: true,
      value: makeCart({ captureIds: ["a"] })
    });
    const handler = subscribers.get("events:cart:changed")!;
    await act(async () => {
      handler({ notACart: true });
      handler(null);
      handler({ cart: { captureIds: "not an array" } });
    });
    // State unchanged — the guard rejected every malformed payload.
    expect(read("ids")).toBe("a");
  });

  test("tolerates a cart:get stub that returns undefined (test-stub safety)", async () => {
    // Renderer tests that don't mock cart:get would have dispatch
    // resolve to `{ ok: true, value: undefined }`. The hook's shape
    // guard must keep the default empty cart rather than crash.
    const { read } = await renderProbe({ ok: true, value: undefined });
    expect(read("loading")).toBe("false");
    expect(read("ids")).toBe("");
    expect(read("name")).toBe("Untitled draft");
  });

  test("unsubscribes on unmount (no leaked subscriber)", async () => {
    await renderProbe({ ok: true, value: makeCart() });
    expect(subscribers.has("events:cart:changed")).toBe(true);
    await act(async () => {
      root?.unmount();
    });
    expect(subscribers.has("events:cart:changed")).toBe(false);
  });
});
