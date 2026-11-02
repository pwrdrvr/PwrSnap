import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  home: "/fixture/home",
  versions: new Map<string, string>(),
  probe: vi.fn(async (command: string, args: string[]) => {
    if (args.length !== 1 || args[0] !== "--version") {
      throw new Error(`Unexpected discovery probe: ${command}`);
    }
    const version = fixtures.versions.get(command);
    if (version === undefined) {
      throw Object.assign(new Error("Fixture executable not found"), { code: "ENOENT" });
    }
    return { stdout: `codex-cli ${version}\n`, stderr: "" };
  })
}));

// Exercise the installed discovery engine, including probing, version sorting,
// selection and deduplication. Only filesystem/process boundaries are fixtures:
// these tests never inspect or launch the operator's installed agents.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn(async (candidate: string) => {
    if (!fixtures.versions.has(candidate)) {
      throw Object.assign(new Error("Fixture path not found"), { code: "ENOENT" });
    }
  }),
  readdir: vi.fn(async () => [])
}));

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  return {
    ...await importOriginal<typeof import("node:child_process")>(),
    execFile: Object.assign(vi.fn(() => {
      throw new Error("Discovery must use the promisified fixture probe");
    }), { [promisify.custom]: fixtures.probe })
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixtures.home } };
});

import { discoverCodexCommands } from "../codex-discovery";

const appCommands = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  path.join(fixtures.home, "Applications/ChatGPT.app/Contents/Resources/codex"),
  path.join(fixtures.home, "Applications/Codex.app/Contents/Resources/codex")
] as const;
const sparseEnv = { PATH: "/fixture/empty" };

describe("macOS Codex discovery with the real discovery engine", () => {
  const platform = process.platform;

  beforeEach(() => {
    fixtures.versions.clear();
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  });

  test.each(appCommands)("discovers and selects %s with a sparse GUI PATH", async (command) => {
    fixtures.versions.set(command, "0.160.0");

    const snapshot = await discoverCodexCommands({ env: sparseEnv });

    expect(snapshot.selectedCommand).toBe(command);
    expect(snapshot.selectedSource).toBe("application");
    expect(snapshot.candidates).toEqual([
      expect.objectContaining({
        command, source: "application", version: "0.160.0", executable: true, selected: true
      })
    ]);
    expect(fixtures.probe.mock.calls.filter(([probed]) => probed === command)).toHaveLength(1);
  });

  test("keeps the environment override ahead of the configured command and newer app", async () => {
    fixtures.versions.set("/fixture/override/codex", "0.159.2");
    fixtures.versions.set("/fixture/configured/codex", "0.160.0");
    fixtures.versions.set(appCommands[0], "0.161.0");

    const snapshot = await discoverCodexCommands({
      configuredCommand: "/fixture/configured/codex",
      env: { ...sparseEnv, PWRSNAP_CODEX_COMMAND: "/fixture/override/codex" }
    });

    expect(snapshot.selectedCommand).toBe("/fixture/override/codex");
    expect(snapshot.selectedSource).toBe("env");
  });

  test("keeps the configured command ahead of a newer app", async () => {
    fixtures.versions.set("/fixture/configured/codex", "0.159.2");
    fixtures.versions.set(appCommands[0], "0.161.0");

    const snapshot = await discoverCodexCommands({
      configuredCommand: "/fixture/configured/codex", env: sparseEnv
    });

    expect(snapshot.selectedCommand).toBe("/fixture/configured/codex");
    expect(snapshot.selectedSource).toBe("config");
  });

  test("selects the newest automatic candidate across PATH and both app names", async () => {
    const pathCommand = path.join("/fixture/bin", "codex");
    fixtures.versions.set(pathCommand, "0.159.2");
    fixtures.versions.set(appCommands[0], "0.160.0");
    fixtures.versions.set(appCommands[1], "0.161.0");

    const snapshot = await discoverCodexCommands({ env: { PATH: "/fixture/bin" } });

    expect(snapshot.selectedCommand).toBe(appCommands[1]);
    expect(snapshot.candidates.map(({ command }) => command)).toEqual([
      appCommands[1], appCommands[0], pathCommand
    ]);
  });

  test("keeps PATH first when an app has the same version", async () => {
    const pathCommand = path.join("/fixture/bin", "codex");
    fixtures.versions.set(pathCommand, "0.160.0");
    fixtures.versions.set(appCommands[0], "0.160.0");

    const snapshot = await discoverCodexCommands({ env: { PATH: "/fixture/bin" } });

    expect(snapshot.selectedCommand).toBe(pathCommand);
    expect(snapshot.selectedSource).toBe("path");
  });

  test.each([appCommands[0], appCommands[2]])(
    "probes the ChatGPT executable only once when %s is also on PATH",
    async (command) => {
      fixtures.versions.set(command, "0.160.0");

      const snapshot = await discoverCodexCommands({ env: { PATH: path.dirname(command) } });

      expect(snapshot.selectedCommand).toBe(command);
      expect(snapshot.selectedSource).toBe("application");
      expect(snapshot.candidates).toHaveLength(1);
      expect(fixtures.probe.mock.calls.filter(([probed]) => probed === command)).toHaveLength(1);
    }
  );
});
