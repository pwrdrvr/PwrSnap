import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { planE2eRetry, verifyE2eRetry } from "./retry-failures.mjs";

const root = path.resolve(".");
const cli = path.resolve("apps/desktop/node_modules/@playwright/test/cli.js");
const config = path.resolve("apps/desktop/scripts/ci-retry-fixtures/playwright.config.mjs");

test("Playwright retries exactly the failed IDs and rejects an interrupted selection", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwrsnap-playwright-retry-"));
  const last = path.join(directory, "last.json");
  const run = (phase, name, extra = []) => {
    const report = path.join(directory, `${name}.json`);
    const result = spawnSync(process.execPath, [cli, "test", "-c", config, ...extra], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "1", PWRSNAP_RETRY_FIXTURE_PHASE: phase,
        PWRSNAP_CI_TEST_REPORT: report, PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: last }
    });
    return { result, report: JSON.parse(readFileSync(report, "utf8")), last: JSON.parse(readFileSync(last, "utf8")) };
  };
  try {
    const first = run("first", "first");
    expect(first.result.status).toBe(1);
    const plan = planE2eRetry(first.report, first.last, 20);
    expect(plan.tests).toHaveLength(2);
    const retry = run("retry", "retry", ["--last-failed"]);
    expect(retry.result.status, retry.result.stderr).toBe(0);
    expect(verifyE2eRetry(plan, retry.report)).toBe(true);
    const interrupted = run("first", "interrupted", ["--max-failures=1"]);
    expect(interrupted.report.complete).toBe(false);
    expect(() => planE2eRetry(interrupted.report, interrupted.last, 20)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
