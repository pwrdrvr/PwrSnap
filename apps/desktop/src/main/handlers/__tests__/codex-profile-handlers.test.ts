// Unit tests for the Codex auth-profile handlers
// (`codex:profiles:list` / `:create` / `:login`). The kit
// (`@pwrdrvr/codex-discovery`) and the codex-command resolver are mocked so
// the handlers run as pure orchestration:
//
//   • list   → maps kit discovery + per-profile `checkCodexAuthStatus` onto
//              the protocol shape (status + email + planType).
//   • create → validates/normalizes the name, calls `createCodexAuthProfile`,
//              probes status best-effort.
//   • login  → resolves CODEX_HOME for the profile and invokes the injected
//              `CodexLoginManager.startProfileLogin`, returning its result.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discoverCodexAuthProfiles: vi.fn(),
  checkCodexAuthStatus: vi.fn(),
  createCodexAuthProfile: vi.fn(),
  resolveCodexHomeForProfile: vi.fn(),
  resolveDefaultCodexHome: vi.fn(),
  resolveCodexCommand: vi.fn(),
  startProfileLogin: vi.fn(),
  dispose: vi.fn(),
  loggerWarn: vi.fn()
}));

// Mock the kit barrel. `normalizeProfileName` / `isValidProfileName` are used
// by the validators the SUT imports, so we forward them to the real impl.
vi.mock("@pwrdrvr/codex-discovery", async () => {
  const actual = await vi.importActual<typeof import("@pwrdrvr/codex-discovery")>(
    "@pwrdrvr/codex-discovery"
  );
  return {
    ...actual,
    discoverCodexAuthProfiles: mocks.discoverCodexAuthProfiles,
    checkCodexAuthStatus: mocks.checkCodexAuthStatus,
    createCodexAuthProfile: mocks.createCodexAuthProfile,
    resolveCodexHomeForProfile: mocks.resolveCodexHomeForProfile,
    resolveDefaultCodexHome: mocks.resolveDefaultCodexHome,
    // Constructing `new CodexLoginManager(...)` returns our spy-backed shape;
    // the SUT only ever calls `.startProfileLogin` / `.dispose`.
    CodexLoginManager: class {
      startProfileLogin = mocks.startProfileLogin;
      dispose = mocks.dispose;
    }
  };
});

vi.mock("../../settings/codex-discovery", () => ({
  resolveCodexCommand: mocks.resolveCodexCommand
}));

vi.mock("../../ai/agent-kit-bindings", () => ({
  openExternal: vi.fn(async () => {}),
  toAgentKitLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn()
  })
}));

// Stub electron so module-load of the bus / dependencies succeeds.
vi.mock("electron", (): Partial<typeof import("electron")> => ({
  shell: { openExternal: vi.fn() } as unknown as typeof import("electron").shell
}));

import type { Settings } from "@pwrsnap/shared";
import { bus } from "../../command-bus";
import {
  __setCodexLoginManagerForTests,
  disposeCodexProfileHandlers,
  registerCodexProfileHandlers
} from "../codex-profile-handlers";

function makeSettings(profile: string): Settings {
  return {
    codex: { mode: "auto", pinnedPath: "", profile, captionModel: "gpt-5.4-mini" }
  } as unknown as Settings;
}

const settingsReader = vi.fn<() => Promise<Settings>>();

// Register once — the bus throws on duplicate register and vitest reuses the
// module across tests in this file. Inject the fake reader.
registerCodexProfileHandlers({ settingsReader });

beforeEach(() => {
  vi.clearAllMocks();
  settingsReader.mockResolvedValue(makeSettings(""));
  mocks.resolveCodexCommand.mockResolvedValue({ command: "codex", source: "path" });
  mocks.resolveDefaultCodexHome.mockReturnValue("/home/.codex");
});

afterEach(() => {
  __setCodexLoginManagerForTests(null);
});

