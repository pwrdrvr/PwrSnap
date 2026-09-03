// UpdatesPage — the four-slot release matrix.
//
// What this pins:
//   • all four published versions are on screen at once, each on its own
//     tile — the reporting bug that motivated the rewrite was Beta reading
//     "Unavailable" while Beta/Prerelease held a shipped alpha;
//   • a tile click writes BOTH axes in one patch (main derives the
//     `selectionSource: "user"` pin from that write, so the renderer must
//     never send a half selection);
//   • the tile matching the running binary is marked Installed;
//   • an unpinned selection says so, a pinned one stays quiet;
//   • check / restart / retry still dispatch the bus verbs they did on
//     General, where this card used to live.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { EVENT_CHANNELS, type AppUpdateStatus, type Settings } from "@pwrsnap/shared";
import { UpdatesPage } from "../UpdatesPage";
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
  experimental: { processSplit: true, dpiAwareExport: false, allowRetinaExport: true },
  appearance: { theme: "system" },
  updates: { channel: "latest", train: "stable", selectionSource: "inferred" },
  storage: { filenameTimestampZone: "local", capturesLocation: "documents" },
  recording: {
    quickCaptureAction: "ask",
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

/** Beta Latest is deliberately EMPTY while Beta Prerelease carries a
 *  build — that is the exact shape the old two-control UI mislabelled. */
const RELEASES = {
  fetchedAt: 1,
  stable: {
    latest: { version: "v1.0.3" },
    prerelease: { version: "v1.0.3" }
  },
  beta: {
    latest: { unavailableReason: "No beta release found." },
    prerelease: { version: "v1.1.0-alpha.6" }
  }
};

function installFakeApi(appVersion = "1.1.0-alpha.4"): {
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
} {
  const calls: { name: string; req: unknown }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: {
      platform: "darwin",
      dispatch: async (name: string, req: unknown): Promise<AnyResult> => {
        calls.push({ name, req });
        if (name === "app:update:releases") return { ok: true, value: RELEASES };
        if (name === "app:version") {
          return { ok: true, value: { version: appVersion, electron: "38.0.0", chrome: "1", node: "24" } };
        }
        if (name === "app:update:status") {
          return { ok: true, value: { status: "idle" } satisfies AppUpdateStatus };
        }
        if (name === "app:update:check") {
          return { ok: true, value: { status: "available", version: "1.1.0-alpha.6" } };
        }
        if (name === "app:update:install") return { ok: true, value: { status: "restarting" } };
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

async function renderUpdates(
  settings: Settings = baseSettings,
  appVersion = "1.1.0-alpha.4"
): Promise<{
  calls: { name: string; req: unknown }[];
  pushEvent: (channel: string, payload: unknown) => void;
}> {
  const api = installFakeApi(appVersion);
  contextValue = { settings, patch: patchMock as unknown as UseSettingsValue["patch"] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(UpdatesPage));
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

/** Tiles are addressed by their aria-label, which is the only thing that
 *  identifies a slot independently of whatever version it resolved to. */
function slot(train: string, channel: string): HTMLButtonElement {
  const tile = Array.from(container!.querySelectorAll<HTMLButtonElement>("button.pss__slot")).find(
    (el) => el.getAttribute("aria-label")?.startsWith(`${train} ${channel} —`) === true
  );
  if (!tile) throw new Error(`no ${train} ${channel} tile`);
  return tile;
}

describe("UpdatesPage — release matrix", () => {
  test("renders all four slots with their own resolved version", async () => {
    await renderUpdates();

    expect(slot("Stable", "Latest").textContent).toContain("v1.0.3");
    expect(slot("Stable", "Prerelease").textContent).toContain("v1.0.3");
    expect(slot("Beta", "Prerelease").textContent).toContain("v1.1.0-alpha.6");
    // The one empty slot says WHY, and says it on itself rather than
    // hiding the sibling that does have a build.
    expect(slot("Beta", "Latest").textContent).toContain("Unavailable");
    expect(slot("Beta", "Latest").textContent).toContain("No beta release found.");
  });

  test("an empty Beta Latest does not hide the alpha next to it", async () => {
    // Regression for the two-control layout: with the track control on
    // Latest, the Beta control's only label was Beta/Latest, so a shipped
    // alpha read as "Beta — Unavailable".
    await renderUpdates({
      ...baseSettings,
      updates: { channel: "latest", train: "beta", selectionSource: "user" }
    });
    expect(slot("Beta", "Latest").classList.contains("is-selected")).toBe(true);
    expect(slot("Beta", "Prerelease").textContent).toContain("v1.1.0-alpha.6");
  });

  test("marks the running build's slot as installed", async () => {
    await renderUpdates(baseSettings, "1.1.0-alpha.6");
    expect(slot("Beta", "Prerelease").textContent).toContain("Installed");
    expect(slot("Stable", "Latest").textContent).not.toContain("Installed");
  });

  test("a tile click writes both axes in one patch", async () => {
    await renderUpdates();
    await act(async () => {
      slot("Beta", "Prerelease").click();
    });
    expect(patchMock).toHaveBeenCalledWith({
      updates: { train: "beta", channel: "prerelease" }
    });
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  test("marks the selected slot and keeps empty slots clickable", async () => {
    await renderUpdates({
      ...baseSettings,
      updates: { channel: "prerelease", train: "beta", selectionSource: "user" }
    });
    expect(slot("Beta", "Prerelease").getAttribute("aria-checked")).toBe("true");
    expect(slot("Stable", "Latest").getAttribute("aria-checked")).toBe("false");

    const empty = slot("Beta", "Latest");
    expect(empty.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      empty.click();
    });
    expect(patchMock).toHaveBeenCalledWith({
      updates: { train: "beta", channel: "latest" }
    });
  });

  test("says the selection is still inferred until it is pinned", async () => {
    await renderUpdates();
    expect(container?.textContent).toContain("Following the build you installed");

    await act(async () => {
      root?.unmount();
    });
    container?.remove();

    await renderUpdates({
      ...baseSettings,
      updates: { channel: "latest", train: "stable", selectionSource: "user" }
    });
    expect(container?.textContent).not.toContain("Following the build you installed");
  });
});

describe("UpdatesPage — check and install", () => {
  test("manual check dispatches app:update:check and shows the result", async () => {
    const { calls } = await renderUpdates();
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.textContent === "Check for Updates"
    );

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(calls.some((c) => c.name === "app:update:check")).toBe(true);
    expect(container?.textContent).toContain("Update available: v1.1.0-alpha.6");
  });

  test("downloaded update status switches the action to restart", async () => {
    const api = await renderUpdates();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "downloaded",
        version: "1.1.0-alpha.6"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("Update ready: v1.1.0-alpha.6");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.getAttribute("aria-label") === "Restart to Update (1.1.0-alpha.6)"
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "app:update:install")).toBe(true);
  });

  test("failed install status shows a retry action", async () => {
    const api = await renderUpdates();

    await act(async () => {
      api.pushEvent(EVENT_CHANNELS.appUpdateStatus, {
        status: "install-failed",
        version: "1.1.0-alpha.6",
        currentVersion: "1.1.0-alpha.4",
        attemptedAt: "2026-09-03T12:00:00.000Z",
        channel: "prerelease",
        train: "beta"
      } satisfies AppUpdateStatus);
    });

    expect(container?.textContent).toContain("did not finish installing");
    const button = Array.from(container!.querySelectorAll("button")).find(
      (el) => el.getAttribute("aria-label") === "Retry Update (1.1.0-alpha.6)"
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(api.calls.some((c) => c.name === "app:update:install")).toBe(true);
  });
});
