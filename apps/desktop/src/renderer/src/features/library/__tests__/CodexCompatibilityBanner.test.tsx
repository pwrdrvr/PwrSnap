import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type CodexCliCompatibilityAlert
} from "@pwrsnap/shared";
import { CodexCompatibilityBanner } from "../CodexCompatibilityBanner";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

const FIRST_ALERT: CodexCliCompatibilityAlert = {
  kind: "too-old",
  key: "codex-cli-too-old:first",
  command: "codex",
  detectedVersion: "0.143.0",
  requiredVersion: "0.144.0",
  detectedAt: "2026-08-03T12:00:00.000Z"
};

function installFakeApi(initialAlert: CodexCliCompatibilityAlert | null): {
  calls: Array<{ name: string; req: unknown }>;
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const calls: Array<{ name: string; req: unknown }> = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "codex:compatibilityAlert") {
          return { ok: true, value: initialAlert };
        }
        return { ok: true, value: undefined };
      },
      on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(handler);
        listeners.set(channel, channelListeners);
        return () => channelListeners.delete(handler);
      }
    }
  });
  return {
    calls,
    pushEvent: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderBanner(initialAlert: CodexCliCompatibilityAlert | null): Promise<
  ReturnType<typeof installFakeApi>
> {
  const api = installFakeApi(initialAlert);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(CodexCompatibilityBanner));
    await Promise.resolve();
  });
  return api;
}

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("CodexCompatibilityBanner", () => {
  test("snapshot-reads a pre-existing guard failure and opens AI Providers", async () => {
    const api = await renderBanner(FIRST_ALERT);

    expect(container?.textContent).toContain("Codex update required");
    expect(container?.textContent).toContain("0.143.0");
    expect(container?.textContent).toContain("0.144.0");

    const openButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Open Settings"
    );
    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });

    expect(api.calls).toContainEqual({
      name: "settings:open",
      req: { page: "ai" }
    });
    expect(container?.textContent).toContain("Codex update required");
  });

  test("is durable, deduplicates repeats, and surfaces a new incompatibility", async () => {
    vi.useFakeTimers();
    const api = await renderBanner(null);

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, FIRST_ALERT);
    });
    expect(container?.querySelectorAll(".codex-compatibility-banner")).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(container?.textContent).toContain("Codex update required");

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, {
        ...FIRST_ALERT,
        detectedAt: "2026-08-03T12:01:00.000Z"
      });
    });
    expect(container?.querySelectorAll(".codex-compatibility-banner")).toHaveLength(1);

    const dismissButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss"
    );
    await act(async () => dismissButton?.click());
    expect(container?.querySelector(".codex-compatibility-banner")).toBeNull();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, FIRST_ALERT);
    });
    expect(container?.querySelector(".codex-compatibility-banner")).toBeNull();

    // A successful guard emits null and must re-arm the same stable key for a
    // later regression, without requiring the Library component to remount.
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, null);
    });
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, FIRST_ALERT);
    });
    expect(container?.textContent).toContain("0.143.0");

    const rearmedDismissButton = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss"
    );
    await act(async () => rearmedDismissButton?.click());
    expect(container?.querySelector(".codex-compatibility-banner")).toBeNull();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.codexCompatibilityAlertChanged, {
        ...FIRST_ALERT,
        key: "codex-cli-too-old:new-version",
        detectedVersion: "0.142.0",
        detectedAt: "2026-08-03T12:02:00.000Z"
      });
    });
    expect(container?.textContent).toContain("0.142.0");
  });
});
