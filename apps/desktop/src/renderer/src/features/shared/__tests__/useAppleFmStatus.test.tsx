// @vitest-environment jsdom

// The Library and the Float-Over follow main's status for the on-device
// Apple model. The rules: a change made anywhere reaches a window that has
// the model selected WITHOUT that window issuing a read (so nothing here can
// become a probe), a window that has not selected it does nothing at all,
// and an older answer never replaces a newer one.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { EVENT_CHANNELS, type AppleFmState, type AppleFmStatus } from "@pwrsnap/shared";
import { useAppleFmStatusWhenSelected } from "../useAppleFmStatus";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function status(state: AppleFmState, checkedAt: number): AppleFmStatus {
  return { state, modelLabel: null, detail: null, macosVersion: "27.2", checkedAt };
}

type Pending = { resolve: (value: unknown) => void };
let dispatched: string[] = [];
let pendingReads: Pending[] = [];
let listeners: Map<string, Set<(payload: unknown) => void>>;

beforeEach(() => {
  dispatched = [];
  pendingReads = [];
  listeners = new Map();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: (name: string) => {
        dispatched.push(name);
        return new Promise((resolve) => {
          pendingReads.push({ resolve });
        });
      },
      on: (channel: string, handler: (payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(handler);
        listeners.set(channel, set);
        return () => {
          set.delete(handler);
        };
      }
    }
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: AppleFmStatus | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "pwrsnapApi");
});

function Probe({ provider }: { provider: string | undefined }): null {
  seen = useAppleFmStatusWhenSelected(provider);
  return null;
}

async function mount(provider: string | undefined): Promise<void> {
  seen = undefined;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Probe, { provider }));
  });
}

async function rerender(provider: string | undefined): Promise<void> {
  await act(async () => {
    root?.render(createElement(Probe, { provider }));
  });
}

/** Main announces a change, exactly as the preload delivers it. */
async function broadcast(payload: unknown): Promise<void> {
  await act(async () => {
    for (const handler of [...(listeners.get(EVENT_CHANNELS.appleFmStatusChanged) ?? [])]) {
      handler(payload);
    }
  });
}

async function answerRead(index: number, value: AppleFmStatus | { error: string }): Promise<void> {
  await act(async () => {
    pendingReads[index]?.resolve(
      "error" in value
        ? { ok: false, error: { kind: "unknown", code: "x", message: value.error } }
        : { ok: true, value }
    );
  });
}

const subscriberCount = (): number => listeners.get(EVENT_CHANNELS.appleFmStatusChanged)?.size ?? 0;

describe("while the on-device model is selected", () => {
  test("a status change in main reaches the hook without the window issuing a read", async () => {
    await mount("apple:system");
    await answerRead(0, status("license-required", 10));
    expect(seen?.state).toBe("license-required");
    expect(dispatched).toEqual(["appleFm:status"]);

    // The user agreed to the terms and pressed "Check again" in Settings.
    await broadcast({ status: status("ready", 20) });
    expect(seen?.state).toBe("ready");
    // Followed from the broadcast alone: no second read, so no probe.
    expect(dispatched).toEqual(["appleFm:status"]);
  });

  test("subscribes before it asks, so a change during the first read is not lost", async () => {
    await mount("apple:system");
    expect(subscriberCount()).toBe(1);
    await broadcast({ status: status("ready", 20) });
    expect(seen?.state).toBe("ready");
    // The first read answers late, with an OLDER check. It must not win.
    await answerRead(0, status("model-not-ready", 10));
    expect(seen?.state).toBe("ready");
  });

  test("an invalidation drops the stale answer and asks main once", async () => {
    await mount("apple:system");
    await answerRead(0, status("ready", 10));
    await broadcast({ status: null });
    // Unknown, not "unavailable": callers hold their state, no flash.
    expect(seen).toBeUndefined();
    expect(dispatched).toEqual(["appleFm:status", "appleFm:status"]);
    await answerRead(1, status("license-required", 30));
    expect(seen?.state).toBe("license-required");
  });

  test("a failed read leaves the answer unknown rather than inventing one", async () => {
    await mount("apple:system");
    await answerRead(0, { error: "bridge unavailable" });
    expect(seen).toBeUndefined();
  });

  test("a malformed broadcast is ignored: not a status, and not an invalidation", async () => {
    await mount("apple:system");
    await answerRead(0, status("ready", 10));
    for (const payload of [undefined, null, {}, { status: { state: "nope" } }, { status: "ready" }, 7]) {
      await broadcast(payload);
    }
    expect(seen?.state).toBe("ready");
    expect(dispatched).toEqual(["appleFm:status"]);
  });
});

describe("while it is not selected", () => {
  test.each([undefined, "", "codex", "acp:kimi", "apple:pcc"])(
    "provider %j: no read, no subscription, and a broadcast changes nothing",
    async (provider) => {
      await mount(provider);
      expect(dispatched).toEqual([]);
      expect(subscriberCount()).toBe(0);
      await broadcast({ status: status("ready", 20) });
      expect(seen).toBeUndefined();
      expect(dispatched).toEqual([]);
    }
  );

  test("switching away stops following; switching back reads main's cache once", async () => {
    await mount("apple:system");
    await answerRead(0, status("ready", 10));
    await rerender("codex");
    expect(seen).toBeUndefined();
    expect(subscriberCount()).toBe(0);
    await broadcast({ status: status("ready", 20) });
    expect(seen).toBeUndefined();

    await rerender("apple:system");
    expect(subscriberCount()).toBe(1);
    expect(dispatched).toEqual(["appleFm:status", "appleFm:status"]);
  });
});

describe("property: a window only ever holds the latest check it was shown", () => {
  test("any order of broadcasts ends on the newest, with exactly one read", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 12 }),
        async (checks) => {
          await mount("apple:system");
          for (const checkedAt of checks) {
            await broadcast({ status: status(checkedAt % 2 === 0 ? "ready" : "model-not-ready", checkedAt) });
          }
          expect(seen?.checkedAt).toBe(Math.max(...checks));
          // However many changes arrived, the window asked main exactly once.
          expect(dispatched).toEqual(["appleFm:status"]);
          await act(async () => {
            root?.unmount();
          });
          container?.remove();
          root = null;
          container = null;
          dispatched = [];
          pendingReads = [];
          listeners = new Map();
        }
      ),
      { numRuns: 40 }
    );
  });
});
