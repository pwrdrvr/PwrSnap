import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import VitestReporter from "./vitest-ci-reporter.mjs";
import PlaywrightReporter from "./playwright-ci-reporter.mjs";

const directories = [];
afterEach(() => {
  delete process.env.PWRSNAP_CI_TEST_REPORT;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reportFile() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwrsnap-ci-reporter-"));
  directories.push(directory);
  process.env.PWRSNAP_CI_TEST_REPORT = path.join(directory, "report.json");
  return process.env.PWRSNAP_CI_TEST_REPORT;
}

describe("CI completion reporters", () => {
  it("requires exactly the Vitest modules selected by the lane's sequencer", async () => {
    for (let mask = 1; mask < 16; mask++) {
      const destination = reportFile();
      const project = { name: "desktop-main" };
      const all = Array.from({ length: 4 }, (_, i) => ({ project, moduleId: `/test-${i}` }));
      const selected = all.filter((_, i) => mask & (1 << i));
      class Sequencer {
        async shard() { return selected; }
      }
      const reporter = new VitestReporter();
      reporter.onInit({ config: { shard: { index: 1, count: 4 }, sequence: { sequencer: Sequencer } } });
      await reporter.onTestRunStart(all);
      const modules = selected.map((specification) => ({
        ...specification,
        errors: () => [],
        children: { allSuites: () => [], allTests: () => [] },
      }));
      for (const module of modules) {
        reporter.onTestModuleCollected(module);
        reporter.onTestModuleEnd(module);
      }
      reporter.onTestRunEnd(modules, [], "passed");
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(true);
      reporter.finished.pop();
      reporter.onTestRunEnd(modules, [], "passed");
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(false);
    }
  });

  it("distinguishes intentional Playwright skips from tests that never ran", () => {
    for (const [outcome, expectedStatus, results, complete] of [
      ["expected", "passed", [{ status: "passed" }], true],
      ["skipped", "skipped", [{ status: "skipped" }], true],
      ["skipped", "passed", [{ status: "skipped" }], false],
      ["skipped", "passed", [], false],
      ["unexpected", "passed", [{ status: "interrupted" }], false],
    ]) {
      const destination = reportFile();
      const reporter = new PlaywrightReporter();
      reporter.onBegin({}, { allTests: () => [{
        id: "test", titlePath: () => ["test"], outcome: () => outcome, expectedStatus, results,
      }] });
      reporter.onEnd({ status: "failed" });
      expect(JSON.parse(readFileSync(destination, "utf8")).complete).toBe(complete);
    }
  });

  it("compares each collected Vitest test ID with the module's final results", async () => {
    for (const change of ["none", "reorder", "missing", "extra", "replace", "duplicate"]) {
      const destination = reportFile();
      const project = { name: "desktop-main" };
      const specification = { project, moduleId: "/test" };
      const makeTest = (id) => ({ id, fullName: id, result: () => ({ state: "passed" }), options: { mode: "run" } });
      let tests = [makeTest("a"), makeTest("b")];
      const module = { ...specification, errors: () => [], children: { allSuites: () => [], allTests: () => tests } };
      const reporter = new VitestReporter();
      reporter.onInit({ config: { shard: null } });
      await reporter.onTestRunStart([specification]);
      reporter.onTestModuleCollected(module);
      if (change === "reorder") tests = tests.toReversed();
      if (change === "missing") tests.pop();
      if (change === "extra") tests.push(makeTest("c"));
      if (change === "replace") tests[1] = makeTest("c");
      if (change === "duplicate") tests[1] = makeTest("a");
      for (const test of tests) {
        test.module = module;
        reporter.onTestCaseReady(test);
        reporter.onTestCaseResult(test);
      }
      reporter.onTestModuleEnd(module);
      reporter.onTestRunEnd([module], [], "passed");
      expect(JSON.parse(readFileSync(destination, "utf8")).complete, change).toBe(change === "none" || change === "reorder");
    }
  });

  it("accepts a pending Vitest descendant only when its suite was skipped at collection and the result event arrived", async () => {
    for (const scenario of ["declared-skip", "skipped-test", "unrun", "late-skip", "missing-result", "failed-hook"]) {
      const destination = reportFile();
      const project = { name: "desktop-main" };
      const specification = { project, moduleId: "/test" };
      const parent = { type: "suite", options: { mode: scenario === "declared-skip" || scenario === "missing-result" ? "skip" : "run" }, parent: { type: "module" } };
      const test = { id: "a", fullName: "suite > a", parent,
        options: { mode: scenario === "skipped-test" ? "skip" : "run" }, result: () => ({ state: "pending" }) };
      const module = { ...specification, errors: () => [], children: {
        allSuites: () => [{ errors: () => scenario === "failed-hook" ? [new Error("hook")] : [] }],
        allTests: () => [test]
      } };
      const reporter = new VitestReporter();
      reporter.onInit({ config: { shard: null } });
      await reporter.onTestRunStart([specification]);
      reporter.onTestModuleCollected(module);
      if (scenario === "late-skip") parent.options.mode = "skip";
      test.module = module;
      reporter.onTestCaseReady(test);
      if (scenario !== "missing-result") reporter.onTestCaseResult(test);
      reporter.onTestModuleEnd(module);
      reporter.onTestRunEnd([module], [], "passed");
      const report = JSON.parse(readFileSync(destination, "utf8"));
      const permitted = scenario === "declared-skip" || scenario === "skipped-test";
      expect(report.complete, scenario).toBe(permitted);
      expect(report.suites[0].tests[0].state, scenario).toBe(permitted ? "skipped" : "pending");
      if (scenario === "failed-hook") expect(report.suites[0].errors).toBe(1);
    }
  });

  it("does not reuse a result event from another module with the same test ID", async () => {
    const destination = reportFile();
    const project = { name: "desktop-main" };
    const first = { project, moduleId: "/first" };
    const second = { project, moduleId: "/second" };
    const parent = { type: "suite", options: { mode: "skip" }, parent: { type: "module" } };
    const makeModule = (specification, state) => {
      const test = { id: "same", fullName: "test", parent, options: { mode: "run" }, result: () => ({ state }) };
      const module = { ...specification, errors: () => [], children: { allSuites: () => [], allTests: () => [test] } };
      test.module = module;
      return { module, test };
    };
    const a = makeModule(first, "skipped");
    const b = makeModule(second, "pending");
    const reporter = new VitestReporter();
    reporter.onInit({ config: { shard: null } });
    await reporter.onTestRunStart([first, second]);
    for (const { module } of [a, b]) reporter.onTestModuleCollected(module);
    reporter.onTestCaseReady(a.test);
    reporter.onTestCaseResult(a.test);
    for (const { module } of [a, b]) reporter.onTestModuleEnd(module);
    reporter.onTestRunEnd([a.module, b.module], [], "passed");
    const report = JSON.parse(readFileSync(destination, "utf8"));
    expect(report.complete).toBe(false);
    expect(report.suites[1].tests[0].state).toBe("pending");
    expect(report.suites[1].tests[0].completed).toBe(false);
  });

  it("compares Playwright's selected test IDs before and after execution", () => {
    for (const change of ["none", "reorder", "missing", "extra", "replace", "duplicate"]) {
      const destination = reportFile();
      const makeTest = (id) => ({ id, titlePath: () => [id], outcome: () => "expected", expectedStatus: "passed", results: [{ status: "passed" }] });
      let tests = [makeTest("a"), makeTest("b")];
      const reporter = new PlaywrightReporter();
      reporter.onBegin({}, { allTests: () => tests });
      if (change === "reorder") tests = tests.toReversed();
      if (change === "missing") tests.pop();
      if (change === "extra") tests.push(makeTest("c"));
      if (change === "replace") tests[1] = makeTest("c");
      if (change === "duplicate") tests[1] = makeTest("a");
      reporter.onEnd({ status: "passed" });
      expect(JSON.parse(readFileSync(destination, "utf8")).complete, change).toBe(change === "none" || change === "reorder");
    }
  });
});
