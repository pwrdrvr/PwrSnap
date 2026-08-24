import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_HOTKEYS,
  type HotkeyRegistrationStatusSnapshot,
  type Settings
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  appQuit: vi.fn(),
  isRecordingActive: vi.fn(() => false)
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
  isRecordingActive: mocks.isRecordingActive,
  subscribeToRecordingState: vi.fn()
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

describe("tray context menu", () => {
  beforeEach(() => {
    disposeTray();
    mocks.appQuit.mockClear();
    mocks.isRecordingActive.mockReset();
    mocks.isRecordingActive.mockReturnValue(false);
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
});
