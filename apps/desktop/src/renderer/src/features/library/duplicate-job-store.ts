// Background video duplicates still copying, keyed by SOURCE capture id.
//
// An external store rather than React state on purpose: progress arrives
// up to 10 times a second for the whole length of a copy, and state held
// by Library would re-render all of Library on every tick. Readers
// subscribe with `useSyncExternalStore` — a tile's bar selects only its
// own source's job, so a tick re-renders that bar and the toast, nothing
// else. Library holds the store; `useCaptureDuplicate` writes it.

import type { CaptureDuplicateJob } from "@pwrsnap/shared";

export type DuplicateJobStore = {
  subscribe: (listener: () => void) => () => void;
  /** Same identity until the set of jobs or a job's progress changes. */
  getSnapshot: () => ReadonlyMap<string, CaptureDuplicateJob>;
  /** Insert or replace the job for its source. Bytes only move forward:
   *  reports can arrive out of order across the event and the command. */
  upsert: (job: CaptureDuplicateJob) => void;
  /** Remove `jobId`, if it is still the job for its source. */
  remove: (job: Pick<CaptureDuplicateJob, "jobId" | "sourceId">) => void;
};

export function createDuplicateJobStore(): DuplicateJobStore {
  let jobs: ReadonlyMap<string, CaptureDuplicateJob> = new Map();
  const listeners = new Set<() => void>();
  const publish = (next: ReadonlyMap<string, CaptureDuplicateJob>): void => {
    jobs = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => jobs,
    upsert: (job) => {
      const known = jobs.get(job.sourceId);
      if (known?.jobId === job.jobId && known.bytesCopied > job.bytesCopied) return;
      const next = new Map(jobs);
      next.set(job.sourceId, job);
      publish(next);
    },
    remove: ({ jobId, sourceId }) => {
      if (jobs.get(sourceId)?.jobId !== jobId) return;
      const next = new Map(jobs);
      next.delete(sourceId);
      publish(next);
    }
  };
}

const EMPTY: ReadonlyMap<string, CaptureDuplicateJob> = new Map();

/** For readers rendered outside a Library (tests, other windows). */
export const EMPTY_DUPLICATE_JOB_STORE: DuplicateJobStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => EMPTY,
  upsert: () => undefined,
  remove: () => undefined
};
