// `capture:interactive` must refuse a Wayland session BEFORE it touches the
// screen.
//
// The refusal is NARROW, and keeping it narrow is most of what this file is
// for. It covers Wayland with more than one display and nothing else.
//
// It started as every Wayland session, as a stopgap for a misalignment we
// could not explain. The explanation was our own: `enterMenuBarOverlayMode`
// returned early on Linux, so the overlay never went fullscreen and GNOME's
// top bar and dock stayed painted over a window that was otherwise sitting
// at exactly the display origin, 1:1, over a pixel-exact grab. Refusing the
// whole platform for that deleted a working feature. What survives is the
// one thing fullscreen does not fix: `getCursorScreenPoint()` reads 0,0
// wherever the mouse is, and `pickRegion` routes off it to choose a display.
//
// Three things are pinned here, and all three shipped broken once:
//
//  - SCOPE. One display on Wayland reaches the selector; two do not.
//  - ORDERING. The refusal sits ahead of `guardScreenCapture` so a capture we
//    have already decided to refuse never raises the portal's permission
//    prompt, and ahead of `pickRegion` so no selector window is ever shown.
//  - VISIBILITY. A refusal the user cannot see is a dead button. The notice
//    hangs off the refusal itself rather than off `capture-trigger.ts`,
//    because the Library's Quick Capture button and the tray popover's tiles
//    dispatch straight over IPC and never look at the result — which is how
//    the first version of this refusal turned the app's headline button into
//    a no-op on Ubuntu with nothing but a log line to show for it.
//
// MAINTENANCE: the mock wall below mirrors capture-handlers-record-handoff's
// — capture-handlers.ts imports a lot at module load, and vi.mock only
// matches what is imported, so a missing mock fails silently by resolving
// the real module.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCaptureInvocation, type QuickCaptureAction } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  pickRegion: vi.fn(),
  captureRegion: vi.fn(),
  startRecordingFromSelection: vi.fn(),
  readDesktopSettings: vi.fn(),
  getRecordingState: vi.fn(),
  isRecordingActive: vi.fn(),
  showWaylandRefusalNotice: vi.fn(),
  getAllDisplays: vi.fn()
}));

function settingsWith(quickCaptureAction: QuickCaptureAction) {
  return {
    recording: {
      quickCaptureAction,
      includeSystemAudio: true,
      includeMicrophone: false,
      videoCaptureCursor: false,
      imageCaptureCursor: false,
      lastRoutedPermissionFingerprint: "",
      screenCapturePrompted: true
    }
  };
}

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toPNG: () => Buffer.alloc(0)
    }),
    availableFormats: () => [] as string[],
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readText: () => "",
    writeText: () => undefined
  },
  screen: { getAllDisplays: mocks.getAllDisplays },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  })
}));

vi.mock("../../capture/region-selector", () => ({
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: () => [],
  hideSelector: () => undefined
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: mocks.captureRegion,
  captureScreen: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureWindow: async () => ({ ok: false, reason: "validation", message: "stub" })
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: async () => null
}));

vi.mock("../../capture/wayland-refusal-notice", () => ({
  showWaylandRefusalNotice: mocks.showWaylandRefusalNotice
}));

vi.mock("../../recording/record-from-selection", () => ({
  startRecordingFromSelection: mocks.startRecordingFromSelection,
  FALLBACK_RECORDING_DEFAULTS: {
    includeSystemAudio: false,
    includeMicrophone: false,
    videoCaptureCursor: true
  }
}));

vi.mock("../../recording/recording-state", () => ({
  getRecordingState: mocks.getRecordingState,
  isRecordingActive: mocks.isRecordingActive
}));

vi.mock("../settings-handlers", () => ({
  readDesktopSettings: mocks.readDesktopSettings,
  getActiveExportStrategy: async () => "legacy"
}));

vi.mock("../../capture/capture-storage-gate", () => {
  class CapturesLocationFallbackError extends Error {
    readonly pwrSnapError = {
      kind: "capture" as const,
      code: "stub",
      message: "stub"
    };
  }
  return {
    CapturesLocationFallbackError,
    ensureCapturesDirReady: async () => null,
    runWithCapturesDirFallback: async (op: (dir: string) => Promise<unknown>) =>
      await op("/test/captures")
  };
});

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: async () => undefined
}));

vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  findWindowAt: () => null,
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../events", () => ({ broadcastCapturesChanged: () => undefined }));
vi.mock("../../float-over", () => ({ setFloatOverState: () => undefined }));
vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: () => undefined,
  setTrayCountdown: () => undefined
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  reclaimDockIconIfLibraryAlive: () => undefined,
  scheduleDockReclaim: () => undefined
}));
vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));
vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertCapture: () => ({})
}));
vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "",
  putCaptureSource: async () => ({})
}));
vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: async () => ({})
}));
vi.mock("../../persistence/enrichment-repo", () => ({
  getCaptureEnrichment: () => null
}));
vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: async () => "" }));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers();

