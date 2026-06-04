// SettingsContext behaviour:
//   • `useSettingsContext` throws when accessed outside a Provider.
//   • Inside a Provider, it returns the hoisted `useSettings()` value
//     and pages share that snapshot (one subscriber, one initial pair
//     of dispatches per window).

import { Component, act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import type { Settings } from "@pwrsnap/shared";
import { SettingsProvider, useSettingsContext } from "../SettingsContext";
import type { UseSettingsValue } from "../useSettings";

type AnyResult = { ok: true; value: unknown } | { ok: false; error: unknown };
type EventHandler = (payload: unknown) => void;

const baseSettings: Settings = {
  schemaVersion: 1,
  codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
  ai: { enabled: false, consentAcceptedAt: null, budgetSafetyDisabledAt: null, autoAcceptSuggestions: false, chat: { userGuidance: "", sensitiveDataPatterns: [], defaultRedactionStyle: "blackout", firstLaunchBannerDismissed: false } },
  hotkeys: {
    quickCapture: "CommandOrControl+Shift+C",
    region: "",
    window: "",
    fullScreen: "",
    allScreens: "",
    timed: "",
    videoCapture: "CommandOrControl+Alt+C",
    reshowFloatOver: "CommandOrControl+Alt+Shift+F"
  },
  general: { developerMode: false },
  appearance: { theme: "system" },
  updates: { channel: "latest" },
  storage: { filenameTimestampZone: "local" },
  recording: {
    includeSystemAudio: false,
    includeMicrophone: false,
    lastRoutedPermissionFingerprint: ""
  },
  editor: {
    toolStyles: {
      arrow: { color: "accent", thickness: "auto", endStyle: "filled-triangle", stemStyle: "solid", doubleEnded: false },
      text: { color: "accent", fontSize: "auto", weight: "regular" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
};

const baseSecrets = {
  grokApiKey: { configured: false, lastSetAt: null }
};

function installFakeApi(): { calls: { name: string; req: unknown }[] } {
  const subscribers = new Map<string, Set<EventHandler>>();
  const calls: { name: string; req: unknown }[] = [];
  const api = {
    calls,
    async dispatch(name: string, req: unknown): Promise<AnyResult> {
      calls.push({ name, req });
      if (name === "settings:read") return { ok: true, value: baseSettings };
      if (name === "settings:secretStatus") return { ok: true, value: baseSecrets };
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
    }
  };
  (globalThis as unknown as { window: { pwrsnapApi: unknown } }).window = {
    pwrsnapApi: api
  } as unknown as { pwrsnapApi: unknown };
  return { calls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
}

beforeEach(() => {
  // Silence the expected error from React when a component throws
  // synchronously during render. The test still observes the throw
  // via the `errored` flag below.
});

afterEach(async () => {
  await unmount();
});

describe("SettingsContext", () => {
  test("useSettingsContext throws when used outside a Provider", async () => {
    installFakeApi();
    function Probe(): ReactElement {
      useSettingsContext();
      return createElement("div");
    }
    // Class error boundary: catches the render-time throw cleanly
    // so React doesn't bubble it to its uncaught-error path. Vitest
    // is happy because no error escapes the render.
    type BoundaryState = { error: Error | null };
    class Boundary extends Component<{ children: ReactNode }, BoundaryState> {
      override state: BoundaryState = { error: null };
      static getDerivedStateFromError(error: Error): BoundaryState {
        return { error };
      }
      override render(): ReactNode {
        if (this.state.error !== null) {
          return createElement("div", { "data-err": this.state.error.message });
        }
        return this.props.children;
      }
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, {
      // Silence the React 19 uncaught-error log; the boundary handles
      // the throw, but React still logs it once for ergonomics.
      onUncaughtError: () => {},
      onCaughtError: () => {}
    });
    await act(async () => {
      root?.render(createElement(Boundary, null, createElement(Probe)));
    });
    const errDiv = container.querySelector("[data-err]");
    expect(errDiv).not.toBeNull();
    expect(errDiv?.getAttribute("data-err")).toMatch(/SettingsProvider/);
  });

  test("Provider exposes the hook value to children", async () => {
    installFakeApi();
    const captured: { value: UseSettingsValue | null } = { value: null };
    function Consumer(): null {
      captured.value = useSettingsContext();
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(SettingsProvider, null, createElement(Consumer))
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.value).not.toBeNull();
    expect(captured.value?.settings).toEqual(baseSettings);
    expect(captured.value?.secrets).toEqual(baseSecrets);
    expect(typeof captured.value?.patch).toBe("function");
  });

  test("Single subscriber: two consumers, one initial dispatch pair", async () => {
    const { calls } = installFakeApi();
    function Consumer(): null {
      useSettingsContext();
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          SettingsProvider,
          null,
          createElement(Consumer),
          createElement(Consumer),
          createElement(Consumer)
        )
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const reads = calls.filter((c) => c.name === "settings:read").length;
    const statuses = calls.filter((c) => c.name === "settings:secretStatus").length;
    // Strict-mode double-effect in dev would inflate this; production
    // mode (which Vitest runs in by default) keeps it at one each.
    expect(reads).toBe(1);
    expect(statuses).toBe(1);
  });
});
