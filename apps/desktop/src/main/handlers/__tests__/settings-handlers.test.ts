// Unit tests for `settings:open`. Exercises the focus-vs-create
// branch against a mocked `window.ts` + bus. No Electron required —
// the handler is pure orchestration over those two modules.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Hoisted spies so `vi.mock` factories can close over them. `vi.hoisted`
// guarantees the assignments run before any imports — which is critical
// because the SUT imports the mocked module at module load.
const mocks = vi.hoisted(() => ({
  createSettingsWindow: vi.fn(),
  findSettingsWindow: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn()
}));

vi.mock("../../window", () => ({
  createSettingsWindow: mocks.createSettingsWindow,
  findSettingsWindow: mocks.findSettingsWindow
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug
  })
}));

// Import AFTER the mocks so the SUT's module-load picks them up.
import { bus } from "../../command-bus";
import { registerSettingsHandlers } from "../settings-handlers";

// One-shot registration. The bus throws on duplicate register, and
// vitest reuses the module across tests in the file, so we register
// once at the top.
registerSettingsHandlers();

type FakeWindow = {
  focus: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  webContents: { executeJavaScript: ReturnType<typeof vi.fn> };
};

function makeFakeWindow(): FakeWindow {
  return {
    focus: vi.fn(),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    restore: vi.fn(),
    webContents: { executeJavaScript: vi.fn(() => Promise.resolve(undefined)) }
  };
}

describe("settings:open", () => {
  beforeEach(() => {
    mocks.createSettingsWindow.mockReset();
    mocks.findSettingsWindow.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("creates a new Settings window when none exists", async () => {
    mocks.findSettingsWindow.mockReturnValue(null);
    const fake = makeFakeWindow();
    mocks.createSettingsWindow.mockReturnValue(fake);

    const result = await bus.dispatch("settings:open", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    expect(mocks.createSettingsWindow).toHaveBeenCalledTimes(1);
    // No focus on the just-created window — `ready-to-show` shows it.
    expect(fake.focus).not.toHaveBeenCalled();
  });

  test("focuses the existing window when one is open (no create)", async () => {
    const fake = makeFakeWindow();
    mocks.findSettingsWindow.mockReturnValue(fake);

    const result = await bus.dispatch("settings:open", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    expect(mocks.createSettingsWindow).not.toHaveBeenCalled();
    expect(fake.focus).toHaveBeenCalledTimes(1);
  });

  test("restores the existing window when minimized", async () => {
    const fake = makeFakeWindow();
    fake.isMinimized.mockReturnValue(true);
    mocks.findSettingsWindow.mockReturnValue(fake);

    await bus.dispatch("settings:open", {}, { principal: "ipc" });

    expect(fake.restore).toHaveBeenCalledTimes(1);
    expect(fake.focus).toHaveBeenCalledTimes(1);
  });

  test("shows the existing window when hidden", async () => {
    const fake = makeFakeWindow();
    fake.isVisible.mockReturnValue(false);
    mocks.findSettingsWindow.mockReturnValue(fake);

    await bus.dispatch("settings:open", {}, { principal: "ipc" });

    expect(fake.show).toHaveBeenCalledTimes(1);
    expect(fake.focus).toHaveBeenCalledTimes(1);
  });

  test("passes `page` as a hash fragment on first create", async () => {
    mocks.findSettingsWindow.mockReturnValue(null);
    mocks.createSettingsWindow.mockReturnValue(makeFakeWindow());

    await bus.dispatch("settings:open", { page: "hotkeys" }, { principal: "ipc" });

    expect(mocks.createSettingsWindow).toHaveBeenCalledWith("page=hotkeys");
  });

  test("navigates the existing window when `page` is supplied", async () => {
    const fake = makeFakeWindow();
    mocks.findSettingsWindow.mockReturnValue(fake);

    await bus.dispatch("settings:open", { page: "about" }, { principal: "ipc" });

    expect(fake.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    const arg = fake.webContents.executeJavaScript.mock.calls[0]![0] as string;
    expect(arg).toContain("page=about");
    expect(arg).toContain("stage=settings");
  });
});
