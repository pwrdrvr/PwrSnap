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
  platform: NodeJS.Platform = "darwin",
  opts: {
    microphoneStatus?: "granted" | "denied";
    /** Held promise for `permissions:request`, so a test can toggle
     *  again while the OS prompt is still unanswered. */
    microphoneGate?: Promise<void>;
    /** What a non-prompting `permissions:readiness` read reports. */
    readinessMicrophone?: "granted" | "denied";
  } = {}
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
          if (opts.microphoneGate !== undefined) await opts.microphoneGate;
          return { ok: true, value: { status: opts.microphoneStatus ?? "granted" } };
        }
        if (name === "permissions:readiness") {
          return {
            ok: true,
            value: { microphone: opts.readinessMicrophone ?? "denied" }
          };
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
  opts: Parameters<typeof installFakeApi>[2] = {}
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

  // macOS never prompts for the mic on its own, so flipping the switch
  // is the cheapest moment to ask. The ask is a courtesy, not a gate —
  // see the denial test below.
  test("enabling the microphone saves the seed and asks for the grant", async () => {
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
    expect(container?.textContent).not.toContain("macOS hasn't granted microphone access");
  });

  // The seed is what this page owns. A denied grant is settled by the
  // recording selector's microphone chip at capture time (inline Allow /
  // Settings) or by the preflight dialog's own Open System Permissions
  // button — so refusing to write the preference here would only take
  // the preference away, not protect anything.
  test("a denied microphone still persists and offers an optional shortcut", async () => {
    const api = await renderGeneral(baseSettings, healthyStatus, "darwin", {
      microphoneStatus: "denied"
    });
    const toggle = findSwitchIn("Include your microphone");
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "permissions:request")).toBe(true);
    expect(patchMock).toHaveBeenCalledWith({ recording: { includeMicrophone: true } });
    expect(container?.textContent).toContain("macOS hasn't granted microphone access");
    // Not an errand: the row must not read as a blocking prerequisite.
    expect(container?.textContent).not.toContain("action required");
  });

  // AGENTS.md §"Settings substrate": "Late resolutions are dropped."
  // The OS prompt leaves the Settings window interactive, so the user
  // can flip back off before answering it.
  test("a probe that resolves after the user toggles back off is ignored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await renderGeneral(baseSettings, healthyStatus, "darwin", {
      microphoneStatus: "denied",
      microphoneGate: gate
    });
    await act(async () => {
      findSwitchIn("Include your microphone").click();
    });
    // The seed write lands immediately (that is the point of writing
    // before probing), so reflect it back through the context the way a
    // real settings broadcast would — otherwise the switch stays off and
    // the second click repeats the first.
    contextValue = {
      settings: {
        ...baseSettings,
        recording: { ...baseSettings.recording, includeMicrophone: true }
      },
      patch: patchMock as unknown as UseSettingsValue["patch"]
    };
    await act(async () => {
      root?.render(createElement(GeneralPage));
    });
    // Still waiting on the OS prompt — the user changes their mind.
    await act(async () => {
      findSwitchIn("Include your microphone").click();
    });
    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchMock).toHaveBeenCalledWith({ recording: { includeMicrophone: false } });
    // Without the seq guard the stale `denied` lands here and paints a
    // "grant me the microphone" row under a switch that reads off.
    expect(container?.textContent).not.toContain("macOS hasn't granted microphone access");
  });

  // The row exists so the user can go settle the grant elsewhere. If it
  // cannot notice that they did, it is a dead end that outlives its own
  // reason for existing.
  test("the shortcut row clears once the grant is settled outside the window", async () => {
    await renderGeneral(baseSettings, healthyStatus, "darwin", {
      microphoneStatus: "denied",
      readinessMicrophone: "granted"
    });
    await act(async () => {
      findSwitchIn("Include your microphone").click();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("macOS hasn't granted microphone access");

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).not.toContain("macOS hasn't granted microphone access");
  });

  test("turning the microphone back off clears the shortcut row and persists", async () => {
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
    expect(container?.textContent).not.toContain("macOS hasn't granted microphone access");
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
    expect(container?.textContent).toContain("Rides the Screen Recording grant");
    expect(container?.textContent).not.toContain("recording refuses to start");
  });

  // The audio card has to say BOTH halves now that the selector's source
  // chips exist: these switches are the default, and a single take can
  // change its mind without changing them. The card previously promised
  // only the first half — correct while it was the sole consumer of the
  // pair, and stale the moment the chips shipped. This test used to
  // assert the second half was ABSENT, for exactly that reason; it
  // asserts the opposite now, which is what makes the copy and the
  // feature land together instead of one drifting behind the other.
  test("the audio card names the default AND the per-take override", async () => {
    await renderGeneral(baseSettings, healthyStatus);
    const card = Array.from(container?.querySelectorAll(".pss__card") ?? []).find((el) =>
      el.textContent?.includes("Include your microphone")
    );
    expect(card).toBeDefined();
    const copy = card?.textContent ?? "";
    expect(copy).toContain("The default for new recordings");
    // The key for each source, on the row that source owns.
    expect(copy).toContain("Press A in the capture selector");
    expect(copy).toContain("Press M in the capture selector");
    // And it must stay explicit that overriding does not rewrite the
    // default — the chips deliberately do not write back.
    expect(copy).toContain("without changing this default");
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
