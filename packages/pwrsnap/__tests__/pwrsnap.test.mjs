import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(testDir, "..");
const cliPath = resolve(packageDir, "bin/pwrsnap.mjs");
const releaseUrl = "https://github.com/pwrdrvr/PwrSnap/releases/latest";

describe("pwrsnap package surface", () => {
  it("directs npx users to the released desktop app", () => {
    const result = spawnSync(process.execPath, [cliPath], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("desktop screen-capture app for macOS and Windows");
    expect(result.stdout).toContain(releaseUrl);
    expect(result.stdout).not.toMatch(/coming soon|placeholder/i);
  });

  it("keeps published metadata and documentation free of placeholder copy", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
    const readme = readFileSync(resolve(packageDir, "README.md"), "utf8");

    expect(packageJson.version).not.toBe("0.0.0");
    expect(packageJson.description).toContain("desktop screen-capture app");
    expect(readme).toContain(releaseUrl);
    expect(`${packageJson.description}\n${readme}`).not.toMatch(/coming soon|placeholder/i);
  });
});
