// `codex:repair:*` — the enrichment repair dialog's verbs. The job itself is
// in ai/enrichment-repair-job.ts; this file validates renderer input and
// wires the job to the bus, the database and the event fan-out.
//
// The `codex:` prefix is deliberate: it routes these verbs to the process
// that owns `codex:enrich` (the agent, under the process split), so the
// job runs beside the enrichment it dispatches.

import { nanoid } from "nanoid";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type AiRunStatus,
  type EnrichmentRepairCriteria,
  type EnrichmentRepairJob,
  type EnrichmentRepairStatus,
  type PwrSnapError,
  type Result
} from "@pwrsnap/shared";
import { observeAiRuns } from "../ai/ai-run-observers";
import { EnrichmentRepairRunner, type EnrichmentRepairDeps } from "../ai/enrichment-repair-job";
import { bus } from "../command-bus";
import { broadcastRendererEventToLocalWindows } from "../events";
import { getMainLogger } from "../log";
import { getAiRun } from "../persistence/ai-runs-repo";
import {
  enrichmentRepairStatusOf,
  listEnrichmentRepairCaptureIds,
  previewEnrichmentRepair
} from "../persistence/enrichment-repair-repo";
import { relayRendererEventToPeer } from "../process-split/event-relay";

const log = getMainLogger("pwrsnap:enrichment-repair");

const TERMINAL: ReadonlySet<AiRunStatus> = new Set(["completed", "failed", "cancelled"]);
/** Backstop for a missed run broadcast; the observer normally answers first. */
const RUN_POLL_MS = 5_000;
const MAX_APP_IDS = 500;
const MAX_APP_ID_LENGTH = 512;

function invalid(message: string): Result<never, PwrSnapError> {
  return err({ kind: "validation", code: "invalid_request", message });
}

function isIsoOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)));
}

/** Renderer input is untrusted: rebuild the criteria from checked parts. */
export function parseRepairCriteria(raw: unknown): EnrichmentRepairCriteria | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const statuses = value.statuses;
  if (!Array.isArray(statuses) || statuses.length === 0) return null;
  const parsedStatuses: EnrichmentRepairStatus[] = [];
  for (const status of statuses) {
    if (status !== "failed" && status !== "never") return null;
    if (!parsedStatuses.includes(status)) parsedStatuses.push(status);
  }
  if (!isIsoOrNull(value.since) || !isIsoOrNull(value.until)) return null;
  const apps = value.apps;
  if (typeof apps !== "object" || apps === null) return null;
  const { mode, appIds } = apps as Record<string, unknown>;
  if (mode !== "include" && mode !== "exclude") return null;
  if (!Array.isArray(appIds) || appIds.length > MAX_APP_IDS) return null;
  if (!appIds.every((id): id is string => typeof id === "string" && id.length <= MAX_APP_ID_LENGTH)) {
    return null;
  }
  return {
    statuses: parsedStatuses,
    since: value.since,
    until: value.until,
    apps: { mode, appIds: [...new Set(appIds)] }
  };
}

function publishJob(job: EnrichmentRepairJob | null): void {
  if (job !== null && job.finishedAt !== null) {
    log.info("enrichment repair finished", {
      jobId: job.jobId,
      state: job.state,
      stopReason: job.stopReason,
      total: job.total,
      succeeded: job.succeeded,
      failed: job.failed,
      skipped: job.skipped
    });
  }
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.enrichmentRepairJob, { job });
  relayRendererEventToPeer(EVENT_CHANNELS.enrichmentRepairJob, { job });
}

function waitForRun(runId: string, signal: AbortSignal): Promise<AiRunStatus | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status: AiRunStatus | null): void => {
      if (settled) return;
      settled = true;
      stopObserving();
      clearInterval(poll);
      signal.removeEventListener("abort", onAbort);
      resolve(status);
    };
    const check = (): void => {
      const run = getAiRun(runId);
      if (run === null) settle("failed");
      else if (TERMINAL.has(run.status)) settle(run.status);
    };
    const onAbort = (): void => settle(null);
    // Subscribe BEFORE the first read so a run that finishes in between is
    // seen by one or the other.
    const stopObserving = observeAiRuns((run) => {
      if (run.id === runId && TERMINAL.has(run.status)) settle(run.status);
    });
    const poll = setInterval(check, RUN_POLL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) settle(null);
    else check();
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

const productionDeps: EnrichmentRepairDeps = {
  listCaptureIds: listEnrichmentRepairCaptureIds,
  statusOf: enrichmentRepairStatusOf,
  budgetStatus: () => bus.dispatch("codex:budgetStatus", {}, { principal: "ipc" }),
  enrich: (captureId) =>
    bus.dispatch(
      "codex:enrich",
      { captureId, triggerSource: "library-repair" },
      { principal: "ipc", cancellationKey: captureId }
    ),
  cancelRun: async (runId) => {
    const result = await bus.dispatch("codex:cancel", { runId }, { principal: "ipc" });
    if (!result.ok) log.warn("repair could not cancel its run", { runId, code: result.error.code });
  },
  waitForRun,
  publish: publishJob,
  sleep,
  now: () => Date.now(),
  newId: () => nanoid()
};

export function registerEnrichmentRepairHandlers(deps: EnrichmentRepairDeps = productionDeps): void {
  const runner = new EnrichmentRepairRunner(deps);

  bus.register("codex:repair:preview", async (req) => {
    const criteria = parseRepairCriteria(req.criteria);
    if (criteria === null) return invalid("invalid repair criteria");
    return ok(previewEnrichmentRepair(criteria));
  });

  bus.register("codex:repair:start", async (req) => {
    const criteria = parseRepairCriteria(req.criteria);
    if (criteria === null) return invalid("invalid repair criteria");
    const job = runner.start(criteria);
    if (job === null) {
      return err({ kind: "validation", code: "already_running", message: "a repair is already running" });
    }
    log.info("enrichment repair started", {
      jobId: job.jobId,
      total: job.total,
      statuses: criteria.statuses,
      since: criteria.since,
      until: criteria.until,
      appMode: criteria.apps.mode,
      appCount: criteria.apps.appIds.length
    });
    return ok(job);
  });

  bus.register("codex:repair:status", async () => ok(runner.status()));

  bus.register("codex:repair:cancel", async (req) => {
    if (typeof req.jobId !== "string") return invalid("jobId required");
    const job = await runner.cancel(req.jobId);
    if (job?.jobId === req.jobId) {
      log.info("enrichment repair cancelled", { jobId: job.jobId, processed: job.processed, total: job.total });
    }
    return ok(job);
  });

  bus.register("codex:repair:dismiss", async (req) => {
    if (typeof req.jobId !== "string") return invalid("jobId required");
    runner.dismiss(req.jobId);
    return ok(null);
  });
}
