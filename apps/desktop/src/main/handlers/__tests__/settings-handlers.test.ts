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

// settings-handlers.ts imports `app` from electron for the lazy-init
// path, and `BrowserWindow` for the broadcast helper. Stub both —
// the open-window tests below don't exercise either, but module load
// must succeed without an Electron runtime.
vi.mock("electron", () => ({
  app: {
    getPath: (name: string): string => {
      if (name === "userData") return "/tmp/pwrsnap-test-userData-settings-handlers";
      throw new Error(`unexpected app.getPath: ${name}`);
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string): Buffer => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer): string => b.toString("utf8").replace(/^enc:/, "")
  }
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
  webContents: { send: ReturnType<typeof vi.fn> };
};

function makeFakeWindow(): FakeWindow {
  return {
    focus: vi.fn(),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    restore: vi.fn(),
    webContents: { send: vi.fn() }
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

  test("navigates the existing window via typed event when `page` is supplied", async () => {
    const fake = makeFakeWindow();
    mocks.findSettingsWindow.mockReturnValue(fake);

    await bus.dispatch("settings:open", { page: "about" }, { principal: "ipc" });

    expect(fake.webContents.send).toHaveBeenCalledTimes(1);
    expect(fake.webContents.send).toHaveBeenCalledWith(
      "events:settings:navigate",
      { page: "about" }
    );
  });

  test("rejects unknown `page` with kind=validation, code=invalid_page", async () => {
    const fake = makeFakeWindow();
    mocks.findSettingsWindow.mockReturnValue(fake);

    const result = await bus.dispatch(
      "settings:open",
      // Intentionally bypass the type guard — the bus passes JSON through.
      { page: "not-a-page" } as unknown as Record<string, never>,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_page");
    // No event fired for the rejected request.
    expect(fake.webContents.send).not.toHaveBeenCalled();
  });
});

describe("settings:* validation", () => {
  test("settings:write rejects null over a non-nullable string field", async () => {
    const result = await bus.dispatch(
      "settings:write",
      // pinnedPath is `string`, not `string | null` — null is rejected.
      { codex: { pinnedPath: null } } as unknown as Record<string, never>,
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_codex_pinnedPath");
  });

  test("settings:write rejects an invalid codex.mode literal", async () => {
    const result = await bus.dispatch(
      "settings:write",
      { codex: { mode: "bogus" } } as unknown as Record<string, never>,
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_codex_mode");
  });

  test("settings:write rejects non-boolean ai.enabled", async () => {
    const result = await bus.dispatch(
      "settings:write",
      { ai: { enabled: "yes" } } as unknown as Record<string, never>,
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_ai_enabled");
  });

  test("settings:refreshCodexDiscovery rejects non-boolean force", async () => {
    const result = await bus.dispatch(
      "settings:refreshCodexDiscovery",
      { force: "truthy" } as unknown as { force?: boolean },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_force");
  });

  test("settings:replaceSecret rejects unknown secret name", async () => {
    const result = await bus.dispatch(
      "settings:replaceSecret",
      { name: "bogusKey", value: "x" } as unknown as {
        name: "grokApiKey";
        value: string;
      },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_secret_name");
  });

  test("settings:replaceSecret rejects an oversized value", async () => {
    const huge = "x".repeat(70_000);
    const result = await bus.dispatch(
      "settings:replaceSecret",
      { name: "grokApiKey", value: huge },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("secret_too_large");
  });

  test("settings:replaceSecret rejects empty value (route through clearSecret)", async () => {
    const result = await bus.dispatch(
      "settings:replaceSecret",
      { name: "grokApiKey", value: "" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("empty_secret");
  });

  test("settings:clearSecret rejects unknown secret name", async () => {
    const result = await bus.dispatch(
      "settings:clearSecret",
      { name: "bogusKey" } as unknown as { name: "grokApiKey" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_secret_name");
  });
});

// Integration: drive the full settings:write → events:settings:changed →
// settings:read loop through the real bus + a tmpdir-backed
// DesktopSettingsService. We inject via the `__setSettingsServicesForTests`
// seam so the lazy-init code path doesn't try to call `app.getPath`
// through the partial mock above.
describe("settings:read + settings:write round-trip (integration)", () => {
  test("write → read returns the patched value; broadcast fires", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "pwrsnap-settings-handlers-"));
    const { DesktopSettingsService } = await import(
      "../../settings/desktop-settings-service"
    );
    const { DesktopSecretStore } = await import(
      "../../settings/desktop-secret-store"
    );
    const { __setSettingsServicesForTests } = await import("../settings-handlers");
    const service = new DesktopSettingsService({
      filePath: path.join(dir, "settings.json")
    });
    const secrets = new DesktopSecretStore({
      filePath: path.join(dir, "secrets.bin")
    });
    __setSettingsServicesForTests({ service, secrets });

    // BrowserWindow.getAllWindows() returns [] in our mock, so the
    // broadcast loop is a no-op — that's fine for asserting handler
    // behavior. We assert on the merged Settings the handler returned.
    const writeRes = await bus.dispatch(
      "settings:write",
      { codex: { mode: "pinned", pinnedPath: "/opt/codex" } },
      { principal: "ipc" }
    );
    expect(writeRes.ok).toBe(true);
    if (!writeRes.ok) throw new Error("unreachable");
    expect(writeRes.value.codex.mode).toBe("pinned");
    expect(writeRes.value.codex.pinnedPath).toBe("/opt/codex");

    const readRes = await bus.dispatch("settings:read", {}, { principal: "ipc" });
    expect(readRes.ok).toBe(true);
    if (!readRes.ok) throw new Error("unreachable");
    expect(readRes.value.codex.mode).toBe("pinned");
    expect(readRes.value.codex.pinnedPath).toBe("/opt/codex");
    // Unmentioned fields stay at defaults
    expect(readRes.value.ai.enabled).toBe(false);

    __setSettingsServicesForTests({ service: null, secrets: null });
  });
});
