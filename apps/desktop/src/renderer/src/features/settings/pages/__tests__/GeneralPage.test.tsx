// GeneralPage — appearance, capture defaults, and the Launch-at-login card.
// The release train/track moved to __tests__/UpdatesPage.test.tsx.
//
// Launch at login:
//   • the toggle patches `general.launchAtLogin` through the settings
//     substrate (no side channels);
//   • the page re-reads `app:launchAtLoginStatus` and surfaces the
//     OS-side divergence states (blocked-by-OS, dev-build skip);
//   • the blocked state's recovery button dispatches
//     `app:openLoginItemsSettings`.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { type LaunchAtLoginStatus, type Settings } from "@pwrsnap/shared";
import { GeneralPage } from "../GeneralPage";
import type { UseSettingsValue } from "../../useSettings";
import { baseSettings } from "../../__tests__/settings-fixture";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});


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

  test("microphone toggle patches recording.includeMicrophone", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const toggle = findSwitchIn("Include your microphone");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ recording: { includeMicrophone: true } });
  });

  test("both sources off hides the System Permissions jump", async () => {
    // The pointer only earns its row once the user has opted in — with
    // both sources off there's no permission to go check.
    await renderGeneral(baseSettings, healthyStatus);
    expect(container?.textContent).not.toContain("Audio permissions");
  });

  test("opting a source in surfaces the System Permissions jump", async () => {
    // `recording:start` hard-fails when a requested source isn't
    // granted (recording-handlers.ts preflight), so send the user to the
    // grant surface at opt-in time rather than mid-take.
    await renderGeneral(
      {
        ...baseSettings,
        recording: { ...baseSettings.recording, includeMicrophone: true }
      },
      healthyStatus
    );
    expect(container?.textContent).toContain("Audio permissions");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Open System Permissions"
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(window.location.hash).toContain("page=system-permissions");
  });

  test("Windows says recordings are video-only and hides the permissions jump", async () => {
    // The Windows FFmpeg backend captures screen video only and logs a
    // warning when either toggle is on (recording-service.ts) — the copy
    // has to say so instead of implying audio that gets dropped.
    await renderGeneral(
      {
        ...baseSettings,
        recording: { ...baseSettings.recording, includeSystemAudio: true }
      },
      healthyStatus,
      "win32"
    );
    expect(container?.textContent).toContain("Windows recordings are video-only for now");
    expect(container?.textContent).not.toContain("Audio permissions");
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
