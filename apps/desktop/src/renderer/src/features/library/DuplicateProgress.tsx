// Progress for background video duplicates (`capture:duplicate` answered
// with a job — the recording could not be cloned and is being byte-copied).
//
// Two surfaces, both fed by `useCaptureDuplicate().jobsBySource`:
//
//   DuplicateProgressToast   one row per copy in the lower-left toast stack:
//                            how far, how big, and Cancel. Always findable,
//                            whatever the grid is scrolled to or filtered by.
//   DuplicateTileProgress    a thin bar along the SOURCE tile's bottom edge.
//                            The copy has no tile until it is whole, so the
//                            original is where the work shows.
//
// The tile bar reads a context rather than a prop so a progress tick
// re-renders the bars, not the virtualized grid around them.

import { createContext, useContext, type ReactElement } from "react";
import { duplicateJobFraction, type CaptureDuplicateJob } from "@pwrsnap/shared";

import { formatBytes } from "../../lib/format-bytes";
import "./DuplicateProgress.css";

const NO_JOBS: ReadonlyMap<string, CaptureDuplicateJob> = new Map();

/** Background copies still running, by SOURCE capture id. */
export const DuplicateJobsContext = createContext<ReadonlyMap<string, CaptureDuplicateJob>>(NO_JOBS);

export function useDuplicateJobForSource(sourceId: string | null | undefined): CaptureDuplicateJob | null {
  const jobs = useContext(DuplicateJobsContext);
  if (sourceId === null || sourceId === undefined) return null;
  return jobs.get(sourceId) ?? null;
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
