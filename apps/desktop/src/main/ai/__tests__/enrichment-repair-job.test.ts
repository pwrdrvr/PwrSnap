// The enrichment repair runner, against fake dependencies: how many runs
// it keeps in flight, its own pace between starts (it never reads the live
// enrichment budget), and the ways a job ends.

import { describe, expect, test } from "vitest";
import type {
  AiRunStatus,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairStatus,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";

import {
  EnrichmentRepairRunner,
  MAX_PACE_SLICE_MS,
  type EnrichmentRepairDeps
} from "../enrichment-repair-job";

const CRITERIA: EnrichmentRepairCriteria = {
  statuses: ["failed"],
  since: null,
  until: null,
  apps: { mode: "include", appIds: [] }
};

/** Under one slice, so each wait is a single sleep. */
const INTERVAL_MS = 4_000;

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
  /** Pace per start, read before each one; defaults to 0 (unpaced). */
  intervals?: number[];
  enrich?: (id: string) => Result<{ runId: string }, PwrSnapError>;
}): Harness {
  const published: Array<EnrichmentRepairJob | null> = [];
  const dispatched: string[] = [];
  const sleeps: number[] = [];
  const intervals = [...(opts.intervals ?? [])];
  const pendingRuns = new Map<string, (status: AiRunStatus | null) => void>();
  const resolveRun = (runId: string | undefined, status: AiRunStatus | null): void => {
    if (runId === undefined) return;
    const resolve = pendingRuns.get(runId);
    pendingRuns.delete(runId);
    resolve?.(status);
  };
  let clock = Date.parse("2026-10-07T12:00:00.000Z");
  let nextId = 0;
  const deps: EnrichmentRepairDeps = {
    listCaptureIds: () => [...opts.ids],
    statusOf: opts.statusOf ?? (() => "failed"),
    dispatchIntervalMs: async () => (intervals.length > 1 ? intervals.shift()! : intervals[0] ?? 0),
    enrich: async (captureId) => {
      dispatched.push(captureId);
      return opts.enrich?.(captureId) ?? { ok: true, value: { runId: `run-${captureId}` } };
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

  test("starts at most one run per interval, even with several workers", async () => {
    const h = harness({ ids: ["a", "b", "c"], intervals: [INTERVAL_MS] });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA, 3);
    await h.settle();
    // The first start does not wait; each later one waits a full interval
    // after the one before it, one worker at a time.
    expect(h.dispatched).toEqual(["a", "b", "c"]);
    expect(h.sleeps).toEqual([INTERVAL_MS, INTERVAL_MS]);
    expect(h.published.some((job) => job?.waitingUntil !== null)).toBe(true);
    expect(h.last()?.waitingUntil).toBeNull();
  });

  test("a run that took longer than the interval starts the next one at once", async () => {
    const h = harness({ ids: ["a", "b"], intervals: [INTERVAL_MS] });
    let clock = Date.parse("2026-10-07T12:00:00.000Z");
    const deps: EnrichmentRepairDeps = { ...h.deps, now: () => clock };
    new EnrichmentRepairRunner(deps).start(CRITERIA);
    await h.settle();
    clock += INTERVAL_MS * 3;
    h.finishRun("completed");
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b"]);
    expect(h.sleeps).toEqual([]);
  });

  test("a long wait sleeps in slices and notices a raised rate limit within one", async () => {
    // 1/min, then the user raises it to 6/min while the job is waiting.
    const h = harness({ ids: ["a", "b"], intervals: [60_000, 10_000] });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA, 2);
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b"]);
    expect(h.sleeps).toEqual([MAX_PACE_SLICE_MS, MAX_PACE_SLICE_MS]);
  });

  test("re-reads the interval before each start, so a rate-limit change applies mid-job", async () => {
    const h = harness({ ids: ["a", "b", "c"], intervals: [INTERVAL_MS, 1_000] });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA, 3);
    await h.settle();
    expect(h.sleeps).toEqual([INTERVAL_MS, 1_000]);
  });

  test("a refused enqueue does not hold back the next start", async () => {
    const h = harness({
      ids: ["a", "b"],
      intervals: [INTERVAL_MS],
      enrich: (id) => (id === "a" ? fail("not_found") : { ok: true, value: { runId: `run-${id}` } })
    });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual(["a", "b"]);
    expect(h.sleeps).toEqual([]);
  });

  test("cancel during the pace dispatches nothing more", async () => {
    const h = harness({ ids: ["a", "b"], intervals: [INTERVAL_MS] });
    let pacing = false;
    const deps: EnrichmentRepairDeps = {
      ...h.deps,
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          pacing = true;
          signal.addEventListener("abort", () => resolve(), { once: true });
        })
    };
    const runner = new EnrichmentRepairRunner(deps);
    const job = runner.start(CRITERIA, 2)!;
    await h.settle();
    expect(pacing).toBe(true);
    await runner.cancel(job.jobId);
    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()?.state).toBe("cancelled");
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

  test("stops when AI is turned off, and says why", async () => {
    const h = harness({ ids: ["a", "b"], enrich: () => fail("ai_disabled") });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()).toMatchObject({ state: "stopped", stopReason: "AI enrichment was turned off.", processed: 0 });
  });

  test("stops when live captures have tripped the cost-safety breaker", async () => {
    const h = harness({ ids: ["a", "b"], enrich: () => fail("ai_budget_safety_disabled") });
    new EnrichmentRepairRunner(h.deps).start(CRITERIA);
    await h.settle();
    expect(h.dispatched).toEqual(["a"]);
    expect(h.last()).toMatchObject({
      state: "stopped",
      stopReason: "AI enrichment was turned off for cost safety.",
      processed: 0
    });
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
