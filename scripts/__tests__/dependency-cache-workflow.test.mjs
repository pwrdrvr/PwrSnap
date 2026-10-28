import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name) => readFileSync(resolve(root, name), "utf8");
const ci = read(".github/workflows/ci.yml");
const actionSha = "9bb6e786801cf822d57b2298e02ccefd05e8ef0f";
const jobs = Object.fromEntries(
  [...ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)]
    .map((match) => [match[1], match[2]])
);

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

  test("persistent macOS stores stay runner-scoped and guarded from forks", () => {
    const mac = jobs["desktop-e2e-macos"];
    const benchmark = read(".github/workflows/check-performance.yml");
    for (const job of [mac, benchmark]) {
      expect(job).toContain("github.event.pull_request.head.repo.full_name == github.repository");
      expect(job).toContain("persistent-store-dir: ~/Library/Caches/pwrsnap-ci/${{ runner.name }}");
      expect(job).toContain('cache-electron: "true"');
      expect(job).not.toMatch(/dependency-cache:|cache-mode:|lookup-only:/);
    }
    expect(mac).toContain("needs: changes");
    expect(mac).toContain("run: pnpm rebuild:electron-native");
  });

  test("privileged metadata installation remains uncached with scripts disabled", () => {
    const bot = read(".github/workflows/dependabot-licenses.yml");
    expect(bot).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(bot).not.toMatch(/uses: pwrdrvr\/configure-nodejs@|uses: actions\/cache/);
  });
});
