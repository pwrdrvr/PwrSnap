import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..");
const repoDir = resolve(packageDir, "../..");
const cliPath = resolve(packageDir, "bin/pwrsnap.mjs");
const releaseGatePath = resolve(repoDir, "scripts/assert-npm-helper-release-order.mjs");
const releaseUrl = "https://github.com/pwrdrvr/PwrSnap/releases/latest";
const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

function runReleaseGate(release) {
  return spawnSync(process.execPath, [releaseGatePath], {
    encoding: "utf8",
    input: JSON.stringify(release)
  });
}

describe("pwrsnap package surface", () => {
  it("directs npx users to the released desktop app", () => {
    const result = runCli();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("desktop screen-capture app for macOS and Windows");
    expect(result.stdout).toContain(releaseUrl);
    expect(result.stdout).not.toMatch(/coming soon|placeholder/i);
  });

  it.each(["--help", "-h"])("documents its link-only behavior for %s", (arg) => {
    const result = runCli(arg);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: pwrsnap [--help | --version]");
    expect(result.stdout).toContain("does not install, open, or control PwrSnap");
  });

  it.each(["--version", "-v"])("labels %s as the npm helper version", (arg) => {
    const result = runCli(arg);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`pwrsnap npm helper ${packageJson.version}`);
    expect(result.stdout).toContain("not the PwrSnap desktop app version");
  });

  it.each([
    ["install"],
    ["open"],
    ["typo"],
    ["--unknown"],
    ["--help", "install"]
  ])("rejects unsupported arguments: %s", (...args) => {
    const result = runCli(...args);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`unsupported argument${args.length === 1 ? "" : "s"}`);
    expect(result.stderr).toContain(args.join(" "));
    expect(result.stderr).toContain('Run "pwrsnap --help" for usage.');
  });

  it("keeps published metadata and documentation free of placeholder copy", () => {
    const readme = readFileSync(resolve(packageDir, "README.md"), "utf8");

    expect(packageJson.version).not.toBe("0.0.0");
    expect(packageJson.description).toContain("official PwrSnap desktop downloads");
    expect(readme).toContain(releaseUrl);
    expect(readme).toContain("does not download");
    expect(`${packageJson.description}\n${readme}`).not.toMatch(/coming soon|placeholder/i);
  });

  it("keeps publication owner- and stable-1.1-gated, then verifies the public package", () => {
    const workflow = readFileSync(
      resolve(repoDir, ".github/workflows/publish-npm-helper.yml"),
      "utf8"
    );
    const runbook = readFileSync(
      resolve(repoDir, "docs/runbooks/publish-pwrsnap-npm-helper.md"),
      "utf8"
    );

    expect(workflow).toContain("PUBLISH_OWNER: huntharo");
    expect(workflow).toContain("environment: npm-publishing");
    expect(workflow).toContain("Require stable PwrSnap 1.1 as GitHub latest");
    expect(workflow).toContain('gh api "repos/$GITHUB_REPOSITORY/releases/latest"');
    expect(workflow).toContain("node scripts/assert-npm-helper-release-order.mjs");
    expect(workflow.indexOf("Require stable PwrSnap 1.1 as GitHub latest")).toBeLessThan(
      workflow.indexOf("npm publish --access public --provenance")
    );
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).toContain("Verify the public registry package");
    expect(workflow).toContain("pwrsnap install");
    expect(runbook).toContain("Merging #500 does **not** update npm");
    expect(runbook).toContain("Publication owner: **@huntharo**");
    expect(runbook).toContain("GitHub gate: **provisioned 2026-08-23**");
    expect(runbook).toContain("npm gate: **not yet configured or verified**");
    expect(runbook).toContain("Do not dispatch the publication workflow");
    expect(runbook).toContain("do not publish npm `0.0.1` merely");
    expect(runbook).toMatch(/stable PwrSnap 1\.1 is\s+GitHub `latest`/);
  });

  it("accepts a stable PwrSnap 1.1 latest release", () => {
    const result = runReleaseGate({ tag_name: "v1.1.0", draft: false, prerelease: false });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("GitHub latest is stable PwrSnap v1.1.0");
  });

  it.each([
    ["the current 1.0 release", { tag_name: "v1.0.3", draft: false, prerelease: false }],
    ["a 1.1 prerelease", { tag_name: "v1.1.0", draft: false, prerelease: true }],
    ["a draft 1.1 release", { tag_name: "v1.1.0", draft: true, prerelease: false }]
  ])("rejects %s at the npm publication gate", (_label, release) => {
    const result = runReleaseGate(release);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Refusing npm helper publication");
  });
});
