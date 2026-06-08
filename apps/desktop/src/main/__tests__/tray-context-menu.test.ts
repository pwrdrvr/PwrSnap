import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HOTKEYS } from "@pwrsnap/shared";

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

describe("tray context menu", () => {
  beforeEach(() => {
    disposeTray();
    mocks.appQuit.mockClear();
    mocks.isRecordingActive.mockReset();
    mocks.isRecordingActive.mockReturnValue(false);
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
});
