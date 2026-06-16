// ExperimentalPage — the opt-in soak toggles, moved off General.
// Locks the two things most likely to regress in a relocation:
//   • the macOS gate — Two-process mode is hidden off darwin (the boot
//     is always single-process there, so the switch would be a no-op);
//   • the nested Allow Retina row — only shown once DPI-aware export is
//     on (it's meaningless otherwise);
// plus that each toggle writes the right `experimental.*` field through
// the settings substrate, and that before the snapshot lands the
// switches are inert (no clickable control until `settings !== null`).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";
import { ExperimentalPage } from "../ExperimentalPage";
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
  experimental: { processSplit: false, dpiAwareExport: false, allowRetinaExport: true },
  appearance: { theme: "system" },
  updates: { channel: "latest" },
  storage: { filenameTimestampZone: "local" },
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

function withExperimental(experimental: Settings["experimental"]): Settings {
  return { ...baseSettings, experimental };
}

const patchMock = vi.fn(async (): Promise<void> => undefined);

let contextValue: Pick<UseSettingsValue, "settings" | "patch">;

vi.mock("../../SettingsContext", () => ({
  useSettingsContext: (): Pick<UseSettingsValue, "settings" | "patch"> => contextValue
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, "pwrsnapApi", {
    configurable: true,
    value: { platform }
  });
}

async function renderExperimental(
  settings: Settings | null,
  platform: NodeJS.Platform = "darwin"
): Promise<void> {
  setPlatform(platform);
  contextValue = { settings, patch: patchMock as unknown as UseSettingsValue["patch"] };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(ExperimentalPage));
  });
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

function findSwitchIn(label: string): HTMLButtonElement {
  const row = Array.from(container!.querySelectorAll(".pss__row")).find((el) =>
    el.textContent?.includes(label)
  );
  const toggle = row?.querySelector<HTMLButtonElement>("button[role='switch']");
  if (!toggle) throw new Error(`no switch found in row "${label}"`);
  return toggle;
}

describe("ExperimentalPage — platform gating", () => {
  test("shows the Two-process card on macOS", async () => {
    await renderExperimental(baseSettings, "darwin");
    expect(container?.textContent).toContain("Two-process mode");
    expect(container?.textContent).toContain("DPI-aware export");
  });

  test("hides the Two-process card off macOS, keeps DPI-aware export", async () => {
    await renderExperimental(baseSettings, "win32");
    expect(container?.textContent).not.toContain("Two-process mode");
    expect(container?.textContent).toContain("DPI-aware export");
  });
});

describe("ExperimentalPage — Allow Retina gating", () => {
  test("hidden when DPI-aware export is off", async () => {
    await renderExperimental(
      withExperimental({ processSplit: false, dpiAwareExport: false, allowRetinaExport: true })
    );
    expect(container?.textContent).not.toContain("Allow Retina export");
  });

  test("shown when DPI-aware export is on", async () => {
    await renderExperimental(
      withExperimental({ processSplit: false, dpiAwareExport: true, allowRetinaExport: true })
    );
    expect(container?.textContent).toContain("Allow Retina export");
  });
});

describe("ExperimentalPage — toggles patch the substrate", () => {
  test("DPI-aware export patches experimental.dpiAwareExport", async () => {
    await renderExperimental(baseSettings);
    const toggle = findSwitchIn("Scale exports by display resolution");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ experimental: { dpiAwareExport: true } });
  });

  test("Two-process mode patches experimental.processSplit (macOS)", async () => {
    await renderExperimental(baseSettings, "darwin");
    const toggle = findSwitchIn("Run the capture agent and Library as separate processes");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ experimental: { processSplit: true } });
  });

  test("Allow Retina export patches experimental.allowRetinaExport", async () => {
    await renderExperimental(
      withExperimental({ processSplit: false, dpiAwareExport: true, allowRetinaExport: true })
    );
    const toggle = findSwitchIn("Allow Retina export");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle.click();
    });
    expect(patchMock).toHaveBeenCalledWith({ experimental: { allowRetinaExport: false } });
  });
});

describe("ExperimentalPage — pre-snapshot", () => {
  test("switches are inert until settings load (no clickable control)", async () => {
    await renderExperimental(null, "darwin");
    // Cards still render (the header + labels are static)…
    expect(container?.textContent).toContain("DPI-aware export");
    // …but with no snapshot the Switch renders a non-interactive role=img,
    // never a clickable role=switch button.
    expect(container?.querySelector("button[role='switch']")).toBeNull();
  });
});