describe("codex:profiles:list", () => {
  test("maps kit profiles + per-profile auth status onto the protocol", async () => {
    settingsReader.mockResolvedValue(makeSettings("work"));
    mocks.discoverCodexAuthProfiles.mockReturnValue({
      profileRoot: "/home/.codex/profiles",
      effectiveCodexHome: "/home/.codex/profiles/work",
      profiles: [
        {
          name: "",
          displayName: "System default",
          codexHome: "/home/.codex",
          source: "default",
          exists: true,
          selected: false,
          hasAuthFile: true,
          hasConfigFile: true
        },
        {
          name: "work",
          displayName: "work",
          codexHome: "/home/.codex/profiles/work",
          source: "directory",
          exists: true,
          selected: true,
          hasAuthFile: true,
          hasConfigFile: false
        }
      ]
    });
    mocks.checkCodexAuthStatus.mockImplementation(
      async (params: { profile: string; codexHome: string }) =>
        params.profile === "work"
          ? {
              profile: "work",
              codexHome: params.codexHome,
              authenticated: true,
              status: "authenticated",
              email: "dev@example.com",
              planType: "pro"
            }
          : {
              profile: "",
              codexHome: params.codexHome,
              authenticated: false,
              status: "unauthenticated"
            }
    );

    const result = await bus.dispatch("codex:profiles:list", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.profileRoot).toBe("/home/.codex/profiles");
    expect(result.value.effectiveCodexHome).toBe("/home/.codex/profiles/work");
    expect(result.value.profiles).toHaveLength(2);

    const work = result.value.profiles.find((p) => p.name === "work");
    expect(work).toMatchObject({
      name: "work",
      displayName: "work",
      selected: true,
      status: "authenticated",
      email: "dev@example.com",
      planType: "pro"
    });

    const dflt = result.value.profiles.find((p) => p.name === "");
    expect(dflt).toMatchObject({ status: "unauthenticated", selected: false });
    expect(dflt?.email).toBeUndefined();

    // configuredProfile must be threaded from settings into discovery.
    expect(mocks.discoverCodexAuthProfiles).toHaveBeenCalledWith({
      configuredProfile: "work"
    });
  });

  test("falls back to a disk signal when the status probe throws", async () => {
    mocks.discoverCodexAuthProfiles.mockReturnValue({
      profileRoot: "/home/.codex/profiles",
      effectiveCodexHome: "/home/.codex",
      profiles: [
        {
          name: "",
          displayName: "System default",
          codexHome: "/home/.codex",
          source: "default",
          exists: true,
          selected: true,
          hasAuthFile: true,
          accountEmail: "cached@example.com",
          hasConfigFile: true
        }
      ]
    });
    mocks.checkCodexAuthStatus.mockRejectedValue(new Error("spawn ENOENT"));

    const result = await bus.dispatch("codex:profiles:list", {}, { principal: "ipc" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.value.profiles[0];
    // hasAuthFile=true + probe error → "failed", with the cached email surfaced.
    expect(p?.status).toBe("failed");
    expect(p?.email).toBe("cached@example.com");
  });
});

describe("codex:profiles:create", () => {
  test("normalizes the name and creates the profile", async () => {
    mocks.createCodexAuthProfile.mockReturnValue({
      profile: "my-work",
      codexHome: "/home/.codex/profiles/my-work",
      created: true
    });
    mocks.checkCodexAuthStatus.mockResolvedValue({
      profile: "my-work",
      codexHome: "/home/.codex/profiles/my-work",
      authenticated: false,
      status: "unauthenticated"
    });

    const result = await bus.dispatch(
      "codex:profiles:create",
      { name: "My Work" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.createCodexAuthProfile).toHaveBeenCalledWith("my-work");
    expect(result.value).toMatchObject({
      name: "my-work",
      codexHome: "/home/.codex/profiles/my-work",
      status: "unauthenticated",
      hasAuthFile: false,
      selected: false
    });
  });

  test("rejects an unusable name before touching the kit", async () => {
    const result = await bus.dispatch(
      "codex:profiles:create",
      { name: "   " },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("validation");
    expect(mocks.createCodexAuthProfile).not.toHaveBeenCalled();
  });

  test("surfaces a create failure as a settings error", async () => {
    mocks.createCodexAuthProfile.mockImplementation(() => {
      throw new Error("EACCES mkdir");
    });
    const result = await bus.dispatch(
      "codex:profiles:create",
      { name: "work" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("profile_create_failed");
  });
});

describe("codex:profiles:login", () => {
  test("invokes the login manager with the resolved CODEX_HOME and returns its result", async () => {
    mocks.resolveCodexHomeForProfile.mockReturnValue("/home/.codex/profiles/work");
    mocks.startProfileLogin.mockResolvedValue({
      profile: "work",
      codexHome: "/home/.codex/profiles/work",
      started: true,
      loginUrl: "https://auth.openai.com/oauth/authorize?x=1",
      detail: "Open this link"
    });

    const result = await bus.dispatch(
      "codex:profiles:login",
      { name: "Work" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.startProfileLogin).toHaveBeenCalledWith({
      command: "codex",
      codexHome: "/home/.codex/profiles/work",
      profile: "work"
    });
    expect(result.value).toMatchObject({
      profile: "work",
      started: true,
      loginUrl: "https://auth.openai.com/oauth/authorize?x=1"
    });
  });

  test("uses the default CODEX_HOME for the empty (System default) profile", async () => {
    mocks.startProfileLogin.mockResolvedValue({
      profile: "",
      codexHome: "/home/.codex",
      started: false,
      authenticated: true
    });

    const result = await bus.dispatch(
      "codex:profiles:login",
      { name: "" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mocks.resolveCodexHomeForProfile).not.toHaveBeenCalled();
    expect(mocks.startProfileLogin).toHaveBeenCalledWith({
      command: "codex",
      codexHome: "/home/.codex",
      profile: ""
    });
    expect(result.value.authenticated).toBe(true);
  });

  test("maps a thrown login error to a settings error envelope", async () => {
    mocks.resolveCodexHomeForProfile.mockReturnValue("/home/.codex/profiles/work");
    mocks.startProfileLogin.mockRejectedValue(new Error("login exited"));

    const result = await bus.dispatch(
      "codex:profiles:login",
      { name: "work" },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("profile_login_failed");
  });
});

describe("disposeCodexProfileHandlers", () => {
  test("disposes the active login manager", async () => {
    // Trigger lazy construction of the default manager by logging in once.
    __setCodexLoginManagerForTests(null);
    mocks.startProfileLogin.mockResolvedValue({
      profile: "",
      codexHome: "/home/.codex",
      started: true
    });
    await bus.dispatch("codex:profiles:login", { name: "" }, { principal: "ipc" });
    disposeCodexProfileHandlers();
    expect(mocks.dispose).toHaveBeenCalled();
  });
});
