import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";

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
  buildCodexAutoCandidates,
  discoverCodexCommands,
  nvmNodeBinDirs,
  MINIMUM_CODEX_CLI_VERSION,
  selectResolvedCodexCommand
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

describe("buildCodexAutoCandidates", () => {
  const platform = process.platform;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pwrsnap-codex-dedupe-"));
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  test.runIf(process.platform !== "win32")(
    "pre-resolves bare `codex` to its absolute PATH hit — one candidate, no bare twin",
    async () => {
      const binDir = path.join(tempDir, "bin");
      await mkdir(binDir, { recursive: true });
      const codexPath = path.join(binDir, "codex");
      await writeFile(codexPath, "#!/bin/sh\n", { mode: 0o755 });

      // Duplicate PATH entries must not produce duplicate candidates.
      const candidates = await buildCodexAutoCandidates({
        PATH: `${binDir}${path.delimiter}${binDir}`
      });

      const matching = candidates.filter((candidate) => candidate.command === codexPath);
      expect(matching).toEqual([{ command: codexPath, source: "path" }]);
      expect(candidates.map((candidate) => candidate.command)).not.toContain("codex");
    }
  );

  test.runIf(process.platform !== "win32")(
    "collapses a PATH hit that is also a known install location into one application candidate",
    async () => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "darwin"
      });
      const fakeHome = path.join(tempDir, "home");
      const appBinDir = path.join(fakeHome, "Applications/ChatGPT.app/Contents/Resources");
      await mkdir(appBinDir, { recursive: true });
      const appCodexPath = path.join(appBinDir, "codex");
      await writeFile(appCodexPath, "#!/bin/sh\n", { mode: 0o755 });
      const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

      try {
        const candidates = await buildCodexAutoCandidates({ PATH: appBinDir });

        const matching = candidates.filter((candidate) => candidate.command === appCodexPath);
        expect(matching).toEqual([{ command: appCodexPath, source: "application" }]);
        expect(candidates.map((candidate) => candidate.command)).not.toContain("codex");
      } finally {
        homedirSpy.mockRestore();
      }
    }
  );

  test("keeps the bare PATH candidate when nothing resolves, so the kit's probe stays the arbiter", async () => {
    const candidates = await buildCodexAutoCandidates({ PATH: path.join(tempDir, "empty") });
    const pathCandidates = candidates.filter((candidate) => candidate.source === "path");
    expect(pathCandidates.map((candidate) => candidate.command)).toContain(
      process.platform === "win32" ? "codex.exe" : "codex"
    );
  });
});

describe("selectResolvedCodexCommand", () => {
  test("returns the selected candidate from an existing snapshot", () => {
    const resolved = selectResolvedCodexCommand(
      {
        selectedCommand: "/opt/homebrew/bin/codex",
        selectedSource: "application",
        candidates: [
          {
            command: "/usr/local/bin/codex",
            source: "application",
            executable: true,
            selected: false,
            version: "0.144.0"
          },
          {
            command: "/opt/homebrew/bin/codex",
            source: "application",
            executable: true,
            selected: true,
            version: "0.145.0"
          }
        ]
      },
      "codex"
    );
    expect(resolved).toEqual({
      command: "/opt/homebrew/bin/codex",
      source: "application",
      version: "0.145.0"
    });
  });

  test("falls back to the requested command when nothing is selected", () => {
    expect(selectResolvedCodexCommand({ candidates: [] }, "/pinned/codex")).toEqual({
      command: "/pinned/codex",
      source: "path"
    });
    expect(selectResolvedCodexCommand({ candidates: [] }, "  ")).toEqual({
      command: "codex",
      source: "path"
    });
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

  test("lists every installed node version's bin dir, newest first", async () => {
    const base = join(home, ".nvm", "versions", "node");
    mkdirSync(join(base, "v22.1.0"), { recursive: true });
    mkdirSync(join(base, "v24.14.1"), { recursive: true });

    await expect(nvmNodeBinDirs(home)).resolves.toEqual([
      join(base, "v24.14.1", "bin"),
      join(base, "v22.1.0", "bin")
    ]);
  });

  test("returns empty when nvm is not installed (no shell is spawned)", async () => {
    await expect(nvmNodeBinDirs(home)).resolves.toEqual([]);
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
