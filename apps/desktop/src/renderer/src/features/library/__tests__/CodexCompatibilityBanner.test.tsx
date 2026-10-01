import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  type CodexCliCompatibilityAlert,
  type DesktopCodexVersionAdvisory,
  type Settings
} from "@pwrsnap/shared";
import { CodexCompatibilityBanner } from "../CodexCompatibilityBanner";
import { baseSettings } from "../../settings/__tests__/settings-fixture";

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

const ADVISORY: DesktopCodexVersionAdvisory = {
  command: "/opt/homebrew/bin/codex",
  version: "0.159.1",
  minimumVersion: "0.159.2",
  installer: "homebrew",
  upgradeCommand: "brew upgrade --cask codex"
};
const AI_ON: Settings = { ...baseSettings, ai: { ...baseSettings.ai, enabled: true } };

function installFakeApi(initialAlert: CodexCliCompatibilityAlert | null, options: {
  settings?: Settings;
  advisory?: DesktopCodexVersionAdvisory;
  deferredDiscovery?: Promise<AnyResult>;
} = {}): {
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
        if (name === "settings:read") return { ok: true, value: options.settings ?? baseSettings };
        if (name === "settings:refreshCodexDiscovery") return options.deferredDiscovery ?? {
          ok: true, value: { versionAdvisory: options.advisory }
        };
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

async function renderBanner(initialAlert: CodexCliCompatibilityAlert | null, options: Parameters<typeof installFakeApi>[1] = {}): Promise<
  ReturnType<typeof installFakeApi>
> {
  const api = installFakeApi(initialAlert, options);
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
  test("warns at startup only with AI enabled, copies the installer command, and keeps dismissal through unrelated saves", async () => {
    const api = await renderBanner(null, { settings: AI_ON, advisory: ADVISORY });
    expect(container?.textContent).toContain("is out of date");
    expect(container?.textContent).toContain("GPT-6.1-Sol");
    expect(container?.textContent).toContain("0.159.2+");
    const copy = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === "Copy command");
    await act(async () => copy?.click());
    expect(api.calls).toContainEqual({ name: "clipboard:copyText", req: { text: "brew upgrade --cask codex" } });
    const dismiss = container!.querySelector<HTMLButtonElement>(".app-update-banner__dismiss");
    await act(async () => dismiss?.click());
    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.settingsChanged, { settings: { ...AI_ON } });
      api.pushEvent(EVENT_CHANNELS.codexVersionAdvisoryChanged, { ...ADVISORY });
    });
    expect(container?.querySelector("aside")).toBeNull();
    expect(api.calls.filter((c) => c.name === "settings:refreshCodexDiscovery")).toHaveLength(1);
    await act(async () => api.pushEvent(EVENT_CHANNELS.codexVersionAdvisoryChanged, { ...ADVISORY, version: "0.158.0" }));
    expect(container?.textContent).toContain("0.158.0");
    await act(async () => api.pushEvent(EVENT_CHANNELS.codexVersionAdvisoryChanged, null));
    expect(container?.querySelector("aside")).toBeNull();
  });

  test("does not request discovery while AI is disabled and hides immediately when it is disabled", async () => {
    const api = await renderBanner(null, { advisory: ADVISORY });
    expect(api.calls.some((c) => c.name === "settings:refreshCodexDiscovery")).toBe(false);
    expect(container?.querySelector("aside")).toBeNull();
    await act(async () => api.pushEvent(EVENT_CHANNELS.settingsChanged, { settings: AI_ON }));
    expect(container?.textContent).toContain("GPT-6.1-Sol");
    await act(async () => api.pushEvent(EVENT_CHANNELS.settingsChanged, { settings: baseSettings }));
    expect(container?.querySelector("aside")).toBeNull();
  });

  test("an upgrade event wins over a late old discovery response", async () => {
    let resolveDiscovery!: (result: AnyResult) => void;
    const deferredDiscovery = new Promise<AnyResult>((resolve) => { resolveDiscovery = resolve; });
    const api = await renderBanner(null, { settings: AI_ON, deferredDiscovery });
    await act(async () => api.pushEvent(EVENT_CHANNELS.codexVersionAdvisoryChanged, null));
    await act(async () => resolveDiscovery({ ok: true, value: { versionAdvisory: ADVISORY } }));
    expect(container?.querySelector("aside")).toBeNull();
  });

  test("does not duplicate the launch failure and model advisory", async () => {
    await renderBanner(FIRST_ALERT, { settings: AI_ON, advisory: ADVISORY });
    expect(container?.querySelectorAll("aside")).toHaveLength(1);
    expect(container?.textContent).toContain("Codex update required");
  });
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

    // Straight to the Codex screen — the banner is about one binary.
    expect(api.calls).toContainEqual({
      name: "settings:open",
      req: { page: "ai", sub: "codex" }
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
