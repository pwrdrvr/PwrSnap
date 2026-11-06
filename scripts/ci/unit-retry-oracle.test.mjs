import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(".");
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const fixture = "scripts/ci/fixtures/retry-execution.fixture.test.mjs";

test("the unit runner executes only the initially failed case in the prepared workspace", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwrsnap-unit-retry-"));
  try {
    const first = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.workspace.ts",
      "--project=desktop-main", fixture, "--reporter=./scripts/ci/vitest-ci-reporter.mjs"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PWRSNAP_UNIT_ORACLE_PHASE: "first",
        PWRSNAP_CI_TEST_REPORT: path.join(directory, "unit-first.json") }
    });
    expect(first.status, first.stderr).toBe(1);
    const retry = spawnSync(process.execPath, ["scripts/ci/run-retry-failures.mjs", "unit"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PWRSNAP_UNIT_ORACLE_PHASE: "retry",
        PWRSNAP_CI_RETRY_DIR: directory }
    });
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    const report = JSON.parse(readFileSync(path.join(directory, "unit-retry-0.json"), "utf8"));
    expect(report.suites.flatMap((suite) => suite.tests).filter((item) => item.state === "passed").map((item) => item.name)).toEqual(["failed first"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
