import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS, type RecordingState } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  appQuit: vi.fn(),
  isRecordingActive: vi.fn(() => false),
  recordingState: { phase: "idle" } as RecordingState
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

import {
  buildTrayContextMenuTemplate,
  disposeTray,
  setTrayHotkeys
} from "../tray";

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
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true
    });
  });

  test("uses the live Quick Capture hotkey and omits Settings/Quit accelerators", () => {
    setTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: "CommandOrControl+Alt+R"
    });

    const template = buildTrayContextMenuTemplate();

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
    setTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: ""
    });

    const template = buildTrayContextMenuTemplate();

    expect(template[0]).toMatchObject({ label: "Quick Capture…" });
    expect(template[0]).not.toHaveProperty("accelerator");
  });

  test("puts Record Video right after Quick Capture, above the rule, with its live hotkey", () => {
    setTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      quickCapture: "CommandOrControl+Shift+C",
      videoCapture: "CommandOrControl+Alt+C"
    });

    const template = buildTrayContextMenuTemplate();

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
    setTrayHotkeys({
      ...DEFAULT_HOTKEYS,
      videoCapture: ""
    });

    const template = buildTrayContextMenuTemplate();

    const recordVideo = template.find((item) => item.label === "Record Video…");
    expect(recordVideo).toBeDefined();
    expect(recordVideo).not.toHaveProperty("accelerator");
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
      displayId: 1
    };
    mocks.isRecordingActive.mockReturnValue(true);

    const template = buildTrayContextMenuTemplate();

    expect(template[0]?.label).toMatch(/^● Recording 01:0[45] — Stop and Save$/);
    expect(template[1]).toMatchObject({ label: "Restart Recording" });
    expect(template[2]).toMatchObject({ label: "Cancel Recording" });
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
});
