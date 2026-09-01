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
    reshowFloatOver: "CommandOrControl+Alt+Shift+F",
    openLibrary: ""
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
  experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
  appearance: { theme: "system" },
  updates: { channel: "latest", train: "stable" },
  storage: { filenameTimestampZone: "local", capturesLocation: "documents" },
  recording: {
    includeSystemAudio: false,
    includeMicrophone: false,
    videoCaptureCursor: true,
    imageCaptureCursor: true,
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
        doubleEnded: false,
        outline: "auto"
      },
      text: { color: "accent", fontSize: "auto", weight: "regular", outline: "auto" },
      shape: { color: "accent", thickness: "auto", filled: false, shape: "rect", skewDeg: 15, outline: "auto" },
      blur: { mode: "gaussian", radius: { mode: "auto" } },
      highlight: { color: "yellow", opacity: 0.3, blend: "multiply" }
    },
    coachmarks: { stoplightSeen: false },
    matchingText: { enabled: true },
    sidebar: { pinned: false, lastSelectedPanel: "toolConfig" }
  },
  library: { detailRail: { pinned: true, lastSelectedTab: "info" }, gridCopyPalette: { anchor: "follow" }, confirmBeforeTrash: true, gridZoom: 180 },
  localAgents: { enabled: false, grants: [], roles: [], audit: [] }
};

const patchMock = vi.fn(async (): Promise<void> => undefined);

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

type AnyResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

function installFakeApi(
  status: LaunchAtLoginStatus,
  platform: NodeJS.Platform = "darwin",
  opts: { microphoneStatus?: "granted" | "denied" } = {}
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
        if (name === "permissions:request") {
          return { ok: true, value: { status: opts.microphoneStatus ?? "granted" } };
        }
        if (name === "app:update:releases") {
          return {
            ok: true,
            value: {
              fetchedAt: 1,
              stable: {
                latest: { version: "v1.2.3" },
                prerelease: { version: "v1.2.4-prerelease.1" }
              },
              beta: {
                latest: { version: "v1.3.0-beta.2" },
                prerelease: { unavailableReason: "No beta prerelease found." }
              }
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
  platform: NodeJS.Platform = "darwin",
  opts: { microphoneStatus?: "granted" | "denied" } = {}
): Promise<{
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
}> {
  const api = installFakeApi(status, platform, opts);
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
  // `setActivePage` writes window.location.hash; jsdom keeps it for the
  // rest of the file, so clear it rather than leaking navigation state.
  window.location.hash = "";
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

describe("GeneralPage — cursor capture", () => {
  test("image toggle patches recording.imageCaptureCursor", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Capture the cursor in screenshots");
    // Default ON (defaultSettings seeds both cursor booleans true).
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ recording: { imageCaptureCursor: false } });
  });

  test("video toggle patches recording.videoCaptureCursor", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Capture the cursor in recordings");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ recording: { videoCaptureCursor: false } });
  });
});

