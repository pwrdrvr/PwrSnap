import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { stagedPnpmConfigEnv } from "./staged-pnpm-config.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-staged-pnpm-"));
  temporaryRoots.push(root);
  return root;
}

test("a prepared stage missing its global hook fails before running the builder", () => {
  expect(() => stagedPnpmConfigEnv(fixtureRoot())).toThrow("Prepared stage is missing its pnpm global hook");
});

test.each(["release.mjs", "package-win.mjs"])("%s carries and selects the staged hook", (scriptName) => {
  const script = readFileSync(new URL(scriptName, import.meta.url), "utf8");
  expect(script).toMatch(/for \(const file of \[[^\]]*"\.pnpmfile-global\.cjs"/);
  expect(script).toContain("env: stagedPnpmConfigEnv(stageDir)");
});

// XDG_CONFIG_HOME isolates the native pnpm config on macOS and Linux. The
// Windows lane still exercises the shared helper and both production callers.
test.skipIf(process.platform === "win32")("pnpm list in a relocated standalone stage suppresses the user's global hook", () => {
  const root = fixtureRoot();
  const preparedStage = join(root, "prepared");
  const restoredStage = join(root, "restored stage with spaces");
  mkdirSync(preparedStage);
  // Outside the workspace, Corepack otherwise selects the machine's default pnpm.
  const { packageManager } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  writeFileSync(join(preparedStage, "package.json"), JSON.stringify({ name: "staged-pnpm-probe", private: true, packageManager }));
  cpSync(join(repoRoot, ".pnpmfile-global.cjs"), join(preparedStage, ".pnpmfile-global.cjs"));
  renameSync(preparedStage, restoredStage);

  const userHook = join(root, "user.cjs");
  writeFileSync(userHook, 'module.exports = { hooks: { updateConfig() { throw new Error("UNEXPECTED_USER_PNPM_HOOK"); } } };\n');
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "pnpm"), { recursive: true });
  writeFileSync(join(configHome, "pnpm", "config.yaml"), `globalPnpmfile: ${JSON.stringify(userHook)}\n`);

  function list(globalHookEnv) {
    return spawnSync("pnpm", ["list", "--json", "--depth=0"], {
      cwd: restoredStage,
      env: { ...process.env, XDG_CONFIG_HOME: configHome, ...globalHookEnv },
      encoding: "utf8",
      timeout: 15_000
    });
  }

  const before = list({ pnpm_config_global_pnpmfile: "", PNPM_CONFIG_GLOBAL_PNPMFILE: "" });
  expect(before.status).not.toBe(0);
  expect(before.stdout + before.stderr).toContain("UNEXPECTED_USER_PNPM_HOOK");

  const after = list(stagedPnpmConfigEnv(restoredStage));
  expect(after.error).toBeUndefined();
  expect(after.status, after.stdout + after.stderr).toBe(0);
  expect(JSON.parse(after.stdout)[0].name).toBe("staged-pnpm-probe");
});
