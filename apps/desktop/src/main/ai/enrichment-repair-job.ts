// Background re-run of AI enrichment over captures whose last run failed,
// or that AI never saw.
//
// One job at a time, one capture at a time, newest first. Each capture is
// dispatched through `codex:enrich` like a Regenerate click, and the job
// waits for that run to finish before starting the next, so a repair of
// hundreds of snaps never has more than one turn of its own in flight.
//
// Pacing is the part that matters. Enrichment shares one token bucket
// (`AiEnrichmentBudget`) with every new capture, and a dispatch the bucket
// refuses is counted toward the circuit breaker that turns AI OFF for the
// user. So the job never asks while the bucket is low: it holds
// `BUDGET_RESERVE` tokens back for live captures and waits for the refill
// instead. A refusal that still slips through (a capture landed between
// the check and the dispatch) is retried after a refill, never skipped.
//
// The job lives in the process that owns `codex:*` (the agent, when the
// process split is on) and in memory only: a restart forgets it, and the
// boot sweep fails whatever run it had in flight.

import type {
  AiEnrichmentBudgetStatus,
  AiRunStatus,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairStatus,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";

/** Most snaps one repair keeps in flight. A connection's own limit
 *  (Settings → AI Providers) still caps what reaches its endpoint. */
export const MAX_REPAIR_CONCURRENCY = 8;
/** Tokens left in the bucket for new captures while a repair runs. */
export const BUDGET_RESERVE = 5;

/** The reserve for a bucket of `capacity`: a quarter of it, at most
 *  `BUDGET_RESERVE`, so a small user-set burst still lets a repair run. At
 *  least one token whenever the bucket holds two: a repair that takes the
 *  last token sends the next new capture into slow mode, and slow-mode
 *  attempts count toward the breaker that turns AI off. Only a one-token
 *  bucket gets no reserve, since a repair could otherwise never start. */
export function repairBudgetReserve(capacity: number): number {
  if (capacity < 2) return 0;
  return Math.max(1, Math.min(BUDGET_RESERVE, Math.floor(capacity / 4)));
}
/** Longest single wait for the bucket, so a cancel or a settings change is
 *  noticed even if `nextTokenAt` is far off. */
const MAX_BUDGET_WAIT_MS = 30_000;
const MIN_BUDGET_WAIT_MS = 1_000;
/** Pause after a dispatch the bucket refused anyway: one refill interval. */
const LIMITED_RETRY_MS = 6_000;

/** Errors from `codex:enrich` that end the job rather than one capture. */
const STOP_CODES: Record<string, string> = {
  ai_disabled: "AI enrichment was turned off.",
  ai_consent_required: "AI enrichment needs consent first.",
  ai_budget_safety_disabled: "AI enrichment was turned off for cost safety.",
  read_failed: "Settings could not be read."
};

export type EnrichmentRepairDeps = {
  listCaptureIds: (criteria: EnrichmentRepairCriteria) => string[];
  statusOf: (captureId: string) => EnrichmentRepairStatus | "other" | "gone";
  budgetStatus: () => Promise<Result<AiEnrichmentBudgetStatus, PwrSnapError>>;
  enrich: (captureId: string) => Promise<Result<{ runId: string }, PwrSnapError>>;
  cancelRun: (runId: string) => Promise<void>;
  /** Resolves with the run's terminal status, or null if `signal` aborts
   *  first. */
  waitForRun: (runId: string, signal: AbortSignal) => Promise<AiRunStatus | null>;
  publish: (job: EnrichmentRepairJob | null) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  newId: () => string;
};

type ActiveJob = {
  job: EnrichmentRepairJob;
  abort: AbortController;
  /** Run id per capture in flight, for cancel. */
  runs: Map<string, string>;
  /** Serializes "check the bucket, then dispatch" across workers, so N
   *  workers cannot all see the same spare token and dig into the reserve. */
  dispatchTail: Promise<unknown>;
  /** Set by the first worker that hits a job-ending error. Workers queued
   *  behind it on `dispatchTail` check it before dispatching anything new. */
  stopReason: string | null;
};

type Outcome = { kind: "succeeded" | "failed" | "skipped" } | { kind: "stop"; reason: string };

export class EnrichmentRepairRunner {
  private active: ActiveJob | null = null;
  /** The current job, or the last finished one until it is dismissed. */
  private latest: EnrichmentRepairJob | null = null;

  constructor(private readonly deps: EnrichmentRepairDeps) {}

  status(): EnrichmentRepairJob | null {
    return this.latest;
  }

  /** Starts a job, or returns null when one is already running. */
  start(criteria: EnrichmentRepairCriteria, concurrency = 1): EnrichmentRepairJob | null {
    if (this.active !== null) return null;
    const ids = this.deps.listCaptureIds(criteria);
    const job: EnrichmentRepairJob = {
      jobId: this.deps.newId(),
      state: "running",
      criteria,
      concurrency: Math.max(1, Math.min(MAX_REPAIR_CONCURRENCY, Math.floor(concurrency))),
      total: ids.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      inFlight: [],
      waitingUntil: null,
      stopReason: null,
      startedAt: this.iso(),
      finishedAt: null
    };
    const active: ActiveJob = {
      job,
      abort: new AbortController(),
      runs: new Map(),
      dispatchTail: Promise.resolve(),
      stopReason: null
    };
    this.active = active;
    this.latest = job;
    this.deps.publish(job);
    void this.run(active, ids);
    return job;
  }

  async cancel(jobId: string): Promise<EnrichmentRepairJob | null> {
    const active = this.active;
    if (active === null || active.job.jobId !== jobId) return this.latest;
    const runIds = [...active.runs.values()];
    active.abort.abort();
    this.finish(active, "cancelled", null);
    await Promise.all(runIds.map((runId) => this.deps.cancelRun(runId)));
    return this.latest;
  }

  dismiss(jobId: string): void {
    if (this.latest?.jobId !== jobId || this.active?.job.jobId === jobId) return;
    this.latest = null;
    this.deps.publish(null);
  }

  /** `concurrency` workers pull from one newest-first list. */
  private async run(active: ActiveJob, ids: readonly string[]): Promise<void> {
    const { signal } = active.abort;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted && active.stopReason === null && next < ids.length) {
        const captureId = ids[next++]!;
        const status = this.deps.statusOf(captureId);
        if (status === "gone" || status === "other" || !active.job.criteria.statuses.includes(status)) {
          this.update(active, { skipped: active.job.skipped + 1, processed: active.job.processed + 1 });
          continue;
        }
        const outcome = await this.runOne(active, captureId);
        if (signal.aborted) return;
        if (outcome.kind === "stop") {
          active.stopReason ??= outcome.reason;
          return;
        }
        this.update(active, {
          processed: active.job.processed + 1,
          ...(outcome.kind === "succeeded"
            ? { succeeded: active.job.succeeded + 1 }
            : outcome.kind === "skipped"
              ? { skipped: active.job.skipped + 1 }
              : { failed: active.job.failed + 1 })
        });
      }
    };
    try {
      await Promise.all(Array.from({ length: active.job.concurrency }, () => worker()));
      if (signal.aborted) return;
      if (active.stopReason !== null) this.finish(active, "stopped", active.stopReason);
      else this.finish(active, "completed", null);
    } catch (error) {
      if (!signal.aborted) {
        this.finish(active, "stopped", error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async runOne(active: ActiveJob, captureId: string): Promise<Outcome> {
    const { signal } = active.abort;
    for (;;) {
      const dispatched = await this.dispatchPaced(active, captureId);
      if (dispatched === null) return { kind: "skipped" };
      if (signal.aborted) {
        // Cancelled while `codex:enrich` was answering: `cancel()` could not
        // see this run, so stop it here rather than leave it running.
        if (!("kind" in dispatched) && dispatched.ok) await this.deps.cancelRun(dispatched.value.runId);
        return { kind: "skipped" };
      }
      if ("kind" in dispatched) return dispatched;
      if (!dispatched.ok) {
        const code = dispatched.error.code;
        if (code === "ai_budget_limited") {
          // Lost a race with a new capture for the last token. Wait for the
          // refill and try the SAME capture again.
          await this.deps.sleep(LIMITED_RETRY_MS, signal);
          continue;
        }
        const stopReason = STOP_CODES[code];
        if (stopReason !== undefined) return { kind: "stop", reason: stopReason };
        return code === "not_found" ? { kind: "skipped" } : { kind: "failed" };
      }

      const runId = dispatched.value.runId;
      active.runs.set(captureId, runId);
      this.update(active, { inFlight: [...active.job.inFlight, { captureId, startedAt: this.iso() }] });
      const terminal = await this.deps.waitForRun(runId, signal);
      active.runs.delete(captureId);
      this.update(active, { inFlight: active.job.inFlight.filter((run) => run.captureId !== captureId) });
      return { kind: terminal === "completed" ? "succeeded" : "failed" };
    }
  }

  /** Wait for budget above the reserve, then dispatch, one worker at a time.
   *  Null when the job was cancelled while waiting. */
  private dispatchPaced(
    active: ActiveJob,
    captureId: string
  ): Promise<Result<{ runId: string }, PwrSnapError> | { kind: "stop"; reason: string } | null> {
    const turn = active.dispatchTail.then(async () => {
      if (active.stopReason !== null) return null;
      const paced = await this.waitForBudget(active);
      if (paced !== null) return paced;
      if (active.abort.signal.aborted || active.stopReason !== null) return null;
      return this.deps.enrich(captureId);
    });
    active.dispatchTail = turn.catch(() => undefined);
    return turn;
  }

  /** Null once a token above the reserve is free; a stop outcome when the
   *  bucket says AI is off. */
  private async waitForBudget(active: ActiveJob): Promise<{ kind: "stop"; reason: string } | null> {
    const { signal } = active.abort;
    for (;;) {
      if (signal.aborted) return null;
      const budget = await this.deps.budgetStatus();
      if (!budget.ok) return { kind: "stop", reason: budget.error.message };
      if (budget.value.mode === "safety_disabled") {
        return { kind: "stop", reason: STOP_CODES.ai_budget_safety_disabled! };
      }
      if (budget.value.tokensAvailable >= repairBudgetReserve(budget.value.capacity) + 1) {
        if (active.job.waitingUntil !== null) this.update(active, { waitingUntil: null });
        return null;
      }
      const next = budget.value.nextTokenAt === null ? Number.NaN : Date.parse(budget.value.nextTokenAt);
      const untilNext = Number.isFinite(next) ? next - this.deps.now() : budget.value.refillIntervalMs;
      const waitMs = Math.min(MAX_BUDGET_WAIT_MS, Math.max(MIN_BUDGET_WAIT_MS, untilNext));
      this.update(active, { waitingUntil: new Date(this.deps.now() + waitMs).toISOString() });
      await this.deps.sleep(waitMs, signal);
    }
  }

  private finish(
    active: ActiveJob,
    state: EnrichmentRepairJob["state"],
    stopReason: string | null
  ): void {
    if (this.active !== active) return;
    this.update(active, {
      state,
      stopReason,
      inFlight: [],
      waitingUntil: null,
      finishedAt: this.iso()
    });
    this.active = null;
  }

  private update(active: ActiveJob, patch: Partial<EnrichmentRepairJob>): void {
    if (this.active !== active) return;
    active.job = { ...active.job, ...patch };
    this.latest = active.job;
    this.deps.publish(active.job);
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }
}
