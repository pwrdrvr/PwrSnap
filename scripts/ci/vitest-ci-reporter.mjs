import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unitCompletionProblems } from "./retry-failures.mjs";

function selectionName(test) {
  if (!test.name) return test.fullName; // Reporter fixtures may supply only fullName.
  const names = [test.name];
  for (let parent = test.parent; parent && parent.type === "suite"; parent = parent.parent) names.unshift(parent.name);
  return names.join(" ");
}

function moduleKey(module) {
  return JSON.stringify([module.project.name, module.moduleId]);
}

function testKey(module, id) {
  return JSON.stringify([module.project.name, module.moduleId, id]);
}

// Keep this report separate from the JSON timings report and from console logs.
export default class CiRetryReporter {
  planned = [];
  finished = [];
  collected = [];
  startedTests = new Set();
  finishedTests = new Set();
  collectedSkips = new Map();

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
    this.finished.push(moduleKey(module));
  }

  onTestModuleCollected(module) {
    const key = moduleKey(module);
    const tests = [...module.children.allTests()];
    this.collected.push({ key, ids: tests.map((test) => test.id) });
    // Vitest can report a descendant of a skipped suite as pending at the end
    // even after sending its result event. Record the explicit skip before
    // execution; a later hook failure or interruption cannot manufacture it.
    const skipped = new Set();
    for (const test of tests) {
      let declaredSkip = test.options.mode === "skip" || test.options.mode === "todo";
      for (let parent = test.parent; parent?.type === "suite"; parent = parent.parent) {
        if (parent.options.mode === "skip" || parent.options.mode === "todo") declaredSkip = true;
      }
      if (declaredSkip) skipped.add(test.id);
    }
    this.collectedSkips.set(key, skipped);
  }

  onTestCaseReady(test) {
    this.startedTests.add(testKey(test.module, test.id));
  }

  onTestCaseResult(test) {
    this.finishedTests.add(testKey(test.module, test.id));
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const destination = process.env.PWRSNAP_CI_TEST_REPORT;
    if (!destination) throw new Error("PWRSNAP_CI_TEST_REPORT is required");
    const suites = modules.map((module) => ({
      project: module.project.name,
      file: module.moduleId,
      key: moduleKey(module),
      errors: module.errors().length
        + [...module.children.allSuites()].reduce((sum, suite) => sum + suite.errors().length, 0),
      tests: [...module.children.allTests()].map((test) => ({
        id: test.id,
        name: test.fullName,
        selectionName: selectionName(test),
        state: test.result().state === "pending"
          && this.finishedTests.has(testKey(module, test.id))
          && this.collectedSkips.get(moduleKey(module))?.has(test.id)
          ? "skipped" : test.result().state,
        mode: test.options.mode,
        started: this.startedTests.has(testKey(module, test.id)),
        completed: this.finishedTests.has(testKey(module, test.id)),
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
