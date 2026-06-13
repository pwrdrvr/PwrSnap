// GeneralPage — the Launch-at-login card:
//   • the toggle patches `general.launchAtLogin` through the settings
//     substrate (no side channels);
//   • the page re-reads `app:launchAtLoginStatus` and surfaces the
//     OS-side divergence states (blocked-by-OS, dev-build skip);
//   • the blocked state's recovery button dispatches
//     `app:openLoginItemsSettings`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { LaunchAtLoginStatus, Settings } from "@pwrsnap/shared";
import { GeneralPage } from "../GeneralPage";
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
  general: { developerMode: false, launchAtLogin: false },
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
  library: { detailRail: { pinned: true, lastSelectedTab: "info" } }
};

const patchMock = vi.fn(async (): Promise<void> => undefined);

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

function installFakeApi(
  status: LaunchAtLoginStatus,
  platform: NodeJS.Platform = "darwin"
): { calls: { name: string; req: unknown }[] } {
  const calls: { name: string; req: unknown }[] = [];
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform,
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "app:launchAtLoginStatus") return { ok: true, value: status };
        return { ok: true, value: undefined };
      }
    }
  });
  return { calls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderGeneral(
  settings: Settings,
  status: LaunchAtLoginStatus,
  platform: NodeJS.Platform = "darwin"
): Promise<{ calls: { name: string; req: unknown }[] }> {
  const api = installFakeApi(status, platform);
  contextValue = { settings, patch: patchMock as unknown as UseSettingsValue["patch"] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(GeneralPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return api;
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

const healthyStatus: LaunchAtLoginStatus = {
  supported: true,
  registered: false,
  blockedByOs: false
};

function findSwitchIn(label: string): HTMLButtonElement {
  const row = Array.from(container!.querySelectorAll(".pss__row")).find((el) =>
    el.textContent?.includes(label)
  );
  const toggle = row?.querySelector<HTMLButtonElement>("button[role='switch']");
  if (!toggle) throw new Error(`no switch found in row "${label}"`);
  return toggle;
}

describe("GeneralPage — launch at login", () => {
  test("toggle patches general.launchAtLogin through the substrate", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Start PwrSnap when you sign in");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ general: { launchAtLogin: true } });
  });

  test("healthy status renders no divergence rows", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    expect(container?.textContent).not.toContain("Disabled by the operating system");
    expect(container?.textContent).not.toContain("Development build");
  });

  test("blocked-by-OS status surfaces the recovery row + opens startup settings", async () => {
    const { calls } = await renderGeneral(
      { ...baseSettings, general: { developerMode: false, launchAtLogin: true } },
      { supported: true, registered: true, blockedByOs: true }
    );
    expect(container?.textContent).toContain("Disabled by the operating system");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open startup settings"
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(calls.some((c) => c.name === "app:openLoginItemsSettings")).toBe(true);
  });

  test("blocked-by-OS on Linux renders the row but no dead deep-link button", async () => {
    await renderGeneral(
      { ...baseSettings, general: { developerMode: false, launchAtLogin: true } },
      { supported: true, registered: true, blockedByOs: true },
      "linux"
    );
    expect(container?.textContent).toContain("Disabled by the operating system");
    // `app:openLoginItemsSettings` has no Linux deep link — the row
    // must point at the DE's startup tool instead of a no-op button.
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open startup settings"
    );
    expect(button).toBeUndefined();
    expect(container?.textContent).toContain("Re-enable in your startup tool");
  });

  test("dev-build status explains that registration is saved-only", async () => {
    await renderGeneral(baseSettings, {
      supported: false,
      reason: "dev-build",
      registered: false,
      blockedByOs: false
    });
    expect(container?.textContent).toContain("Development build");
    expect(container?.textContent).toContain("Saved only");
  });
});