const originalPlatform = process.platform;
const originalSessionType = process.env.XDG_SESSION_TYPE;
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY;
const originalDisplay = process.env.DISPLAY;

function setSession(
  platform: NodeJS.Platform,
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string; DISPLAY?: string }
): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const key of ["XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY"] as const) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function interactive(
  mode: "auto" | "region" | "window" | "timed" = "auto",
  principal: "ipc" | "rpc" = "ipc"
) {
  return await bus.dispatch(
    "capture:interactive",
    {
      mode,
      invocation: createCaptureInvocation({
        id: "wayland-refusal-test",
        origin: "global_hotkey.quick_capture",
        monotonicNow: () => 0
      })
    },
    { principal }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRecordingState.mockReturnValue({ phase: "idle" });
  mocks.isRecordingActive.mockReturnValue(false);
  mocks.readDesktopSettings.mockResolvedValue(settingsWith("snap"));
  // Two displays by default — the configuration the refusal exists for.
  mocks.getAllDisplays.mockReturnValue([{ id: 1 }, { id: 2 }]);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  setSession(originalPlatform, {
    ...(originalSessionType !== undefined ? { XDG_SESSION_TYPE: originalSessionType } : {}),
    ...(originalWaylandDisplay !== undefined ? { WAYLAND_DISPLAY: originalWaylandDisplay } : {}),
    ...(originalDisplay !== undefined ? { DISPLAY: originalDisplay } : {})
  });
});

describe("capture:interactive on a Wayland session", () => {
  test("a single-display Wayland session reaches the selector", async () => {
    // The regression guard for the blanket refusal. Everything it was
    // justified by has been measured working on Ubuntu 24 except the
    // pointer, and the pointer only decides WHICH display to open on.
    setSession("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
    mocks.getAllDisplays.mockReturnValue([{ id: 1 }]);
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled" });
    const result = await interactive();

    expect(mocks.pickRegion).toHaveBeenCalledTimes(1);
    expect(mocks.showWaylandRefusalNotice).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
  });

  test("refuses a multi-display Wayland session without showing a selector", async () => {
    setSession("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
    const result = await interactive();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("capture");
      expect(result.error.code).toBe("wayland_selector_unsupported");
      // The message is what the user reads in the notice dialog, so it has
      // to name a way forward, not just a refusal.
      expect(result.error.message).toContain("Full Screen");
      expect(result.error.message).toContain("X11");
    }
    expect(mocks.pickRegion).not.toHaveBeenCalled();
  });

  test("refuses every interactive mode on multi-display Wayland, including timed", async () => {
    for (const mode of ["auto", "region", "window", "timed"] as const) {
      setSession("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
      const result = await interactive(mode);
      expect(result.ok, `mode ${mode}`).toBe(false);
      if (!result.ok) expect(result.error.code, `mode ${mode}`).toBe("wayland_selector_unsupported");
    }
    // Timed mode must not have spent its countdown before refusing.
    expect(mocks.pickRegion).not.toHaveBeenCalled();
  });

  test("the user is told — a silent refusal is a dead button", async () => {
    // The regression this pins: the Library's Quick Capture button dispatches
    // over IPC and voids the promise, so when the explanation lived on the
    // trigger helper instead of on the refusal, pressing it did nothing at
    // all. Whatever else changes here, something must reach the screen.
    setSession("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
    await interactive();
    expect(mocks.showWaylandRefusalNotice).toHaveBeenCalledTimes(1);
  });

  test("a programmatic caller gets the Result and no dialog", async () => {
    // An agent over RPC (or MCP, which the bus stops even earlier for want
    // of a local-agent context) has nobody in front of it to dismiss a
    // modal, and a dialog nobody answers would hold the notice's
    // re-entrancy guard shut for every later human trigger.
    setSession("linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" });
    const result = await interactive("auto", "rpc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("wayland_selector_unsupported");
    expect(mocks.showWaylandRefusalNotice).not.toHaveBeenCalled();
  });

  test("an X11 session is left alone — it reaches the selector", async () => {
    setSession("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" });
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled" });
    const result = await interactive();

    expect(mocks.pickRegion).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cancelled");
  });

  test("an unrecognisable Linux environment keeps region capture", async () => {
    // Failing open is deliberate: a detection miss on X11 would delete a
    // working feature, while a miss on Wayland still fails legibly at the
    // grab-geometry check instead of painting a misaligned selector.
    setSession("linux", {});
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled" });
    await interactive();
    expect(mocks.pickRegion).toHaveBeenCalledTimes(1);
  });

  test("a stray WAYLAND_DISPLAY does not disable region capture off Linux", async () => {
    setSession("darwin", { WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland" });
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled" });
    await interactive();
    expect(mocks.pickRegion).toHaveBeenCalledTimes(1);
  });
});
