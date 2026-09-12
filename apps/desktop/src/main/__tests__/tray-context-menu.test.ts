import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  DEFAULT_HOTKEYS,
  type HotkeyRegistrationStatusSnapshot,
  type RecordingState,
  type Settings
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  appQuit: vi.fn(),
  isRecordingActive: vi.fn(() => false),
  recordingState: { phase: "idle" } as RecordingState,
  canConfirmDiscard: vi.fn(() => true),
  requestDiscardConfirmation: vi.fn(() => true),
  dispatch: vi.fn(async () => ({ ok: true, value: undefined }))
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
    quit: mocks.appQuit
  },
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template }))
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn()
    }))
  },
  screen: {
    getDisplayMatching: vi.fn(),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 }))
  },
  Tray: vi.fn()
}));

vi.mock("../window", () => ({
  createTrayWindow: vi.fn(),
  positionTrayWindow: vi.fn()
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

vi.mock("../recording/recording-state", () => ({
  getRecordingState: () => mocks.recordingState,
  isRecordingActive: mocks.isRecordingActive,
  subscribeToRecordingState: vi.fn()
}));

vi.mock("../recording/recording-controller", () => ({
  canRecordingControllerConfirmDiscard: mocks.canConfirmDiscard,
  requestRecordingDiscardConfirmation: mocks.requestDiscardConfirmation
}));

vi.mock("../command-bus", () => ({
  bus: { dispatch: mocks.dispatch }
}));

import {
  buildTrayContextMenuTemplate,
  disposeTray,
  setTrayHotkeys
} from "../tray";

function registrationStatus(
  hotkeys: Settings["hotkeys"],
  overrides: Partial<HotkeyRegistrationStatusSnapshot> = {}
): HotkeyRegistrationStatusSnapshot {
  const status = {} as HotkeyRegistrationStatusSnapshot;
  for (const key of Object.keys(hotkeys) as Array<keyof Settings["hotkeys"]>) {
    const accelerator = hotkeys[key];
    status[key] = {
      key,
      accelerator,
      state: accelerator === "" ? "unbound" : "active",
      failure: null
    };
  }
  return { ...status, ...overrides };
}

function setActiveTrayHotkeys(hotkeys: Settings["hotkeys"]): void {
  const status = registrationStatus(hotkeys);
  setTrayHotkeys(hotkeys, () => status);
}

const originalPlatform = process.platform;

describe("tray context menu", () => {
  beforeEach(() => {
    // Context-menu control tests exercise a real supported backend. Linux is
    // intentionally unsupported and therefore truthfully exposes no controls.
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    disposeTray();
    mocks.appQuit.mockClear();
    mocks.isRecordingActive.mockReset();
    mocks.isRecordingActive.mockReturnValue(false);
    mocks.recordingState = { phase: "idle" };
    mocks.canConfirmDiscard.mockReset();
    mocks.canConfirmDiscard.mockReturnValue(true);
    mocks.requestDiscardConfirmation.mockReset();
    mocks.requestDiscardConfirmation.mockReturnValue(true);
    mocks.dispatch.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true
    });
  });

  test("uses the live Quick Capture hotkey and omits Settings/Quit accelerators", () => {
    setActiveTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: "CommandOrControl+Alt+R"
    });

    const template = buildTrayContextMenuTemplate(undefined, "darwin");

    expect(template[0]).toMatchObject({
      label: "Quick Capture…",
      accelerator: "CommandOrControl+Alt+R"
    });

    const settings = template.find((item) => item.label === "Settings…");
    expect(settings).toBeDefined();
    expect(settings).not.toHaveProperty("accelerator");

    const quit = template.at(-1);
    expect(quit).toMatchObject({ label: "Quit PwrSnap" });
    expect(quit).not.toHaveProperty("accelerator");
    expect(quit).not.toHaveProperty("role");
  });

  test("hides the Quick Capture accelerator when the hotkey is unbound", () => {
    setActiveTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: ""
    });

    const template = buildTrayContextMenuTemplate(undefined, "darwin");

    expect(template[0]).toMatchObject({ label: "Quick Capture…" });
    expect(template[0]).not.toHaveProperty("accelerator");
  });

  test("puts Record Video right after Quick Capture, above the rule, with its live hotkey", () => {
    setActiveTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: "CommandOrControl+Shift+C",
      videoCapture: "CommandOrControl+Alt+C"
    });

    const template = buildTrayContextMenuTemplate(undefined, "darwin");

    // The two headline verbs sit together, snap then record...
    expect(template[0]).toMatchObject({ label: "Quick Capture…" });
    expect(template[1]).toMatchObject({
      label: "Record Video…",
      accelerator: "CommandOrControl+Alt+C"
    });
    // ...immediately above the first separator (the horizontal rule).
    expect(template[2]).toMatchObject({ type: "separator" });
  });

  test("hides the Record Video accelerator when the hotkey is unbound", () => {
    setActiveTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      videoCapture: ""
    });

    const template = buildTrayContextMenuTemplate(undefined, "darwin");

    const recordVideo = template.find((item) => item.label === "Record Video…");
    expect(recordVideo).toBeDefined();
    expect(recordVideo).not.toHaveProperty("accelerator");
  });

  test("keeps Windows and Linux tray accelerators display-only", () => {
    setActiveTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: "Control+Shift+C",
      videoCapture: "Control+Alt+C"
    });

    const windowsTemplate = buildTrayContextMenuTemplate(undefined, "win32");
    expect(windowsTemplate[0]).toMatchObject({
      accelerator: "Control+Shift+C",
      registerAccelerator: false
    });
    expect(windowsTemplate[1]).toMatchObject({
      accelerator: "Control+Alt+C",
      registerAccelerator: false
    });

    const linuxTemplate = buildTrayContextMenuTemplate(undefined, "linux");
    expect(linuxTemplate[0]).toMatchObject({
      accelerator: "Control+Shift+C",
      registerAccelerator: false
    });
    expect(linuxTemplate[1]).toMatchObject({
      accelerator: "Control+Alt+C",
      registerAccelerator: false
    });

    const macTemplate = buildTrayContextMenuTemplate(undefined, "darwin");
    expect(macTemplate[0]).not.toHaveProperty("registerAccelerator");
    expect(macTemplate[1]).not.toHaveProperty("registerAccelerator");
  });

  test("omits legacy Command spelling on Windows even if status is stale-active", () => {
    const hotkeys = {
      ...DEFAULT_HOTKEYS,
      quickCapture: "Command+Shift+C"
    };
    setActiveTrayHotkeys(hotkeys);

    const template = buildTrayContextMenuTemplate(undefined, "win32");

    expect(template[0]).not.toHaveProperty("accelerator");
  });

  test("omits a valid persisted chord when boot registration is inactive", () => {
    const hotkeys = {
      ...DEFAULT_HOTKEYS,
      quickCapture: "Control+Shift+C"
    };
    const status = registrationStatus(hotkeys, {
      quickCapture: {
        key: "quickCapture",
        accelerator: hotkeys.quickCapture,
        state: "inactive",
        failure: {
          code: "unavailable",
          message: "Quick Capture is already owned by another application."
        }
      }
    });
    setTrayHotkeys(hotkeys, () => status);

    const template = buildTrayContextMenuTemplate(undefined, "win32");

    expect(template[0]).not.toHaveProperty("accelerator");
  });

  // Open Library is the newest item to carry a conditional accelerator.
  // It ships unbound, so the interesting cases are the two ways a BOUND
  // chord must still not be advertised — the same fiction the tooltip's
  // hard-coded "(⌘⇧L)" was, one surface over.
  test("shows Open Library's accelerator only while main owns the registration", () => {
    const hotkeys = {
      ...DEFAULT_HOTKEYS,
      openLibrary: "Control+Alt+Shift+L"
    };
    setActiveTrayHotkeys(hotkeys);

    const active = buildTrayContextMenuTemplate(undefined, "win32").find(
      (item) => item.label === "Open Library"
    );
    expect(active).toMatchObject({
      accelerator: "Control+Alt+Shift+L",
      // Display-only off macOS: PwrSnap's transactional manager already
      // owns this chord globally, and letting Electron install a second
      // menu-owned registration for it is a double claim.
      registerAccelerator: false
    });

    setTrayHotkeys(
      hotkeys,
      () => registrationStatus(hotkeys, {
        openLibrary: {
          key: "openLibrary",
          accelerator: hotkeys.openLibrary,
          state: "inactive",
          failure: { code: "unavailable", message: "Taken by another application." }
        }
      })
    );

    const refused = buildTrayContextMenuTemplate(undefined, "win32").find(
      (item) => item.label === "Open Library"
    );
    expect(refused).not.toHaveProperty("accelerator");
  });

  test("Open Library renders bare at its shipped unbound default", () => {
    setActiveTrayHotkeys({ ...DEFAULT_HOTKEYS });

    const item = buildTrayContextMenuTemplate(undefined, "darwin").find(
      (entry) => entry.label === "Open Library"
    );
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty("accelerator");
  });

  test("normalizes an active Windows accelerator before displaying it", () => {
    const hotkeys = {
      ...DEFAULT_HOTKEYS,
      quickCapture: "ctrl+shift+c"
    };
    setActiveTrayHotkeys(hotkeys);

    const template = buildTrayContextMenuTemplate(undefined, "win32");

    expect(template[0]).toMatchObject({
      accelerator: "Control+Shift+C",
      registerAccelerator: false
    });
  });

  test("preserves an active native Command accelerator on macOS", () => {
    const hotkeys = {
      ...DEFAULT_HOTKEYS,
      quickCapture: "Command+Shift+C"
    };
    setActiveTrayHotkeys(hotkeys);

    const template = buildTrayContextMenuTemplate(undefined, "darwin");

    expect(template[0]).toMatchObject({ accelerator: "Command+Shift+C" });
    expect(template[0]).not.toHaveProperty("registerAccelerator");
  });

  test("offers cancel, not stop, while the recording lead-in owns the transition", () => {
    mocks.recordingState = {
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 2,
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1
    };
    mocks.isRecordingActive.mockReturnValue(true);

    const template = buildTrayContextMenuTemplate();

    expect(template[0]).toMatchObject({ label: "Cancel recording start (2)" });
    expect(template.some((item) => item.label?.includes("Stop"))).toBe(false);
    expect(template.find((item) => item.label === "Record Video…")).toMatchObject({
      enabled: false
    });
  });

  test("shows timing and real controls only during active capture", () => {
    mocks.recordingState = {
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1,
      capabilities: { systemAudio: false, microphone: false }
    };
    mocks.isRecordingActive.mockReturnValue(true);

    const template = buildTrayContextMenuTemplate();

    expect(template[0]?.label).toMatch(/^● Recording 01:0[45] — Stop and Save$/);
    // Ellipsis: both discard the take, so both ask first — on the HUD,
    // which is the only confirmation surface the recorder cannot see.
    expect(template[1]).toMatchObject({ label: "Restart Recording…" });
    expect(template[2]).toMatchObject({ label: "Cancel Recording…" });
  });

  test.each([
    [{ phase: "stopping", sessionId: "rec-1" }, "Finalizing recording…"],
    [{ phase: "processing", sessionId: "rec-1" }, "Processing recording…"]
  ] as const)("disables actions during $phase", (state, label) => {
    mocks.recordingState = state;
    mocks.isRecordingActive.mockReturnValue(true);

    const template = buildTrayContextMenuTemplate();

    expect(template[0]).toMatchObject({ label, enabled: false });
    expect(template.some((item) => item.label === "Cancel Recording")).toBe(false);
  });

  test("keeps Record Video disabled while durable failure owns the attempt", () => {
    mocks.recordingState = {
      phase: "failed",
      sessionId: "failed-1",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    };
    mocks.isRecordingActive.mockReturnValue(false);

    const template = buildTrayContextMenuTemplate();

    expect(template.find((item) => item.label === "Record Video…")).toMatchObject({
      enabled: false
    });
  });

  test("a destructive recording item arms the HUD confirm instead of acting", () => {
    mocks.recordingState = {
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1,
      capabilities: { systemAudio: false, microphone: false }
    };
    mocks.isRecordingActive.mockReturnValue(true);
    const template = buildTrayContextMenuTemplate();

    template.find((item) => item.label === "Restart Recording…")?.click?.(
      ...([] as unknown as Parameters<NonNullable<MenuItemConstructorOptions["click"]>>)
    );

    expect(mocks.requestDiscardConfirmation).toHaveBeenCalledWith("restart");
    // The take is not discarded until the user presses Confirm on the
    // HUD — the tray only routes them there.
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  test("Stop and Save acts immediately — only discarding needs a confirmation", () => {
    mocks.recordingState = {
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1,
      capabilities: { systemAudio: false, microphone: false }
    };
    mocks.isRecordingActive.mockReturnValue(true);
    const template = buildTrayContextMenuTemplate();

    template[0]?.click?.(
      ...([] as unknown as Parameters<NonNullable<MenuItemConstructorOptions["click"]>>)
    );

    expect(mocks.dispatch).toHaveBeenCalledWith("recording:stop", {}, { principal: "ipc" });
    expect(mocks.requestDiscardConfirmation).not.toHaveBeenCalled();
  });

  test("with no HUD to confirm on, the tray offers Stop and Save but nothing destructive", () => {
    mocks.recordingState = {
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1,
      capabilities: { systemAudio: false, microphone: false }
    };
    mocks.isRecordingActive.mockReturnValue(true);
    // The HUD renderer crashed past its retry budget. Discarding a take
    // is unrecoverable and has nowhere left to ask; keeping one is
    // always safe, so Stop must survive.
    mocks.canConfirmDiscard.mockReturnValue(false);

    const template = buildTrayContextMenuTemplate();

    expect(template[0]?.label).toMatch(/Stop and Save$/);
    expect(template.some((item) => item.label?.startsWith("Restart Recording"))).toBe(false);
    expect(template.some((item) => item.label?.startsWith("Cancel Recording"))).toBe(false);
  });
});

