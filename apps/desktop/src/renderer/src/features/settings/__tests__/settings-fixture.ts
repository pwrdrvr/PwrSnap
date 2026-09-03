// Shared `Settings` fixture for renderer tests.
//
// Every page/component test that mounts something reading settings needs a
// complete `Settings` value, and each one used to carry its own ~70-line
// copy. Adding ONE field then meant editing eight files — which is exactly
// what `updates.selectionSource` cost. One export instead, spread-and-
// override at the call site:
//
//   renderPage({ ...baseSettings, updates: { ...baseSettings.updates, train: "beta" } })
//
// Keep it at the DEFAULTS a fresh install would produce, so a test that
// overrides nothing is testing the out-of-the-box state.
//
// Six older copies survive (SettingsContext, useSettings, DeveloperPage,
// ExperimentalPage, FloatOver, EditorChrome) — each differs from this one
// in a field its own tests may lean on, so they migrate one at a time
// rather than in a blind sweep.

import type { Settings } from "@pwrsnap/shared";

export const baseSettings: Settings = {
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
