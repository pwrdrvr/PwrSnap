import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { isCliEntrypoint } from "../lib/cli-entrypoint.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isCliEntrypoint", () => {
  test("matches when the module is the script node was asked to run", () => {
    const scriptPath = join(repoRoot, "scripts", "generate-third-party-licenses.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
  });

  test("matches a path that needs percent-encoding in its file URL", () => {
    // The bug class this guard exists for. `file://${argvPath}` string-concat
    // produces an unencoded URL that never equals `import.meta.url`, so the
    // guard evaluates false, `runCli()` never runs, and the script exits 0
    // having checked nothing. Both a space and `#` trigger it.
    const scriptPath = join(repoRoot, "some dir #1", "check.mjs");
    const href = pathToFileURL(scriptPath).href;

    expect(isCliEntrypoint(href, scriptPath)).toBe(true);
    // Guard the exact expression that shipped broken.
    expect(href).not.toBe(`file://${scriptPath}`);
  });

  test("does not match a different script, and tolerates a missing argv[1]", () => {
    const scriptPath = join(repoRoot, "scripts", "a.mjs");
    const otherPath = join(repoRoot, "scripts", "b.mjs");

    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, otherPath)).toBe(false);
    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, undefined)).toBe(false);
  });
});

// The Windows CI lane silently passed `licenses:check` for months: the guard in
// generate-third-party-licenses.mjs compared `import.meta.url`
// (file:///D:/a/...) against `file://${process.argv[1]}` (file://D:\a\...), so
// runCli() never fired and the script exited 0 without checking anything. A
// check that fails open is worse than no check, so assert the CLIs actually
// speak. This runs the real scripts as subprocesses — the only way to exercise
// the module-level entrypoint guard.
describe("license CLIs report a result when run", () => {
  const cases = [
    {
      script: "scripts/check-package-license-policy.mjs",
      args: [],
      expected: /package license policy check (passed|failed)/,
    },
    {
      script: "scripts/generate-third-party-licenses.mjs",
      args: ["--check"],
      expected:
        /third-party license notice check passed|THIRD_PARTY_LICENSES is out of date|not installed on disk|pnpm licenses list/,
    },
  ];

  for (const { script, args, expected } of cases) {
    test(`${script} ${args.join(" ")} produces a verdict`, () => {
      const result = spawnSync(process.execPath, [join(repoRoot, script), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

      expect(output).not.toBe("");
      expect(output).toMatch(expected);
      // A pass must be a real pass, not an unfired entrypoint guard.
      if (result.status === 0) {
        expect(output).toMatch(/passed/);
      }
    });
  }
});
