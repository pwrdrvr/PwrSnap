// The enrichment repair runner, against fake dependencies: one run at a
// time, budget pacing that never asks a low bucket, and the ways a job
// ends.

import { describe, expect, test } from "vitest";
import type {
  AiEnrichmentBudgetStatus,
  AiRunStatus,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairStatus,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";

import { BUDGET_RESERVE, EnrichmentRepairRunner, type EnrichmentRepairDeps } from "../enrichment-repair-job";

const CRITERIA: EnrichmentRepairCriteria = {
  statuses: ["failed"],
  since: null,
  until: null,
  apps: { mode: "include", appIds: [] }
};

function budget(tokensAvailable: number, mode: AiEnrichmentBudgetStatus["mode"] = "available"): AiEnrichmentBudgetStatus {
  return {
    mode,
    tokensAvailable,
    capacity: 20,
    refillIntervalMs: 6_000,
    nextTokenAt: null,
    limitedAttemptsLastHour: 0,
    disableThreshold: 8,
    disabledAt: null
  };
}

function fail(code: string): Result<never, PwrSnapError> {
  return { ok: false, error: { kind: "validation", code, message: code } };
}

type Harness = {
  deps: EnrichmentRepairDeps;
  published: Array<EnrichmentRepairJob | null>;
  dispatched: string[];
  sleeps: number[];
  /** Resolve the in-flight run. */
  finishRun: (status: AiRunStatus) => void;
  /** Wait until the runner is blocked on a run (or done). */
  settle: () => Promise<void>;
  last: () => EnrichmentRepairJob | null;
};

function harness(opts: {
  ids: string[];
  statusOf?: (id: string) => EnrichmentRepairStatus | "other" | "gone";
  budgets?: AiEnrichmentBudgetStatus[];
  enrich?: (id: string, attempt: number) => Result<{ runId: string }, PwrSnapError>;
}): Harness {
  const published: Array<EnrichmentRepairJob | null> = [];
  const dispatched: string[] = [];
  const sleeps: number[] = [];
  const budgets = [...(opts.budgets ?? [])];
  let pendingRun: ((status: AiRunStatus | null) => void) | null = null;
  let clock = Date.parse("2026-10-07T12:00:00.000Z");
  let nextId = 0;
  const attempts = new Map<string, number>();
  const deps: EnrichmentRepairDeps = {
    listCaptureIds: () => [...opts.ids],
    statusOf: opts.statusOf ?? (() => "failed"),
    budgetStatus: async () => ({ ok: true, value: budgets.shift() ?? budget(20) }),
    enrich: async (captureId) => {
      dispatched.push(captureId);
      const attempt = (attempts.get(captureId) ?? 0) + 1;
      attempts.set(captureId, attempt);
      return opts.enrich?.(captureId, attempt) ?? { ok: true, value: { runId: `run-${captureId}` } };
    },
    cancelRun: async () => {
      pendingRun?.("cancelled");
    },
    waitForRun: (_runId, signal) =>
      new Promise((resolve) => {
        pendingRun = (status) => {
          pendingRun = null;
          resolve(status);
        };
        signal.addEventListener("abort", () => pendingRun?.(null), { once: true });
      }),
    publish: (job) => published.push(job),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    newId: () => `job-${++nextId}`
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  };
  return {
    deps,
    published,
    dispatched,
    sleeps,
    finishRun: (status) => pendingRun?.(status),
    settle,
    last: () => published.at(-1) ?? null
  };
}

describe("EnrichmentRepairRunner", () => {
  test("runs one capture at a time and counts the outcomes", async () => {
    const h = harness({ ids: ["a", "b", "c"] });
    const runner = new EnrichmentRepairRunner(h.deps);
    const job = runner.start(CRITERIA);
    expect(job?.total).toBe(3);

    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()?.currentCaptureId).toBe("a");
    h.finishRun("completed");
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b"]);
    h.finishRun("failed");
    await h.settle();
    h.finishRun("completed");
    await h.settle();

    expect(h.last()).toMatchObject({
      state: "completed",
      processed: 3,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      currentCaptureId: null
    });
    expect(runner.start(CRITERIA)).not.toBeNull();
  });

  test("skips captures that were repaired, run or deleted before their turn", async () => {
    const status: Record<string, EnrichmentRepairStatus | "other" | "gone"> = { a: "other", b: "gone", c: "never", d: "failed" };
    const h = harness({ ids: ["a", "b", "c", "d"], statusOf: (id) => status[id]! });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    // `c` never ran, but this job only asked for failed snaps.
    expect(h.dispatched).toEqual(["d"]);
    h.finishRun("completed");
    await h.settle();
    expect(h.last()).toMatchObject({ state: "completed", skipped: 3, succeeded: 1, processed: 4 });
  });

  test("never dispatches into the reserve new captures need", async () => {
    const h = harness({
      ids: ["a"],
      budgets: [budget(BUDGET_RESERVE), budget(BUDGET_RESERVE), budget(BUDGET_RESERVE + 1)]
    });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.sleeps).toHaveLength(2);
    expect(h.published.some((job) => job?.waitingUntil !== null)).toBe(true);
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()?.waitingUntil).toBeNull();
  });

  test("a dispatch the bucket refuses anyway is retried, not skipped", async () => {
    const h = harness({
      ids: ["a"],
      enrich: (id, attempt) => (attempt === 1 ? fail("ai_budget_limited") : { ok: true, value: { runId: `run-${id}` } })
    });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual(["a", "a"]);
    h.finishRun("completed");
    await h.settle();
    expect(h.last()).toMatchObject({ state: "completed", succeeded: 1, skipped: 0 });
  });

  test("stops when AI is turned off, and says why", async () => {
    const h = harness({ ids: ["a", "b"], enrich: () => fail("ai_disabled") });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()).toMatchObject({ state: "stopped", stopReason: "AI enrichment was turned off.", processed: 0 });
  });

  test("stops when the budget circuit breaker has fired", async () => {
    const h = harness({ ids: ["a"], budgets: [budget(0, "safety_disabled")] });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual([]);
    expect(h.last()?.state).toBe("stopped");
  });

  test("cancel stops the job and cancels the run in flight", async () => {
    const h = harness({ ids: ["a", "b"] });
    const runner = new EnrichmentRepairRunner(h.deps);
    const job = runner.start(CRITERIA)!;
    await h.settle();
    const cancelled = await runner.cancel(job.jobId);
    await h.settle();
    expect(cancelled?.state).toBe("cancelled");
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()?.state).toBe("cancelled");
  });

  test("one job at a time; a finished job stays until dismissed", async () => {
    const h = harness({ ids: ["a"] });
    const runner = new EnrichmentRepairRunner(h.deps);
    const job = runner.start(CRITERIA)!;
    expect(runner.start(CRITERIA)).toBeNull();
    runner.dismiss(job.jobId);
    expect(runner.status()?.jobId).toBe(job.jobId);
    await h.settle();
    h.finishRun("completed");
    await h.settle();
    expect(runner.status()?.state).toBe("completed");
    runner.dismiss(job.jobId);
    expect(runner.status()).toBeNull();
    expect(h.last()).toBeNull();
  });
});
