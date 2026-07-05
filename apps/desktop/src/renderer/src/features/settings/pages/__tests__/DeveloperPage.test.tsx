import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { DeveloperPage } from "../DeveloperPage";
import type { UseSettingsValue } from "../../useSettings";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const baseSettings: Settings = {
  schemaVersion: 1,
  codex: { mode: "auto", pinnedPath: "", profile: "", captionModel: "gpt-5.4-mini" },
  ai: {
    enabled: false,
    consentAcceptedAt: null,
    budgetSafetyDisabledAt: null,
    autoAcceptSuggestions: false,
    chat: {
      userGuidance: "",
      sensitiveDataPatterns: [],
      defaultRedactionStyle: "blackout",
      firstLaunchBannerDismissed: false
    },
    defaults: { libraryChat: {}, sizzleChat: {}, enrichment: {} },
    acp: { enabledAgentIds: [] }
  },
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
  general: {
    developerMode: false,
    hotCpuProfilingEnabled: false,
    hotCpuProfilingStartDelayMs: 0,
    hotCpuProfilingTriggerMode: "sustained",
    hotCpuProfilingSlowburnThresholdPercent: 15,
    hotCpuProfilingCaptureHeapSnapshot: false,
    hotCpuProfilingHeapSnapshotLimit: 2,
    launchAtLogin: false
  },
  experimental: { processSplit: false, dpiAwareExport: false, allowRetinaExport: true },
  appearance: { theme: "system" },
  updates: { channel: "latest" },
  storage: { filenameTimestampZone: "local" },
  recording: {
    includeSystemAudio: false,
    includeMicrophone: false,
    lastRoutedPermissionFingerprint: "",
    screenCapturePrompted: false
  },
  editor: {
    toolStyles: {
      arrow: {
        color: "accent",
        thickness: "auto",
        endStyle: "filled-triangle",
        stemStyle: "solid",
        doubleEnded: false
      },
      text: { color: "accent", fontSize: "auto", weight: "regular" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15 },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: {
    detailRail: { pinned: true, lastSelectedTab: "info" },
    confirmBeforeTrash: true,
    gridZoom: 180
  }
};

const patchMock = vi.fn(async (): Promise<void> => undefined);
const dispatchCalls: { name: string; req: unknown }[] = [];
type DispatchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { message: string } };
type DispatchImpl = (name: string, req: unknown) => Promise<DispatchResult>;

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

async function renderDeveloper(
  settings: Settings | null = baseSettings,
  dispatchImpl?: DispatchImpl
): Promise<void> {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      dispatch: async (name: string, req: unknown) => {
        dispatchCalls.push({ name, req });
        if (dispatchImpl !== undefined) return dispatchImpl(name, req);
        if (name === "diagnostics:clearHotCpuSessions") {
          return {
            ok: true,
            value: {
              deletedSessions: 2,
              errors: [],
              freedBytes: 123,
              skippedEntries: 1
            }
          };
        }
        return { ok: true, value: undefined };
      },
      on: () => () => undefined
    }
  });
  contextValue = { settings, patch: patchMock as unknown as UseSettingsValue["patch"] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(DeveloperPage));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button")).find(
    (el) => el.textContent?.includes(text)
  );
  if (button === undefined) throw new Error(`button not found: ${text}`);
  return button;
}

function switchIn(label: string): HTMLButtonElement {
  const row = Array.from(container!.querySelectorAll(".pss__row")).find((el) =>
    el.textContent?.includes(label)
  );
  const toggle = row?.querySelector<HTMLButtonElement>("button[role='switch']");
  if (toggle === undefined || toggle === null) throw new Error(`switch not found: ${label}`);
  return toggle;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  patchMock.mockClear();
  dispatchCalls.length = 0;
});

