// Progress for a background enrichment repair, shared by the dialog's
// progress block and the collapsed toast in the lower-left stack.

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactElement } from "react";
import type { EnrichmentRepairJob } from "@pwrsnap/shared";

import { formatRunDuration } from "../../shared/EnrichmentRunClock";
import "./EnrichmentRepair.css";
import { repairJobFraction, repairJobHeadline, repairJobTally } from "./enrichment-repair-model";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** What the job is doing right now, for the line under the headline. */
function RepairActivity({ job }: { job: EnrichmentRepairJob }): ReactElement {
  const running = job.state === "running";
  const now = useNow(running && (job.currentStartedAt !== null || job.waitingUntil !== null));
  if (!running) {
    return (
      <span className="ps-repair-progress__detail">
        {job.stopReason !== null ? `${job.stopReason} ` : ""}
        {repairJobTally(job)}
      </span>
    );
  }
  if (job.waitingUntil !== null) {
    const left = Math.max(0, Date.parse(job.waitingUntil) - now);
    return (
      <span className="ps-repair-progress__detail">
        Leaving AI budget for new snaps · resumes in {formatRunDuration(left + 999)}
      </span>
    );
  }
  if (job.currentStartedAt !== null) {
    return (
      <span className="ps-repair-progress__detail">
        Reading a snap · {formatRunDuration(now - Date.parse(job.currentStartedAt))} · {repairJobTally(job)}
      </span>
    );
  }
  return <span className="ps-repair-progress__detail">{repairJobTally(job)}</span>;
}

export function RepairProgressBar({ job }: { job: EnrichmentRepairJob }): ReactElement {
  const fraction = repairJobFraction(job);
  const pct = Math.floor(fraction * 100);
  return (
    <div
      className="ps-repair-progress__track"
      role="progressbar"
      aria-label="Re-run progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="ps-repair-progress__fill" style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}

export function RepairProgressSummary({ job }: { job: EnrichmentRepairJob }): ReactElement {
  return (
    <div className="ps-repair-progress__text">
      <span className="ps-repair-progress__msg">{repairJobHeadline(job)}</span>
      <RepairActivity job={job} />
    </div>
  );
}

/** The collapsed form: the job's progress in the lower-left toast stack.
 *  Clicking it brings the dialog back. */
export function EnrichmentRepairToast({
  job,
  onOpen,
  onCancel,
  onDismiss
}: {
  job: EnrichmentRepairJob;
  onOpen: () => void;
  onCancel: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
}): ReactElement {
  const running = job.state === "running";
  return createPortal(
    <div className="ps-repair-progress ps-repair-toast" role="group" aria-label="AI re-run">
      <div className="ps-repair-progress__row">
        <button
          type="button"
          className="ps-repair-toast__open"
          onClick={onOpen}
          aria-label={`${repairJobHeadline(job)}. Show the AI re-run`}
          data-tip="Show the AI re-run"
        >
          <RepairProgressSummary job={job} />
        </button>
        {running ? (
          <button type="button" className="ps-repair-toast__action" onClick={() => onCancel(job.jobId)}>
            Stop
          </button>
        ) : (
          <button type="button" className="ps-repair-toast__action" onClick={() => onDismiss(job.jobId)}>
            Dismiss
          </button>
        )}
      </div>
      <RepairProgressBar job={job} />
    </div>,
    document.querySelector(".app-toast-stack") ?? document.body
  );
}
