import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name) => readFileSync(resolve(root, name), "utf8");
const ci = read(".github/workflows/ci.yml");
const actionSha = "d416c1c78119b25fe03ee3ef78b75af0d69b10a7";
const workflowJobs = (workflow) => Object.fromEntries(
  [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]])
);
const jobs = workflowJobs(ci);

describe("CI dependency cache contract", () => {
  test("the lockfile's package-manager document matches the integrity-pinned pnpm version", () => {
    // pnpm 12 activation can rewrite this document before the frozen install.
    // A stale manager resolution makes completed-tree population reject it.
    const pin = JSON.parse(read("package.json")).packageManager;
    const version = /^pnpm@(\d+\.\d+\.\d+)\+sha512\.[a-f0-9]+$/.exec(pin)?.[1];
    expect(version).toBeDefined();
    const managerDocument = read("pnpm-lock.yaml").split(/^---\s*$/m)[1];
    const resolution = managerDocument.match(
      /packageManagerDependencies:\n      pnpm:\n        specifier: (\S+)\n        version: (\S+)/
    );
    expect(resolution?.slice(1)).toEqual([version, version]);
    expect(managerDocument).toContain(`  pnpm@${version}:`);
  });

  test.each([
    ["install-deps", "lint", "build", "test", "desktop-e2e"],
    ["windows-install-deps", "windows", "windows-e2e"]
  ])("%s produces the exact policy consumed by its fan-out", (producer, ...consumers) => {
    const policy = (job) => {
      const fields = ["node-version", "dependency-cache", "cache-key-suffix", "cache-inputs"];
      return fields.map((field) => job.match(new RegExp(`^          ${field}: (.+)$`, "m"))?.[1]);
    };
    const source = jobs[producer];
    expect(source).toContain("cache-mode: populate");
    expect(source).toContain("dependency-cache: node-modules");
    for (const consumer of consumers) {
      const target = jobs[consumer];
      expect(target).toContain(`needs: [changes, ${producer}]`);
      expect(target.match(/^    runs-on: (.+)$/m)?.[1]).toBe(source.match(/^    runs-on: (.+)$/m)?.[1]);
      expect(policy(target)).toEqual(policy(source));
      expect(target).toContain("cache-mode: restore");
      expect(target).toContain('PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false"');
    }
    for (const name of [producer, ...consumers]) {
      expect(jobs[name]).not.toMatch(/lookup-only:|persistent-store-dir:|cache-electron:/);
    }
  });

  test("the reviewed action revision binds every invocation and completed cache", () => {
    expect(ci).toContain(`PWRSNAP_DEPENDENCY_CACHE_POLICY: pwrsnap-install-v1-${actionSha}`);
    for (const name of readdirSync(resolve(root, ".github/workflows"))) {
      if (!name.endsWith(".yml")) continue;
      for (const match of read(`.github/workflows/${name}`).matchAll(/uses: pwrdrvr\/configure-nodejs@(\S+)/g)) {
        expect(match[1]).toBe(actionSha);
      }
    }
  });

  test("additional inputs cover project lifecycle code and all native sources", () => {
    const inputs = ci.match(/PWRSNAP_DEPENDENCY_CACHE_INPUTS: \|\n((?:    .+\n)+)/)[1]
      .trim().split("\n").map((line) => line.trim());
    const visit = (directory) => readdirSync(resolve(root, directory), { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? visit(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
    for (const file of [
      ".nvmrc", ".pnpmfile-global.cjs", "scripts/check-node-version.mjs",
      "scripts/lib/cli-entrypoint.mjs", "scripts/linux-sandbox.mjs",
      "apps/desktop/scripts/build-native.mjs", ...visit("apps/desktop/native")
    ]) expect(inputs).toContain(file);
    for (const file of inputs) expect(existsSync(resolve(root, file))).toBe(true);
    expect(read("pnpm-workspace.yaml")).toContain("packageImportMethod: auto");
  });

  test("Windows consumers build helpers excluded from completed archives", () => {
    expect(jobs.windows).toContain("pnpm --filter @pwrsnap/desktop build:native");
    expect(jobs["windows-e2e"]).toContain("run: pnpm rebuild:electron-native");
  });

  test("macOS jobs use standard hosted runners and Actions-backed stores", () => {
    const mac = jobs["desktop-e2e-macos"];
    const benchmark = workflowJobs(read(".github/workflows/check-performance.yml"))["paired-compilers"];
    const preview = workflowJobs(read(".github/workflows/preview-build.yml")).preview;
    const release = workflowJobs(read(".github/workflows/release.yml"));
    for (const job of [mac, benchmark, preview, release.prepare, release.sign]) {
      expect(job).toContain("runs-on: macos-26\n");
      expect(job).not.toContain("persistent-store-dir:");
    }
    for (const job of [mac, benchmark, preview, release.prepare]) {
      expect(job).toContain('cache-electron: "true"');
      expect(job).not.toMatch(/dependency-cache:|cache-mode:|lookup-only:/);
    }
    for (const job of [mac, benchmark, preview]) {
      expect(job).not.toContain("github.event.pull_request.head.repo.full_name");
    }
    expect(mac).toContain("if: needs.changes.outputs.code_impacting == 'true'");
    expect(mac).toContain("needs: changes");
    expect(mac).toContain("run: pnpm rebuild:electron-native");
    expect(mac).toContain("lfs: true");
    expect(mac).toContain('PWRSNAP_E2E_DISABLE_GPU: "1"');
    for (const name of readdirSync(resolve(root, ".github/workflows"))) {
      if (!name.endsWith(".yml")) continue;
      expect(read(`.github/workflows/${name}`)).not.toMatch(/^\s*runs-on:.*self-hosted/m);
    }
  });

  test("privileged metadata installation remains uncached with scripts disabled", () => {
    const bot = read(".github/workflows/dependabot-licenses.yml");
    expect(bot).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(bot).not.toMatch(/uses: pwrdrvr\/configure-nodejs@|uses: actions\/cache/);
  });
});

// The aggregate job executes on Ubuntu; this exercises its Bash directly.
describe.skipIf(process.platform === "win32")("Desktop E2E aggregate gate", () => {
  const script = jobs["desktop-e2e-result"].match(/        run: \|\n([\s\S]*)$/)[1]
    .replace(/^          /gm, "");
  const scenarios = [
    ["all platforms pass", {}, 0],
    ...["LINUX_RESULT", "MACOS_RESULT", "WINDOWS_RESULT"].flatMap((platform) =>
      ["failure", "skipped", "cancelled", ""].map((result) => [
        `${platform} is ${result || "missing"}`, { [platform]: result }, 1
      ])
    )
  ];

  test.each(scenarios)("%s", (_label, results, expectedStatus) => {
    const directory = mkdtempSync(join(tmpdir(), "pwrsnap-e2e-gate-"));
    try {
      const result = spawnSync("bash", ["-c", script], {
        env: {
          ...process.env,
          LINUX_RESULT: "success",
          MACOS_RESULT: "success",
          WINDOWS_RESULT: "success",
          // Fork PRs now require the same macOS coverage as every other PR.
          IS_FORK_PR: "true",
          GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
          ...results
        },
        encoding: "utf8"
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(expectedStatus);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