// A confirmation raised from the main process is recorded: it has no
// `setContentProtection`, and it is centred on the display, so it is
// inside almost any recorded rect. On Windows FFmpeg `gdigrab` reads
// the desktop DC and captures it no matter where it sits. The tray
// therefore owns no confirmation UI of its own during a take.
//
// Same shape of guard as `tray-instant-hide.test.ts` — the property is
// "this source never calls that", which no render test can observe.
describe("tray.ts source — no unprotected confirmation surface during a take", () => {
  const source = readFileSync(fileURLToPath(new URL("../tray.ts", import.meta.url)), "utf8");
  // Prose describes the call this file forbids; it must not be mistaken
  // for the call itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("the comment stripper still leaves the real tray source to search", () => {
    expect(code).toMatch(/export function buildTrayContextMenuTemplate/);
    expect(code).toMatch(/bus\.dispatch\("recording:stop"/);
  });

  test("the tray raises no native dialog", () => {
    expect(code).not.toMatch(/dialog\s*\.\s*showMessageBox/);
  });

  test("the tray does not import Electron's dialog module at all", () => {
    const electronImport = /import\s*\{([\s\S]*?)\}\s*from\s*"electron";/.exec(source);
    expect(electronImport).not.toBeNull();
    expect(electronImport![1]).not.toMatch(/\bdialog\b/);
  });
});
