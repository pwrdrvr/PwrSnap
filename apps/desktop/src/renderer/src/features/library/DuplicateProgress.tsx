// Progress for background video duplicates (`capture:duplicate` answered
// with a job — the recording could not be cloned and is being byte-copied).
//
// Two surfaces, both reading `useCaptureDuplicate().jobStore`:
//
//   DuplicateProgressToast   one row per copy in the lower-left toast stack:
//                            how far, how big, and Cancel. Always findable,
//                            whatever the grid is scrolled to or filtered by.
//   DuplicateTileProgress    a thin bar along the SOURCE tile's bottom edge.
//                            The copy has no tile until it is whole, so the
//                            original is where the work shows.
//
// Both subscribe to the store themselves (the context carries the stable
// store, never the jobs), so a progress tick re-renders the bars and the
// toasts — not Library, and not the virtualized grid around them.

import { createContext, useCallback, useContext, useSyncExternalStore, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { duplicateJobFraction, type CaptureDuplicateJob } from "@pwrsnap/shared";

import { formatBytes } from "../../lib/format-bytes";
import { EMPTY_DUPLICATE_JOB_STORE, type DuplicateJobStore } from "./duplicate-job-store";
import "./DuplicateProgress.css";

export const DuplicateJobsContext = createContext<DuplicateJobStore>(EMPTY_DUPLICATE_JOB_STORE);

/** The running copy of `sourceId`, re-rendering only when THAT job changes. */
export function useDuplicateJobForSource(sourceId: string | null | undefined): CaptureDuplicateJob | null {
  const store = useContext(DuplicateJobsContext);
  const select = useCallback(
    () => (sourceId === null || sourceId === undefined ? null : store.getSnapshot().get(sourceId) ?? null),
    [store, sourceId]
  );
  return useSyncExternalStore(store.subscribe, select);
}

/** One progress toast per running copy, portaled into the lower-left
 *  toast stack. */
export function DuplicateProgressToasts({
  onCancel
}: {
  onCancel: (jobId: string) => void;
}): ReactElement | null {
  const store = useContext(DuplicateJobsContext);
  const jobs = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (jobs.size === 0) return null;
  return createPortal(
    <>
      {[...jobs.values()].map((job) => (
        <DuplicateProgressToast key={job.jobId} job={job} onCancel={onCancel} />
      ))}
    </>,
    document.querySelector(".app-toast-stack") ?? document.body
  );
}

function percent(job: CaptureDuplicateJob): number {
  return Math.floor(duplicateJobFraction(job) * 100);
}

export function DuplicateProgressToast({
  job,
  onCancel
}: {
  job: CaptureDuplicateJob;
  onCancel: (jobId: string) => void;
}): ReactElement {
  const pct = percent(job);
  return (
    <div className="ps-duplicate-progress" role="group" aria-label="Copying recording">
      <div className="ps-duplicate-progress__row">
        <span className="ps-duplicate-progress__msg">Copying recording</span>
        <span className="ps-duplicate-progress__detail">
          {formatBytes(job.bytesCopied)} of {formatBytes(job.totalBytes)}
        </span>
        <button
          type="button"
          className="ps-duplicate-progress__cancel"
          onClick={() => onCancel(job.jobId)}
        >
          Cancel
        </button>
      </div>
      <div
        className="ps-duplicate-progress__track"
        role="progressbar"
        aria-label="Copy progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className="ps-duplicate-progress__fill"
          style={{ transform: `scaleX(${duplicateJobFraction(job)})` }}
        />
      </div>
    </div>
  );
}

/** A thin bar on the source tile while its copy runs; nothing otherwise. */
export function DuplicateTileProgress({
  sourceId
}: {
  sourceId: string | null | undefined;
}): ReactElement | null {
  const job = useDuplicateJobForSource(sourceId);
  if (job === null) return null;
  const pct = percent(job);
  return (
    <span
      className="psl__tile-duplicate-progress"
      role="progressbar"
      aria-label={`Copying — ${pct}%`}
      title={`Copying — ${pct}%`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span
        className="psl__tile-duplicate-progress-fill"
        style={{ transform: `scaleX(${duplicateJobFraction(job)})` }}
      />
    </span>
  );
}