describe("GeneralPage — recording audio", () => {
  // The two `recording.include*Audio` fields have existed in the schema
  // (and been honored by the macOS recorder) since Phase 1, but no
  // renderer surface ever wrote them — the toggles below are the first.
  test("system-audio toggle patches recording.includeSystemAudio", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Include system audio");
    // Defaults OFF — recording either source is privacy-relevant.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ recording: { includeSystemAudio: true } });
  });

  // Read path, not just the write path. Without these two, the `on={}`
  // props could be swapped between the rows and the suite stayed green
  // (mutation-verified) — each switch would show the other source's state.
  test("each switch reflects its own source's saved state", async () => {
    await renderGeneral(
      {
        ...baseSettings,
        recording: {
          ...baseSettings.recording,
          includeSystemAudio: true,
          includeMicrophone: false
        }
      },
      healthyStatus
    );
    expect(findSwitchIn("Include system audio").getAttribute("aria-checked")).toBe("true");
    expect(findSwitchIn("Include your microphone").getAttribute("aria-checked")).toBe("false");
  });

  test("each switch reflects its own source's saved state (mirrored)", async () => {
    await renderGeneral(
      {
        ...baseSettings,
        recording: {
          ...baseSettings.recording,
          includeSystemAudio: false,
          includeMicrophone: true
        }
      },
      healthyStatus
    );
    expect(findSwitchIn("Include system audio").getAttribute("aria-checked")).toBe("false");
    expect(findSwitchIn("Include your microphone").getAttribute("aria-checked")).toBe("true");
  });

  // `recording:start` REJECTS an ungranted microphone rather than
  // degrading to video-only, and macOS never prompts for the mic on its
  // own — so enabling the toggle has to drive the prompt, and must NOT
  // persist unless the OS actually says yes. Otherwise every subsequent
  // recording fails with a notification-only error.
  test("enabling the microphone requests the grant before persisting", async () => {
    const api = await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Include your microphone");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    const request = api.calls.find((c) => c.name === "permissions:request");
    expect(request).toBeDefined();
    expect(request?.req).toEqual({ permission: "microphone" });
    expect(patchMock).toHaveBeenCalledWith({ recording: { includeMicrophone: true } });
    expect(container?.textContent).not.toContain("Microphone is blocked");
  });

  test("a denied microphone is not persisted and surfaces a recovery row", async () => {
    const api = await renderGeneral(baseSettings, healthyStatus, "darwin", {
      microphoneStatus: "denied"
    });
    const toggle = findSwitchIn("Include your microphone");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "permissions:request")).toBe(true);
    // The critical half: we must NOT write `true` for a mic the OS
    // refused, or recording:start hard-fails on every later take.
    expect(patchMock).not.toHaveBeenCalledWith({ recording: { includeMicrophone: true } });
    expect(container?.textContent).toContain("Microphone is blocked");
  });

  test("turning the microphone back off clears the blocked row and persists", async () => {
    await renderGeneral(
      {
        ...baseSettings,
        recording: { ...baseSettings.recording, includeMicrophone: true }
      },
      healthyStatus
    );
    const toggle = findSwitchIn("Include your microphone");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ recording: { includeMicrophone: false } });
    expect(container?.textContent).not.toContain("Microphone is blocked");
  });

  test("system audio does not request a grant — it shares Screen Recording", async () => {
    // There is no separate System Audio TCC grant: readSystemAudioStatus
    // returns readScreenStatus(). Prompting or warning about one would
    // be inventing a permission that does not exist.
    const api = await renderGeneral(baseSettings, healthyStatus);
    await act(async () => {
      findSwitchIn("Include system audio").click();
      await Promise.resolve();
    });
    expect(api.calls.some((c) => c.name === "permissions:request")).toBe(false);
    expect(container?.textContent).toContain("Shares the Screen Recording grant");
    expect(container?.textContent).not.toContain("recording refuses to start");
  });

  test("non-macOS says recording audio is unsupported and never prompts", async () => {
    // Windows records through FFmpeg (video only) and Linux has no
    // recorder at all, so the card must not imply audio either way.
    for (const platform of ["win32", "linux"] as const) {
      const api = await renderGeneral(baseSettings, healthyStatus, platform);
      expect(container?.textContent).toContain("Recording audio is macOS-only for now");
      expect(container?.textContent).not.toContain("what your Mac is playing");
      await act(async () => {
        findSwitchIn("Include your microphone").click();
        await Promise.resolve();
      });
      expect(api.calls.some((c) => c.name === "permissions:request")).toBe(false);
      await act(async () => {
        root?.unmount();
      });
      container?.remove();
    }
  });
});

