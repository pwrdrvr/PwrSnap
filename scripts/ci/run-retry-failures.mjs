import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { groupUnitRetries, planE2eRetry, planUnitRetry, unitRetryNamePattern, verifyE2eRetry, verifyInitialE2eRun, verifyInitialUnitRun, verifyUnitRetry } from "./retry-failures.mjs";

const directory = path.resolve(process.env.PWRSNAP_CI_RETRY_DIR || ".local/ci/retry");
const read = (name) => JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};
const budget = 20;

function retryUnits() {
  const first = read("unit-first.json");
  const failed = first?.suites?.flatMap((suite) => suite.tests ?? []).filter((test) => test.state === "failed").length ?? 0;
  summary(`Unit retry budget: ${failed}/${budget} initially failed tests.`);
  const plan = planUnitRetry(first, budget);
  summary(`### Unit retry: ${plan.tests.length} initially failed test(s), budget ${budget}`);
  for (const test of plan.tests) {
    summary(`- ${test.project}: ${test.file} — ${test.name}`);
  }
  let passed = true;
  let index = 0;
  for (const { project, files, tests } of groupUnitRetries(plan, first)) {
    const pattern = unitRetryNamePattern(tests);
    // Vitest file filters are substring matches. Prove discovery selects exactly
    // these files before executing any test, or a passing file could run again.
    if (!/^[\w-]+$/.test(project)) throw new Error("Ambiguous project filter");
    const listing = spawnSync(process.execPath, [
      path.resolve("node_modules/vitest/vitest.mjs"), "list", "--config", "vitest.workspace.ts",
      `--project=${project}`, ...files, "--filesOnly", "--json",
    ], { encoding: "utf8", env: process.env });
    let selected;
    try { selected = JSON.parse(listing.stdout); } catch { throw new Error("Could not verify unit file selection"); }
    const expected = new Set(files.map((file) => path.resolve(file)));
    if (listing.status !== 0 || !Array.isArray(selected) || selected.length !== expected.size
      || selected.some((item) => item.projectName !== project || !expected.delete(path.resolve(item.file))) || expected.size) {
      throw new Error("Unit file filter selected an unexpected or missing file");
    }
    // Vitest's name filter differs from its displayed names. Check the
    // collected filtered identities as well as the files before execution.
    const names = spawnSync(process.execPath, [
      path.resolve("node_modules/vitest/vitest.mjs"), "list", "--config", "vitest.workspace.ts",
      `--project=${project}`, ...files, "--testNamePattern", pattern, "--json",
    ], { encoding: "utf8", env: process.env });
    let selectedNames;
    try { selectedNames = JSON.parse(names.stdout); } catch { throw new Error("Could not verify unit test selection"); }
    const expectedNames = new Set(tests.map((test) => JSON.stringify([path.resolve(test.file), test.name])));
    if (expectedNames.size !== tests.length || names.status !== 0 || !Array.isArray(selectedNames)
      || selectedNames.length !== expectedNames.size || selectedNames.some((item) => item.projectName !== project
        || !expectedNames.delete(JSON.stringify([path.resolve(item.file), item.name]))) || expectedNames.size) {
      throw new Error("Unit name filter selected an unexpected or missing test");
    }
    const report = path.join(directory, `unit-retry-${index++}.json`);
    rmSync(report, { force: true });
    const result = spawnSync(process.execPath, [
      path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.workspace.ts",
      `--project=${project}`, ...files, "--testNamePattern", pattern,
      "--reporter=default", "--reporter=./scripts/ci/vitest-ci-reporter.mjs",
    ], { stdio: "inherit", env: { ...process.env, PWRSNAP_CI_TEST_REPORT: report } });
    let valid = false;
    try {
      valid = result.status === 0 && verifyUnitRetry({ tests }, JSON.parse(readFileSync(report, "utf8")));
    } catch {
      // A missing report or crashed process cannot clear the original failure.
    }
    if (!valid) passed = false;
  }
  summary(passed ? "All selected unit tests passed on retry." : "Unit retry failed or did not run the selected tests.");
  if (!passed) process.exitCode = 1;
}

function prepareE2e() {
  const first = read("e2e-first.json");
  const failed = first.tests?.filter((test) => test.outcome === "unexpected").length ?? 0;
  summary(`E2E retry budget: ${failed}/${budget} initially failed tests.`);
  const plan = planE2eRetry(first, read("e2e-last.json"), budget);
  summary(`### E2E retry: ${plan.tests.length} initially failed test(s), budget ${budget}`);
  for (const test of plan.tests) summary(`- ${test.name}`);
  // Playwright clears these locations at startup. Preserve the first attempt.
  for (const name of ["test-results", "playwright-report"]) {
    const source = path.resolve("apps/desktop", name);
    if (existsSync(source)) cpSync(source, path.join(directory, `first-${name}`), { recursive: true });
  }
}

function verifyE2e() {
  const plan = planE2eRetry(read("e2e-first.json"), read("e2e-first-last.json"), budget);
  const passed = process.env.PWRSNAP_RETRY_OUTCOME === "success" && verifyE2eRetry(plan, read("e2e-retry.json"));
  summary(passed ? "All selected E2E tests passed on retry." : "E2E retry failed or did not run the selected tests.");
  if (!passed) process.exitCode = 1;
}

try {
  mkdirSync(directory, { recursive: true });
  switch (process.argv[2]) {
    case "unit": retryUnits(); break;
    case "unit-verify": {
      const report = read("unit-first.json");
      if (!verifyInitialUnitRun(report)) throw new Error("The unit slice did not complete successfully");
      const tests = report.suites.flatMap((suite) => suite.tests);
      const passed = tests.filter((test) => test.state === "passed").length;
      summary(`Unit retry budget: 0/${budget} initially failed tests.`);
      summary(`Unit slice completed: ${tests.length} discovered, ${passed} passed, ${tests.length - passed} skipped.`);
      break;
    }
    case "e2e-first-verify": {
      const report = read("e2e-first.json");
      if (!verifyInitialE2eRun(report)) throw new Error("The E2E slice did not complete successfully");
      const expected = report.tests.filter((test) => test.outcome === "expected").length;
      summary(`E2E retry budget: 0/${budget} initially failed tests.`);
      summary(`E2E slice completed: ${report.tests.length} discovered, ${expected} expected outcomes, ${report.tests.length - expected} skipped.`);
      break;
    }
    case "e2e-prepare":
      prepareE2e();
      cpSync(path.join(directory, "e2e-last.json"), path.join(directory, "e2e-first-last.json"));
      break;
    case "e2e-verify": verifyE2e(); break;
    default: throw new Error("Unknown CI test verification command");
  }
} catch (error) {
  summary(`Retry unavailable: ${error.message}`);
  process.exitCode = 1;
}