describe("DeveloperPage", () => {
  test("hosts developer mode and hot CPU diagnostics under Advanced", async () => {
    await renderDeveloper();
    expect(container?.textContent).toContain("Advanced");
    expect(container?.textContent).toContain("Developer");
    expect(container?.textContent).toContain("Show developer menu items");
    expect(container?.textContent).toContain("Hot renderer CPU profiling");
  });

  test("developer mode patches the existing general setting", async () => {
    await renderDeveloper();
    await act(async () => {
      switchIn("Show developer menu items").click();
    });
    expect(patchMock).toHaveBeenCalledWith({ general: { developerMode: true } });
  });

  test("start capture arms hot CPU profiling through settings", async () => {
    await renderDeveloper();
    await act(async () => {
      buttonByText("Start Capture (Immediate)").click();
    });
    expect(patchMock).toHaveBeenCalledWith({
      general: { hotCpuProfilingEnabled: true }
    });
  });

  test("trigger mode selection patches only the trigger mode", async () => {
    await renderDeveloper();
    await act(async () => {
      buttonByText("Slowburn").click();
    });
    expect(patchMock).toHaveBeenCalledWith({
      general: { hotCpuProfilingTriggerMode: "slowburn" }
    });
  });

  test("diagnostics folder controls dispatch reveal and cleanup commands", async () => {
    await renderDeveloper();

    await act(async () => {
      buttonByText("Reveal Folder").click();
      await Promise.resolve();
    });
    await act(async () => {
      buttonByText("Clear Old Sessions").click();
      await Promise.resolve();
    });

    expect(dispatchCalls).toContainEqual({
      name: "diagnostics:revealHotCpuRoot",
      req: {}
    });
    expect(dispatchCalls).toContainEqual({
      name: "diagnostics:clearHotCpuSessions",
      req: {}
    });
    expect(container?.textContent).toContain("Cleared 2 sessions; skipped 1.");
  });

  test("cleanup is disabled while hot CPU profiling is armed", async () => {
    await renderDeveloper({
      ...baseSettings,
      general: {
        ...baseSettings.general,
        hotCpuProfilingEnabled: true
      }
    });

    expect(buttonByText("Clear Old Sessions").disabled).toBe(true);
  });

  test("cleanup is disabled while smart heap snapshots are armed", async () => {
    await renderDeveloper({
      ...baseSettings,
      general: {
        ...baseSettings.general,
        hotCpuProfilingCaptureHeapSnapshot: true
      }
    });

    expect(buttonByText("Clear Old Sessions").disabled).toBe(true);
  });

  test("cleanup is disabled while a delayed capture is counting down", async () => {
    await renderDeveloper({
      ...baseSettings,
      general: {
        ...baseSettings.general,
        hotCpuProfilingStartDelayMs: 5_000
      }
    });

    await act(async () => {
      buttonByText("Start Capture").click();
    });

    expect(buttonByText("Clear Old Sessions").disabled).toBe(true);
  });

  test("cleanup is disabled before settings are ready", async () => {
    await renderDeveloper(null);

    expect(buttonByText("Clear Old Sessions").disabled).toBe(true);
  });

  test("pending cleanup disables hot CPU capture controls until it settles", async () => {
    let resolveClear: ((result: DispatchResult) => void) | null = null;
    const clearPromise = new Promise<DispatchResult>((resolve) => {
      resolveClear = resolve;
    });
    await renderDeveloper(baseSettings, async (name) => {
      if (name === "diagnostics:clearHotCpuSessions") return clearPromise;
      return { ok: true, value: undefined };
    });

    await act(async () => {
      buttonByText("Clear Old Sessions").click();
      await Promise.resolve();
    });

    expect(buttonByText("Start Capture").disabled).toBe(true);
    expect(buttonByText("Clear Old Sessions").disabled).toBe(true);
    await act(async () => {
      buttonByText("Start Capture").click();
    });
    expect(patchMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveClear?.({
        ok: true,
        value: {
          deletedSessions: 1,
          errors: [],
          freedBytes: 64,
          skippedEntries: 1
        }
      });
      await clearPromise;
    });

    expect(buttonByText("Start Capture").disabled).toBe(false);
    expect(buttonByText("Clear Old Sessions").disabled).toBe(false);
    expect(container?.textContent).toContain("Cleared 1 session; skipped 1.");
  });
});
