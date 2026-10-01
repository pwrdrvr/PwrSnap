// In-flight background video duplicates — the registry behind
// `capture:duplicateJobs` / `capture:cancelDuplicate` and the source of
// `events:capture-duplicate:job`.
//
// Process-local by design. In split mode `capture:*` is agent-owned, so
// the agent holds every job and the Library reaches it over the bridge;
// the events reach the Library's windows through the renderer-event relay
// (events.ts installs the broadcaster). Nothing here survives a restart:
// a copy interrupted by a quit or crash is cleaned up from its durable
// intent row (capture-duplicate.ts → recoverInterruptedVideoDuplicates),
// not resumed.
//
// Electron-free, so capture-duplicate.ts and its tests can import it.

import type { CaptureDuplicateJob, CaptureDuplicateJobState } from "@pwrsnap/shared";
import { nanoid } from "nanoid";

type JobListener = (job: CaptureDuplicateJob) => void;

type Entry = {
  job: CaptureDuplicateJob;
  controller: AbortController;
  /** Set once the copy is being renamed into place and committed. Past
   *  this point a cancel would race a row that is about to exist, so it
   *  is refused. */
  committing: boolean;
  lastEmitAt: number;
  settle: (job: CaptureDuplicateJob) => void;
  settled: Promise<CaptureDuplicateJob>;
};

/** Progress events at most this often per job. The terminal event is
 *  never throttled. */
export const DUPLICATE_PROGRESS_INTERVAL_MS = 100;

let progressIntervalMs = DUPLICATE_PROGRESS_INTERVAL_MS;
let listener: JobListener | null = null;
const jobs = new Map<string, Entry>();
/** Sources with a duplicate in flight: a background job, or a clone
 *  attempt that has not finished yet. */
const busySources = new Set<string>();
/** Copy ids whose intent row belongs to a copy still running in this
 *  process; startup recovery must leave them alone. */
const liveCopyIds = new Set<string>();

export function setDuplicateJobListener(next: JobListener | null): void {
  listener = next;
}

/** Tests only: emit every progress tick. */
export function setDuplicateProgressIntervalForTests(ms: number): void {
  progressIntervalMs = ms;
}

export type DuplicateSourceClaim = {
  /** Mark a copy id as running here, so startup recovery skips its
   *  intent. A copy may try more than one id (a captures-root fallback
   *  retries under a fresh one). */
  trackCopy: (copyId: string) => void;
  /** Free the source and its copy ids. Safe to call more than once. */
  release: () => void;
};

/**
 * Reserve `sourceId` for one duplicate, or `null` when a copy of this
 * source is already in flight.
 */
export function claimDuplicateSource(sourceId: string): DuplicateSourceClaim | null {
  if (busySources.has(sourceId)) return null;
  busySources.add(sourceId);
  const copyIds: string[] = [];
  let released = false;
  return {
    trackCopy: (copyId) => {
      if (released) return;
      copyIds.push(copyId);
      liveCopyIds.add(copyId);
    },
    release: () => {
      if (released) return;
      released = true;
      busySources.delete(sourceId);
      for (const copyId of copyIds) liveCopyIds.delete(copyId);
    }
  };
}

export function isDuplicateCopyLive(copyId: string): boolean {
  return liveCopyIds.has(copyId);
}

export type StartedDuplicateJob = {
  jobId: string;
  /** The job as first broadcast — what `capture:duplicate` answers. */
  snapshot: CaptureDuplicateJob;
  signal: AbortSignal;
  /** Mark the job past the point of cancellation. False when a cancel
   *  already landed — the caller must then stop. */
  beginCommit: () => boolean;
};

export function startDuplicateJob(init: {
  sourceId: string;
  captureId: string;
  withEdits: boolean;
  totalBytes: number;
}): StartedDuplicateJob {
  const jobId = nanoid(12);
  let settle: (job: CaptureDuplicateJob) => void = () => undefined;
  const settled = new Promise<CaptureDuplicateJob>((resolve) => {
    settle = resolve;
  });
  const entry: Entry = {
    job: {
      jobId,
      sourceId: init.sourceId,
      captureId: init.captureId,
      withEdits: init.withEdits,
      state: "copying",
      bytesCopied: 0,
      totalBytes: init.totalBytes,
      error: null
    },
    controller: new AbortController(),
    committing: false,
    lastEmitAt: Date.now(),
    settle,
    settled
  };
  jobs.set(jobId, entry);
  emit(entry.job);
  return {
    jobId,
    snapshot: { ...entry.job },
    signal: entry.controller.signal,
    beginCommit: () => {
      if (entry.controller.signal.aborted) return false;
      entry.committing = true;
      return true;
    }
  };
}

export function reportDuplicateProgress(
  jobId: string,
  bytesCopied: number,
  totalBytes: number
): void {
  const entry = jobs.get(jobId);
  if (entry === undefined) return;
  entry.job = { ...entry.job, bytesCopied, totalBytes };
  const now = Date.now();
  if (now - entry.lastEmitAt < progressIntervalMs) return;
  entry.lastEmitAt = now;
  emit(entry.job);
}

export function finishDuplicateJob(
  jobId: string,
  state: Exclude<CaptureDuplicateJobState, "copying">,
  error: string | null = null
): void {
  const entry = jobs.get(jobId);
  if (entry === undefined) return;
  jobs.delete(jobId);
  const job: CaptureDuplicateJob = {
    ...entry.job,
    state,
    error: state === "failed" ? error : null,
    bytesCopied: state === "done" ? entry.job.totalBytes : entry.job.bytesCopied
  };
  emit(job);
  entry.settle(job);
}

/** Abort a copy. False when there is no such job still copying. */
export function cancelDuplicateJob(jobId: string): boolean {
  const entry = jobs.get(jobId);
  if (entry === undefined || entry.committing || entry.controller.signal.aborted) return false;
  entry.controller.abort(new DuplicateCancelledError());
  return true;
}

export function listDuplicateJobs(): CaptureDuplicateJob[] {
  return [...jobs.values()].map((entry) => entry.job);
}

/** Resolves with the job's terminal state. Unknown ids resolve null. */
export function waitForDuplicateJob(jobId: string): Promise<CaptureDuplicateJob | null> {
  return jobs.get(jobId)?.settled ?? Promise.resolve(null);
}

export class DuplicateCancelledError extends Error {
  constructor() {
    super("The copy was cancelled.");
    this.name = "DuplicateCancelledError";
  }
}

function emit(job: CaptureDuplicateJob): void {
  listener?.({ ...job });
}
