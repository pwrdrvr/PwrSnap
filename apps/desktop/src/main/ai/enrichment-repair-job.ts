// Background re-run of AI enrichment over captures whose last run failed,
// or that AI never saw.
//
// One job at a time, newest first, at most `concurrency` captures in
// flight. Each capture is enqueued through the dispatcher codex-handlers.ts
// returns (`EnrichmentRepairDispatcher`), which runs the same path as
// `codex:enrich` with one difference: it does not draw on the live
// enrichment budget.
//
// That exemption is why the job paces itself. The operator started
// this job from a preview that said how many snaps it covers, so it is not
// the runaway the token bucket (`AiEnrichmentBudget`) and its circuit
// breaker exist to catch. Sharing the bucket used to leave new captures a
// few tokens of headroom for the length of a re-run, and every capture the
// bucket then refused counted toward the breaker that turns AI OFF. So the
// job never touches the bucket. It paces itself instead: at most one run
// starts per refill interval of the rate limit in force (the user's steady
// rate, without the burst), and the concurrency limit caps what is in
// flight. Every other refusal still applies and ends the job: AI turned
// off, consent missing, or the breaker already tripped by live captures.
//
// The exemption cannot be claimed over the bus. `codex:enrich` always
// spends a token, whatever `triggerSource` a caller names; only this job,
// in the process that registered the codex handlers, holds the dispatcher.
//
// A local model is paced too. A loopback base URL does not make a run free
// (it can be a gateway to a paid API, and a fallback can be a hosted model),
// and PwrSnap does not infer pricing from a URL. A user who wants a backlog
// to go faster raises the rate limit in Settings → AI Features.
//
// The job lives in the process that owns `codex:*` (the agent, when the
// process split is on) and in memory only: a restart forgets it, and the
// boot sweep fails whatever run it had in flight.

import type {
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
/** Longest single sleep while waiting out the pace. */
export const MAX_PACE_SLICE_MS = 5_000;

/** Enqueue errors that end the job rather than one capture. */
const STOP_CODES: Record<string, string> = {
  ai_disabled: "AI enrichment was turned off.",
  ai_consent_required: "AI enrichment needs consent first.",
  ai_budget_safety_disabled: "AI enrichment was turned off for cost safety.",
  read_failed: "Settings could not be read."
};

export type EnrichmentRepairDeps = {
  listCaptureIds: (criteria: EnrichmentRepairCriteria) => string[];
  statusOf: (captureId: string) => EnrichmentRepairStatus | "other" | "gone";
  /** Least time between two starts; read before each one, so a rate-limit
   *  change in Settings applies to the rest of the job. */
  dispatchIntervalMs: () => Promise<number>;
  /** Enqueue one capture outside the live budget. */
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
  /** Serializes "wait for the pace, then dispatch" across workers, so N
   *  workers cannot all start at once. */
  dispatchTail: Promise<unknown>;
  /** When the last run started, for the pace. */
  lastStartAt: number | null;
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
      lastStartAt: null,
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
    const dispatched = await this.dispatchPaced(active, captureId);
    if (dispatched === null) return { kind: "skipped" };
    if (signal.aborted) {
      // Cancelled while the enqueue was answering: `cancel()` could not see
      // this run, so stop it here rather than leave it running.
      if (dispatched.ok) await this.deps.cancelRun(dispatched.value.runId);
      return { kind: "skipped" };
    }
    if (!dispatched.ok) {
      const code = dispatched.error.code;
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

  /** Wait out the pace, then dispatch, one worker at a time. Null when the
   *  job was cancelled or stopped first. */
  private dispatchPaced(
    active: ActiveJob,
    captureId: string
  ): Promise<Result<{ runId: string }, PwrSnapError> | null> {
    const turn = active.dispatchTail.then(async () => {
      if (active.stopReason !== null) return null;
      await this.waitForPace(active);
      if (active.abort.signal.aborted || active.stopReason !== null) return null;
      const result = await this.deps.enrich(captureId);
      // Only a run that started sets the pace: a refusal sent nothing to
      // the model.
      if (result.ok) active.lastStartAt = this.deps.now();
      return result;
    });
    active.dispatchTail = turn.catch(() => undefined);
    return turn;
  }

  /** Resolves once one interval has passed since the last start. The first
   *  start does not wait. Sleeps in slices and re-reads the interval after
   *  each, so raising the rate limit mid-wait takes effect within a slice
   *  rather than after a full interval (up to a minute at 1/min). */
  private async waitForPace(active: ActiveJob): Promise<void> {
    const lastStartAt = active.lastStartAt;
    if (lastStartAt === null) return;
    const { signal } = active.abort;
    for (;;) {
      const intervalMs = await this.deps.dispatchIntervalMs();
      const waitMs = lastStartAt + intervalMs - this.deps.now();
      if (waitMs <= 0 || signal.aborted) break;
      this.update(active, { waitingUntil: new Date(this.deps.now() + waitMs).toISOString() });
      await this.deps.sleep(Math.min(waitMs, MAX_PACE_SLICE_MS), signal);
    }
    if (active.job.waitingUntil !== null) this.update(active, { waitingUntil: null });
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
