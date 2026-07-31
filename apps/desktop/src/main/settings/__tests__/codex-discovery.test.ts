import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type DiscoverCommandsOptions = {
  autoCandidates: Array<{ command: string; source: string }>;
  validateVersion?: (version: string) => string | undefined;
};

const mocks = vi.hoisted(() => ({
  discoverCommands: vi.fn(async (options: DiscoverCommandsOptions) => ({
    candidates: options.autoCandidates.map((candidate) => ({
      ...candidate,
      executable: false,
      selected: false
    }))
  }))
}));

vi.mock("@pwrdrvr/codex-discovery", () => ({
  compareCodexCliVersions: vi.fn((left: string, right: string) =>
    left === right ? 0 : left < right ? -1 : 1
  ),
  discoverCommands: mocks.discoverCommands,
  pathIsExecutable: vi.fn()
}));

const {
  discoverCodexCommands,
  MINIMUM_CODEX_CLI_VERSION
} = await import("../codex-discovery");

describe("discoverCodexCommands", () => {
  const platform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("requires the CLI release matching the pinned protocol surface", () => {
    expect(MINIMUM_CODEX_CLI_VERSION).toBe("0.144.0");
  });

  test("marks pre-0.144 candidates as incompatible during discovery", async () => {
    await discoverCodexCommands({ env: {} });

    const options = mocks.discoverCommands.mock.calls[0]?.[0] as
      | DiscoverCommandsOptions
      | undefined;
    expect(options?.validateVersion?.("0.143.0")).toBe("codex_too_old");
    expect(options?.validateVersion?.("0.144.0")).toBeUndefined();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform
    });
  });

  test("passes ChatGPT app and Homebrew macOS candidates to discovery", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin"
    });

    await discoverCodexCommands({ env: {} });

    const options = mocks.discoverCommands.mock.calls[0]?.[0] as
      | DiscoverCommandsOptions
      | undefined;
    const commands = options?.autoCandidates.map((candidate) => candidate.command) ?? [];

    expect(commands).toContain("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(commands).toContain("/Applications/Codex.app/Contents/Resources/codex");
    expect(commands).toContain("/opt/homebrew/bin/codex");
    expect(commands).toContain("/usr/local/bin/codex");
    expect(commands).toContain("codex");
  });
});
