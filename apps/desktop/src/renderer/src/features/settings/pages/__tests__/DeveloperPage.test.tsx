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

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

async function renderDeveloper(settings: Settings = baseSettings): Promise<void> {
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
});
