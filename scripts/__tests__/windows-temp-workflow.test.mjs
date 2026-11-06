import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const workflowDir = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

describe("hosted Windows temporary storage", () => {
  test("every Windows job directs inherited temp files to runner.temp", () => {
    const windowsJobs = [];
    for (const file of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
      const yaml = readFileSync(`${workflowDir}/${file}`, "utf8");
      const jobs = [...yaml.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)];
      for (const [, name, job] of jobs) {
        if (!/^    runs-on: windows-(?:latest|\d+)\s*$/m.test(job)) continue;
        windowsJobs.push(`${file}:${name}`);
        const jobEnv = job.match(/^    env:\n((?:^      .*\n|^\s*\n)+)/m)?.[1] ?? "";
        for (const variable of ["TEMP", "TMP"]) {
          expect(jobEnv, `${file}:${name} ${variable}`).toMatch(
            new RegExp(`^      ${variable}: \\$\\{\\{ runner\\.temp \\}\\}$`, "m")
          );
          // A step-level override would shadow the job environment.
          expect([...job.matchAll(new RegExp(`^\\s+${variable}:`, "gm"))]).toHaveLength(1);
        }
      }
    }
    expect(windowsJobs.sort()).toEqual([
      "ci.yml:windows", "ci.yml:windows-e2e", "ci.yml:windows-install-deps",
      "preview-build.yml:preview-windows", "release.yml:windows-prepare", "release.yml:windows-sign"
    ]);
  });
});
