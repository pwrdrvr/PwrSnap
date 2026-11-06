import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unitCompletionProblems } from "./retry-failures.mjs";

function selectionName(test) {
  if (!test.name) return test.fullName; // Reporter fixtures may supply only fullName.
  const names = [test.name];
  for (let parent = test.parent; parent && parent.type === "suite"; parent = parent.parent) names.unshift(parent.name);
  return names.join(" ");
}

// Keep this report separate from the JSON timings report and from console logs.
export default class CiRetryReporter {
  planned = [];
  finished = [];
  collected = [];
  startedTests = new Set();
  finishedTests = new Set();

  onInit(context) {
    this.context = context;
  }

  async onTestRunStart(specifications) {
    // Vitest announces the full workspace here, then applies the configured
    // sequencer's shard inside the pool. Use that same selection so the
    // completeness check covers this lane rather than every lane.
    const selected = this.context.config.shard
      ? await new this.context.config.sequence.sequencer(this.context).shard([...specifications])
      : specifications;
    this.planned = selected.map((specification) => JSON.stringify([specification.project.name, specification.moduleId]));
  }

  onTestModuleEnd(module) {
    this.finished.push(JSON.stringify([module.project.name, module.moduleId]));
  }

  onTestModuleCollected(module) {
    this.collected.push({
      key: JSON.stringify([module.project.name, module.moduleId]),
      ids: [...module.children.allTests()].map((test) => test.id),
    });
  }

  onTestCaseReady(test) {
    this.startedTests.add(test.id);
  }

  onTestCaseResult(test) {
    this.finishedTests.add(test.id);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const destination = process.env.PWRSNAP_CI_TEST_REPORT;
    if (!destination) throw new Error("PWRSNAP_CI_TEST_REPORT is required");
    const suites = modules.map((module) => ({
      project: module.project.name,
      file: module.moduleId,
      key: JSON.stringify([module.project.name, module.moduleId]),
      errors: module.errors().length
        + [...module.children.allSuites()].reduce((sum, suite) => sum + suite.errors().length, 0),
      tests: [...module.children.allTests()].map((test) => ({
        id: test.id,
        name: test.fullName,
        selectionName: selectionName(test),
        state: test.result().state,
        mode: test.options.mode,
        started: this.startedTests.has(test.id),
        completed: this.finishedTests.has(test.id),
      })),
    }));
    mkdirSync(path.dirname(destination), { recursive: true });
    const completedModules = new Set(this.finished);
    const problems = unitCompletionProblems({ reason, planned: this.planned, finished: this.finished, modules: suites, collected: this.collected });
    writeFileSync(destination, JSON.stringify({
      complete: problems.length === 0,
      reason,
      completion: {
        problems: problems.slice(0, 20),
        problemCount: problems.length,
        plannedModules: this.planned.length,
        finishedModules: this.finished.length,
        collectedTests: this.collected.reduce((sum, item) => sum + item.ids.length, 0),
        reportedTests: suites.reduce((sum, suite) => sum + suite.tests.length, 0),
        unfinishedModules: this.planned.filter((key) => !completedModules.has(key)).map((key) => JSON.parse(key)),
      },
      unhandledErrors: unhandledErrors.length,
      suites,
    }));
  }
}
