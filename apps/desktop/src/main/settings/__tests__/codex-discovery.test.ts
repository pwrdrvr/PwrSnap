import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  })),
  pathIsExecutable: vi.fn(async () => false)
}));

vi.mock("@pwrdrvr/codex-discovery", () => ({
  compareCodexCliVersions: vi.fn((left: string, right: string) =>
    left === right ? 0 : left < right ? -1 : 1
  ),
  discoverCommands: mocks.discoverCommands,
  pathIsExecutable: mocks.pathIsExecutable
}));

const {
  assertCodexCliVersion,
  discoverCodexCommands,
  nvmNodeBinDirs,
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

describe("nvmNodeBinDirs", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pwrsnap-nvm-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("lists every installed node version's bin dir, newest first", () => {
    const base = join(home, ".nvm", "versions", "node");
    mkdirSync(join(base, "v22.1.0"), { recursive: true });
    mkdirSync(join(base, "v24.14.1"), { recursive: true });

    expect(nvmNodeBinDirs(home)).toEqual([
      join(base, "v24.14.1", "bin"),
      join(base, "v22.1.0", "bin")
    ]);
  });

  test("returns empty when nvm is not installed (no shell is spawned)", () => {
    expect(nvmNodeBinDirs(home)).toEqual([]);
  });
});

describe("assertCodexCliVersion not-found reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("a missing pinned path fails with a clear message before any spawn", async () => {
    mocks.pathIsExecutable.mockResolvedValue(false);

    await expect(
      assertCodexCliVersion("/stale/pinned/codex", {})
    ).rejects.toThrow(/Codex CLI not found: \/stale\/pinned\/codex.*Settings → AI/);
  });

  test("a bare command missing from PATH maps spawn ENOENT to the same message", async () => {
    await expect(
      assertCodexCliVersion("pwrsnap-definitely-not-a-real-codex", {})
    ).rejects.toThrow(/Codex CLI not found: pwrsnap-definitely-not-a-real-codex/);
  });
});
