// How long the AI has been reading a snap, and how long it took.
//
// Rendered inside CodexStatusPill's row (its `clock` slot), on both the
// Library detail rail and the float-over:
//
//   - While a run is queued or running, nothing for the first
//     `LIVE_CLOCK_AFTER_MS`, then a ticking "1m35s". A quick model never
//     shows a clock; a slow local one shows the user it is still working.
//   - When a run this component WATCHED ends (completed, failed or
//     cancelled), the total — "took 1m35s" — however short it was. Only
//     a watched run gets one: opening an old snap does not announce a
//     duration nobody was waiting on.
//
// Times come from the run row (`codex:runStatus` + the `aiRunUpdated`
// broadcast), not from when this component mounted, so a rail opened
// halfway through a run still counts from the start. Nothing is stored.
//
// Its own component on purpose: the one-second tick re-renders this span,
// not the whole rail or toast around it.

import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type AiRunSnapshot,
  type AiRunStatus,
  type CaptureEnrichment
} from "@pwrsnap/shared";

import { dispatch, subscribe } from "../../lib/pwrsnap";

/** A run younger than this shows no clock while it is in flight. */
export const LIVE_CLOCK_AFTER_MS = 20_000;

/** `8s`, `1m35s`, `1h02m`. Rounds down to the whole second. */
export function formatRunDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMin / 60)}h${String(totalMin % 60).padStart(2, "0")}m`;
}

/** Run rows are written by SQLite's `datetime('now')`: UTC with no zone. */
export function parseRunTimestamp(value: string | null): number {
  if (value === null) return Number.NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  return Date.parse(value);
}

function isRunSnapshot(value: unknown): value is AiRunSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const run = value as Partial<AiRunSnapshot>;
  return typeof run.id === "string" && typeof run.status === "string" && typeof run.createdAt === "string";
}

function isInFlight(status: AiRunStatus | null): boolean {
  return status === "queued" || status === "running";
}

/** When the wait began: the run's creation, which includes any queueing —
 *  that is what the user sat through. */
function runStartMs(run: AiRunSnapshot): number {
  return parseRunTimestamp(run.createdAt);
}

/** The whole run, from request to finish. Falls back to the turn latency
 *  when the row carries no completion time. */
export function finishedRunDurationMs(run: AiRunSnapshot): number | null {
  const start = runStartMs(run);
  const end = parseRunTimestamp(run.completedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return run.latencyMs;
}

export function EnrichmentRunClock({
  runId,
  status
}: {
  runId: string | null;
  status: AiRunStatus | null;
}): ReactElement | null {
  const [run, setRun] = useState<AiRunSnapshot | null>(null);
  // The run id this mount saw queued or running. A finished run gets its
  // total only if it is this one.
  const [watchedRunId, setWatchedRunId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = isInFlight(status);

  useEffect(() => {
    if (inFlight && runId !== null) setWatchedRunId(runId);
  }, [inFlight, runId]);

  const watched = runId !== null && watchedRunId === runId;

  // The run row: fetched when there is something to show, then kept current
  // by the broadcast (the completion event carries the finish time).
  useEffect(() => {
    if (runId === null || (!inFlight && !watched)) return undefined;
    let cancelled = false;
    void dispatch("codex:runStatus", { runId }).then((result) => {
      if (cancelled || !result.ok || !isRunSnapshot(result.value)) return;
      const fetched = result.value;
      // A broadcast that already delivered the finished row beats a read
      // that may have been answered before the run ended.
      setRun((current) => (current?.id === fetched.id && !isInFlight(current.status) ? current : fetched));
    });
    const unsubscribe = subscribe(EVENT_CHANNELS.aiRunUpdated, (payload) => {
      const next = (payload as { run?: unknown } | null)?.run;
      if (isRunSnapshot(next) && next.id === runId) setRun(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runId, inFlight, watched]);

  useEffect(() => {
    if (!inFlight) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [inFlight]);

  if (runId === null || run === null || run.id !== runId) return null;

  if (inFlight) {
    const start = runStartMs(run);
    if (!Number.isFinite(start)) return null;
    const elapsed = now - start;
    if (elapsed < LIVE_CLOCK_AFTER_MS) return null;
    return (
      <span className="ps-codex-pill__clock is-live" aria-label={`Running for ${formatRunDuration(elapsed)}`}>
        {formatRunDuration(elapsed)}
      </span>
    );
  }

  if (!watched || isInFlight(run.status)) return null;
  const total = finishedRunDurationMs(run);
  if (total === null) return null;
  const verb = run.status === "completed" ? "took" : "after";
  return (
    <span className="ps-codex-pill__clock is-done" aria-label={`${verb === "took" ? "Took" : "Stopped after"} ${formatRunDuration(total)}`}>
      {verb} {formatRunDuration(total)}
    </span>
  );
}

/** The clock for an enrichment's latest run, ready for the pill's slot. */
export function enrichmentRunClock(enrichment: CaptureEnrichment | null | undefined): ReactElement {
  return (
    <EnrichmentRunClock
      key={enrichment?.captureId ?? "none"}
      runId={enrichment?.latestRunId ?? null}
      status={enrichment?.status ?? null}
    />
  );
}
