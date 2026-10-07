// The enrichment repair runner, against fake dependencies: how many runs
// it keeps in flight, budget pacing that never asks a low bucket, and the
// ways a job ends.

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

import {
  BUDGET_RESERVE,
  EnrichmentRepairRunner,
  repairBudgetReserve,
  type EnrichmentRepairDeps
} from "../enrichment-repair-job";

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
  /** Resolve the oldest run in flight. */
  finishRun: (status: AiRunStatus) => void;
  /** Run ids in flight, oldest first. */
  pending: () => string[];
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
  const pendingRuns = new Map<string, (status: AiRunStatus | null) => void>();
  const resolveRun = (runId: string | undefined, status: AiRunStatus | null): void => {
    if (runId === undefined) return;
    const resolve = pendingRuns.get(runId);
    pendingRuns.delete(runId);
    resolve?.(status);
  };
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
    cancelRun: async (runId) => resolveRun(runId, "cancelled"),
    waitForRun: (runId, signal) =>
      new Promise((resolve) => {
        pendingRuns.set(runId, resolve);
        signal.addEventListener("abort", () => resolveRun(runId, null), { once: true });
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
    finishRun: (status) => resolveRun(pendingRuns.keys().next().value, status),
    pending: () => [...pendingRuns.keys()],
    settle,
    last: () => published.at(-1) ?? null
  };
}

describe("EnrichmentRepairRunner", () => {
  test("by default runs one capture at a time and counts the outcomes", async () => {
    const h = harness({ ids: ["a", "b", "c"] });
    const runner = new EnrichmentRepairRunner(h.deps);
    const job = runner.start(CRITERIA);
    expect(job?.total).toBe(3);

    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()?.inFlight.map((entry) => entry.captureId)).toEqual(["a"]);
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
      inFlight: []
    });
    expect(runner.start(CRITERIA)).not.toBeNull();
  });

  test("keeps `concurrency` runs in flight, newest first, and refills as each one ends", async () => {
    const h = harness({ ids: ["a", "b", "c", "d", "e"] });
    const job = new EnrichmentRepairRunner(h.deps).start(CRITERIA, 3);
    expect(job?.concurrency).toBe(3);
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b", "c"]);
    expect(h.pending()).toEqual(["run-a", "run-b", "run-c"]);
    expect(h.last()?.inFlight.map((entry) => entry.captureId)).toEqual(["a", "b", "c"]);

    h.finishRun("completed");
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b", "c", "d"]);
    expect(h.last()?.inFlight.map((entry) => entry.captureId)).toEqual(["b", "c", "d"]);

    for (let i = 0; i < 4; i += 1) {
      h.finishRun(i === 0 ? "failed" : "completed");
      await h.settle();
    }
    expect(h.last()).toMatchObject({ state: "completed", processed: 5, succeeded: 4, failed: 1, inFlight: [] });
  });

  test("concurrency is clamped to 1–8", async () => {
    const many = harness({ ids: [] });
    expect(new EnrichmentRepairRunner(many.deps).start(CRITERIA, 50)?.concurrency).toBe(8);
    const none = harness({ ids: [] });
    expect(new EnrichmentRepairRunner(none.deps).start(CRITERIA, 0)?.concurrency).toBe(1);
  });

  test("the reserve shrinks with a small user-set burst, so a repair can still run", () => {
    expect(repairBudgetReserve(20)).toBe(BUDGET_RESERVE);
    expect(repairBudgetReserve(200)).toBe(BUDGET_RESERVE);
    expect(repairBudgetReserve(8)).toBe(2);
    // Never the last token while the bucket holds two or more.
    expect(repairBudgetReserve(3)).toBe(1);
    expect(repairBudgetReserve(2)).toBe(1);
    expect(repairBudgetReserve(1)).toBe(0);
  });

  test("parallel workers still check the bucket one at a time, so none digs into the reserve", async () => {
    // Only one token above the reserve: the first worker takes it, the
    // second must see the bucket after that dispatch and wait.
    const h = harness({
      ids: ["a", "b"],
      budgets: [budget(BUDGET_RESERVE + 1), budget(BUDGET_RESERVE), budget(BUDGET_RESERVE + 1)]
    });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA, 2);
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b"]);
    expect(h.sleeps).toHaveLength(1);
  });

  test("a run that starts while cancel is underway is cancelled too", async () => {
    let answer: (() => void) | null = null;
    const h = harness({ ids: ["a"] });
    const cancelled: string[] = [];
    const deps: EnrichmentRepairDeps = {
      ...h.deps,
      enrich: async (captureId) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return { ok: true, value: { runId: `run-${captureId}` } };
      },
      cancelRun: async (runId) => {
        cancelled.push(runId);
      }
    };
    const runner = new EnrichmentRepairRunner(deps);
    const job = runner.start(CRITERIA)!;
    await h.settle();
    await runner.cancel(job.jobId);
    expect(cancelled).toEqual([]);
    answer!();
    await h.settle();
    expect(cancelled).toEqual(["run-a"]);
  });

  test("once one worker stops the job, the others dispatch nothing new", async () => {
    const h = harness({
      ids: ["a", "b", "c", "d"],
      enrich: (id) => (id === "a" ? fail("read_failed") : { ok: true, value: { runId: `run-${id}` } })
    });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA, 4);
    await h.settle();
    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()).toMatchObject({ state: "stopped", stopReason: "Settings could not be read." });
  });

  test("cancel cancels every run in flight", async () => {
    const h = harness({ ids: ["a", "b", "c"] });
    const runner = new EnrichmentRepairRunner(h.deps);
    const job = runner.start(CRITERIA, 2)!;
    await h.settle();
    expect(h.pending()).toEqual(["run-a", "run-b"]);
    await runner.cancel(job.jobId);
    await h.settle();
    expect(h.pending()).toEqual([]);
    expect(h.dispatched).toEqual(["a", "b"]);
    expect(h.last()).toMatchObject({ state: "cancelled", inFlight: [] });
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
