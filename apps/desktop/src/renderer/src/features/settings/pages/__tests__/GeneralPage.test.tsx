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
import {
  EVENT_CHANNELS,
  type AppUpdateStatus,
  type LaunchAtLoginStatus,
  type Settings
} from "@pwrsnap/shared";
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
  experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
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
  library: { detailRail: { pinned: true, lastSelectedTab: "info" }, confirmBeforeTrash: true, gridZoom: 180 }
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
): {
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const calls: { name: string; req: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform,
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "app:launchAtLoginStatus") return { ok: true, value: status };
        if (name === "app:update:releases") {
          return {
            ok: true,
            value: {
              fetchedAt: 1,
              latest: { version: "v1.2.3" },
              prerelease: { version: "v1.3.0-beta.2" }
            }
          };
        }
        if (name === "app:update:status") {
          return { ok: true, value: { status: "idle" } satisfies AppUpdateStatus };
        }
        if (name === "app:update:check") {
          return { ok: true, value: { status: "available", version: "1.3.0-beta.3" } };
        }
        if (name === "app:update:install") {
          return { ok: true, value: { status: "restarting" } };
        }
        return { ok: true, value: undefined };
      },
      on: (channel: string, handler: (payload: unknown) => void): (() => void) => {
        const channelListeners = listeners.get(channel) ?? new Set();
        channelListeners.add(handler);
        listeners.set(channel, channelListeners);
        return () => {
          channelListeners.delete(handler);
        };
      }
    }
  });
  return {
    calls,
    pushEvent: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    }
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderGeneral(
  settings: Settings,
  status: LaunchAtLoginStatus,
  platform: NodeJS.Platform = "darwin"
): Promise<{
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
}> {
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

describe("GeneralPage — updates", () => {
  test("shows channel release versions and patches the selected channel", async () => {
    await renderGeneral(baseSettings, healthyStatus);

    expect(container?.textContent).toContain("v1.2.3");
    expect(container?.textContent).toContain("v1.3.0-beta.2");

    const prerelease = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("Prerelease")
    );
    await act(async () => {
      prerelease?.click();
    });

    expect(patchMock).toHaveBeenCalledWith({ updates: { channel: "prerelease" } });
  });

  test("manual check dispatches app:update:check and shows the result", async () => {
    const { calls } = await renderGeneral(baseSettings, healthyStatus);
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Check for Updates"
    );

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(calls.some((c) => c.name === "app:update:check")).toBe(true);
    expect(container?.textContent).toContain("Update available: v1.3.0-beta.3");
  });

  test("downloaded update status switches the action to restart", async () => {
    const api = await renderGeneral(baseSettings, healthyStatus);

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.3.0-beta.4"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("Update version: 1.3.0-beta.4");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.getAttribute("aria-label") === "Restart to Update (1.3.0-beta.4)"
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "app:update:install")).toBe(true);
  });

  test("failed install status shows a retry action", async () => {
    const api = await renderGeneral(baseSettings, healthyStatus);

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "install-failed",
        version: "1.3.0-beta.5",
        currentVersion: "1.3.0-beta.4",
        attemptedAt: "2026-06-29T12:00:00.000Z",
        channel: "prerelease"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("did not finish installing");
    expect(container?.textContent).toContain("Update version: 1.3.0-beta.5");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.getAttribute("aria-label") === "Retry Update (1.3.0-beta.5)"
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "app:update:install")).toBe(true);
  });
});
