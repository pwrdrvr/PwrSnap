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
        const firstStep = job.match(
          /^    steps:\n(?:      #.*\n)*      - name: Move temporary files to runner temp\n([\s\S]*?)(?=^      - |$(?![\s\S]))/m
        )?.[1] ?? "";
        expect(firstStep, `${file}:${name} first step`).toContain("        shell: pwsh\n        run: |\n");
        for (const variable of ["TEMP", "TMP"]) {
          expect(firstStep, `${file}:${name} ${variable}`).toContain(
            `          "${variable}=$env:RUNNER_TEMP" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append\n`
          );
          // Job- or step-level env would shadow GITHUB_ENV on subsequent steps.
          expect(job).not.toMatch(new RegExp(`^\\s+${variable}:`, "m"));
        }
      }
    }
    expect(windowsJobs.sort()).toEqual([
      "ci.yml:windows", "ci.yml:windows-e2e", "ci.yml:windows-install-deps",
      "preview-build.yml:preview-windows", "release.yml:windows-prepare", "release.yml:windows-sign"
    ]);
  });
});
