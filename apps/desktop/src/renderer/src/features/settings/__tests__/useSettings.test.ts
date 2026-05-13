// useSettings hook integration test.
//
// The hook subscribes to `events:settings:changed` and dispatches
// command-bus calls via `window.pwrsnapApi`. We stub that surface
// with a small fake bus that:
//   • records dispatches and returns canned Result envelopes;
//   • exposes a `pushEvent` to simulate a main-process broadcast.
//
// Rendering uses React 19's `act` from `react-dom/test-utils`-style
// API through `react-dom/client`. The tests assert only on the hook's
// observable state — we read it back through a captured callback,
// which keeps us out of the @testing-library dependency we deliberately
// don't introduce.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

// React 19 honors this flag to enable act() in test runners. Without
// it, every act() call emits "The current testing environment is not
// configured to support act(...)".
beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
import type { Settings } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared/ipc";
import { useSettings, type UseSettingsValue } from "../useSettings";
import { createElement } from "react";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: unknown };
type DispatchFn = (name: string, req: unknown) => Promise<AnyResult>;
type EventHandler = (payload: unknown) => void;

type FakeApi = {
  dispatch: DispatchFn;
  on: (channel: string, handler: EventHandler) => () => void;
};

const baseSettings: Settings = {
  schemaVersion: 1,
  codex: { mode: "auto", pinnedPath: "", profile: "" },
  ai: { enabled: false, consentAcceptedAt: null },
  hotkeys: {
    quickCapture: "CommandOrControl+Shift+P",
    region: "CommandOrControl+Shift+R",
    window: "CommandOrControl+Shift+W"
  },
  experimental: { v2FileFormat: false }
};

const baseSecrets = {
  grokApiKey: { configured: false, lastSetAt: null }
};

function installFakeApi(api: FakeApi): void {
  (globalThis as unknown as { window: { pwrsnapApi: FakeApi } }).window = {
    pwrsnapApi: api
  } as unknown as { pwrsnapApi: FakeApi };
}

function buildApi(
  overrides: {
    onRead?: () => AnyResult;
    onStatus?: () => AnyResult;
    onWrite?: (req: unknown) => AnyResult;
  } = {}
): FakeApi & {
  pushEvent: (channel: string, payload: unknown) => void;
  calls: { name: string; req: unknown }[];
} {
  const subscribers = new Map<string, Set<EventHandler>>();
  const calls: { name: string; req: unknown }[] = [];

  const api = {
    calls,
    async dispatch(name: string, req: unknown): Promise<AnyResult> {
      calls.push({ name, req });
      if (name === "settings:read") {
        return overrides.onRead?.() ?? { ok: true, value: baseSettings };
      }
      if (name === "settings:secretStatus") {
        return overrides.onStatus?.() ?? { ok: true, value: baseSecrets };
      }
      if (name === "settings:write") {
        return overrides.onWrite?.(req) ?? { ok: true, value: baseSettings };
      }
      return { ok: true, value: undefined };
    },
    on(channel: string, handler: EventHandler): () => void {
      let set = subscribers.get(channel);
      if (set === undefined) {
        set = new Set();
        subscribers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    pushEvent(channel: string, payload: unknown): void {
      const set = subscribers.get(channel);
      if (set === undefined) return;
      for (const handler of set) handler(payload);
    }
  };
  return api;
}

// ── Test harness ────────────────────────────────────────────────
let capturedValue: UseSettingsValue | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe(): null {
  capturedValue = useSettings();
  return null;
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Probe));
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  capturedValue = null;
  container = null;
  root = null;
}

async function flush(): Promise<void> {
  // Let the hook's async `initialLoad` resolve and React commit the
  // resulting setState calls.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  capturedValue = null;
});

afterEach(async () => {
  await unmount();
});

describe("useSettings", () => {
  test("initial mount loads settings + secrets in parallel", async () => {
    const api = buildApi();
    installFakeApi(api);
    await mount();
    // The mount() helper awaits inside act(); act() flushes the effect
    // queue AND its scheduled microtasks before resolving, so by the
    // time the next line runs the initialLoad() promise has settled.
    // The loading=true state is observably the initial render state
    // only; we assert the post-load shape instead.
    await flush();
    expect(capturedValue?.loading).toBe(false);
    expect(capturedValue?.settings).toEqual(baseSettings);
    expect(capturedValue?.secrets).toEqual(baseSecrets);
    expect(capturedValue?.error).toBeNull();
    expect(api.calls.map((c) => c.name)).toEqual(
      expect.arrayContaining(["settings:read", "settings:secretStatus"])
    );
  });

  test("a broadcast event replaces local state", async () => {
    const api = buildApi();
    installFakeApi(api);
    await mount();
    await flush();

    const nextSettings: Settings = {
      ...baseSettings,
      experimental: { v2FileFormat: true }
    };
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.settingsChanged, {
        settings: nextSettings,
        secrets: { grokApiKey: { configured: true, lastSetAt: "2026-05-12T12:00:00.000Z" } }
      });
    });
    expect(capturedValue?.settings).toEqual(nextSettings);
    expect(capturedValue?.secrets?.grokApiKey.configured).toBe(true);
  });

  test("patch() dispatches settings:write with the patch", async () => {
    let lastReq: unknown = null;
    const api = buildApi({
      onWrite: (req) => {
        lastReq = req;
        return {
          ok: true,
          value: { ...baseSettings, experimental: { v2FileFormat: true } }
        };
      }
    });
    installFakeApi(api);
    await mount();
    await flush();
    await act(async () => {
      await capturedValue?.patch({ experimental: { v2FileFormat: true } });
    });
    expect(lastReq).toEqual({ experimental: { v2FileFormat: true } });
    expect(capturedValue?.settings?.experimental.v2FileFormat).toBe(true);
  });

  test("read failure populates error and clears loading", async () => {
    const api = buildApi({
      onRead: () => ({
        ok: false,
        error: { kind: "settings", code: "read_failed", message: "boom" }
      })
    });
    installFakeApi(api);
    await mount();
    await flush();
    expect(capturedValue?.loading).toBe(false);
    expect(capturedValue?.error).toEqual({
      kind: "settings",
      code: "read_failed",
      message: "boom"
    });
  });

  test("patch() rejects + records error on write failure", async () => {
    const api = buildApi({
      onWrite: () => ({
        ok: false,
        error: { kind: "settings", code: "write_failed", message: "nope" }
      })
    });
    installFakeApi(api);
    await mount();
    await flush();
    let threw = false;
    await act(async () => {
      try {
        await capturedValue?.patch({ experimental: { v2FileFormat: true } });
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(true);
    expect(capturedValue?.error?.code).toBe("write_failed");
  });
});
