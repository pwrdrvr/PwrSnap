import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));

// Keep discovery away from the operator's installations while exercising the
// real discovery engine, version guard and OS shebang execution.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (candidate: string, mode?: number) => {
      if (!candidate.startsWith(`${fixture.root}/`)) {
        throw Object.assign(new Error("Outside fixture"), { code: "ENOENT" });
      }
      return actual.access(candidate, mode);
    }
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fixture.root } };
});

import { execAgentCommand } from "../../ai/agent-command";
import { DesktopSettingsStore } from "../desktop-settings-store";

const execFile = promisify(execFileCallback);

describe.skipIf(process.platform === "win32")("npm Codex under a sparse GUI PATH", () => {
  let command: string;
  const env = { PATH: "" };

  beforeEach(async () => {
    fixture.root = await mkdtemp(path.join(tmpdir(), "pwrsnap-npm-codex-"));
    // Linux CI often has /usr/bin/node; isolate PATH so the failure does not
    // depend on whether the host installed a system-wide Node runtime.
    env.PATH = path.join(fixture.root, "empty-path");
    await mkdir(env.PATH);
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    command = path.join(bin, "codex");
    await writeFile(command, [
      "#!/usr/bin/env node",
      'require("node:fs").appendFileSync(process.argv[1] + ".probes", JSON.stringify(process.argv.slice(2)) + "\\n");',
      'process.stdout.write("codex-cli 0.160.0\\n");',
      ""
    ].join("\n"));
    await chmod(command, 0o755);
  });

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  test("the unprepared probe reproduces the report, while the runtime probe works", async () => {
    await expect(execFile(command, ["--version"], { env })).rejects.toMatchObject({
      stderr: expect.stringMatching(/env: [^\n]*node[^\n]*No such file or directory/)
    });
    await expect(execAgentCommand(command, ["--version"], { env, timeoutMs: 2500 }))
      .resolves.toMatchObject({ stdout: "codex-cli 0.160.0\n" });
  });

  test("the store verifies a pinned npm launcher and reuses the discovery publication", async () => {
    const store = new DesktopSettingsStore({
      filePath: path.join(fixture.root, "settings.json"), env
    });
    await expect(store.resolveCompatibleCodexCommand({ command, env })).resolves.toMatchObject({
      command, version: "0.160.0", source: "config"
    });
    await store.resolveCompatibleCodexCommand({ command, env });
    expect(store.readDiagnostics().codexDiscoveryRuns).toBe(1);
    expect(await readFile(`${command}.probes`, "utf8")).toBe('["--version"]\n');
    expect(env.PATH).toBe(path.join(fixture.root, "empty-path"));
  });

  test("automatically discovers an npm launcher installed under nvm", async () => {
    const bin = path.join(fixture.root, ".nvm", "versions", "node", "v24.14.1", "bin");
    await mkdir(path.dirname(bin), { recursive: true });
    await rename(path.dirname(command), bin);
    command = path.join(bin, "codex");
    const store = new DesktopSettingsStore({
      filePath: path.join(fixture.root, "settings.json"), env
    });
    await expect(store.resolveCompatibleCodexCommand({ command: "codex", env }))
      .resolves.toMatchObject({ command, version: "0.160.0", source: "application" });
    expect(await readFile(`${command}.probes`, "utf8")).toBe('["--version"]\n');
  });

  test("still refuses a launcher whose Node runtime is missing", async () => {
    await unlink(path.join(path.dirname(command), "node"));
    const store = new DesktopSettingsStore({
      filePath: path.join(fixture.root, "settings.json"), env
    });
    await expect(store.resolveCompatibleCodexCommand({ command, env }))
      .rejects.toThrow(/version could not be verified.*env: [^\n]*node[^\n]*No such file or directory/s);
  });

  test("still refuses an npm launcher older than the minimum supported CLI", async () => {
    const script = await readFile(command, "utf8");
    await writeFile(command, script.replace("0.160.0", "0.143.0"));
    const store = new DesktopSettingsStore({
      filePath: path.join(fixture.root, "settings.json"), env
    });
    await expect(store.resolveCompatibleCodexCommand({ command, env }))
      .rejects.toThrow(/0\.143\.0/);
    expect(await readFile(`${command}.probes`, "utf8")).toBe('["--version"]\n');
  });
});