describe("GeneralPage — editor annotation", () => {
  // `editor.matchingText.enabled` was gated on a "Settings → Editor"
  // page that settings-categories.ts never had, so the only way to turn
  // the "+ Add label" chip off was hand-editing pwrsnap-settings.json.
  test("matching-text toggle patches editor.matchingText.enabled", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Offer a label after placing an arrow");
    // Defaults ON.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ editor: { matchingText: { enabled: false } } });
  });

  test("reflects a disabled affordance", async () => {
    await renderGeneral(
      {
        ...baseSettings,
        editor: { ...baseSettings.editor, matchingText: { enabled: false } }
      },
      healthyStatus
    );
    const toggle = findSwitchIn("Offer a label after placing an arrow");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ editor: { matchingText: { enabled: true } } });
  });
});

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
      { ...baseSettings, general: {
        developerMode: false,
        hotCpuProfilingEnabled: false,
        hotCpuProfilingStartDelayMs: 0,
        hotCpuProfilingTriggerMode: "sustained",
        hotCpuProfilingSlowburnThresholdPercent: 15,
        hotCpuProfilingCaptureHeapSnapshot: false,
        hotCpuProfilingHeapSnapshotLimit: 2,
        launchAtLogin: true
      } },
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
      { ...baseSettings, general: {
        developerMode: false,
        hotCpuProfilingEnabled: false,
        hotCpuProfilingStartDelayMs: 0,
        hotCpuProfilingTriggerMode: "sustained",
        hotCpuProfilingSlowburnThresholdPercent: 15,
        hotCpuProfilingCaptureHeapSnapshot: false,
        hotCpuProfilingHeapSnapshotLimit: 2,
        launchAtLogin: true
      } },
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
  test("shows all four published versions and persists both keys", async () => {
    await renderGeneral(baseSettings, healthyStatus);

    expect(container?.textContent).toContain("v1.2.3");
    expect(container?.textContent).toContain("v1.2.4-prerelease.1");
    expect(container?.textContent).toContain("v1.3.0-beta.2");
    expect(container?.textContent).toContain("Unavailable");

    const prerelease = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("Prerelease")
    );
    await act(async () => {
      prerelease?.click();
    });

    expect(patchMock).toHaveBeenCalledWith({
      updates: { train: "stable", channel: "prerelease" }
    });
  });

  // The track control indexes by the selected train; the train control has
  // to index by the selected track the same way, or it advertises a version
  // that picking that train would not resolve to.
  test("labels each train with the slot the selected track resolves to", async () => {
    await renderGeneral(
      { ...baseSettings, updates: { channel: "prerelease", train: "stable" } },
      healthyStatus
    );
    const trainButton = (label: string): HTMLButtonElement | undefined =>
      Array.from(container!.querySelectorAll("button")).find((el) =>
        el.textContent?.startsWith(label)
      );

    expect(trainButton("Stable")?.textContent).toContain("v1.2.4-prerelease.1");
    expect(trainButton("Stable")?.textContent).not.toContain("v1.2.3");
    // beta.prerelease is unavailable in the fixture even though
    // beta.latest is v1.3.0-beta.2.
    expect(trainButton("Beta")?.textContent).toContain("Unavailable");
    expect(trainButton("Beta")?.textContent).not.toContain("v1.3.0-beta.2");
  });

  test("keeps Beta selectable when its slots are unavailable", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const beta = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("Beta")
    );
    expect(beta).toBeDefined();
    expect(beta?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      beta?.click();
    });

    expect(patchMock).toHaveBeenCalledWith({
      updates: { train: "beta", channel: "latest" }
    });
  });

  test("composes rapid train then track clicks without a stale second write", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const beta = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("Beta")
    );
    const prerelease = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent?.includes("Prerelease")
    );

    await act(async () => {
      beta?.click();
      prerelease?.click();
    });

    expect(patchMock).toHaveBeenNthCalledWith(1, {
      updates: { train: "beta", channel: "latest" }
    });
    expect(patchMock).toHaveBeenNthCalledWith(2, {
      updates: { train: "beta", channel: "prerelease" }
    });
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
        channel: "prerelease",
        train: "stable"
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
