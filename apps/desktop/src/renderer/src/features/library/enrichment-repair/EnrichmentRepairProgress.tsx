// Progress for a background enrichment repair: the split bar and live line
// the dialog's running view shows, and the collapsed toast in the lower-left
// stack. Also the "back online" toast that offers a repair after an outage.

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactElement } from "react";
import type { EnrichmentRepairJob } from "@pwrsnap/shared";

import { formatRunDuration } from "../../shared/EnrichmentRunClock";
import "./EnrichmentRepair.css";
import {
  plural,
  repairBarSegments,
  repairJobCount,
  repairJobHeadline,
  repairJobTally,
  repairOldestInFlightMs,
  repairStopReasonText
} from "./enrichment-repair-model";

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Fixed, failed again, skipped, then the snap in flight (or a held slot
 *  while the job waits out its own pace). */
export function RepairSplitBar({ job, small }: { job: EnrichmentRepairJob; small?: boolean }): ReactElement {
  const seg = repairBarSegments(job);
  const pct = Math.floor(Math.min(1, seg.ok + seg.bad + seg.skip) * 100);
  const width = (fraction: number): { width: string } => ({ width: `${fraction * 100}%` });
  return (
    <div
      className={"ps-repair-bar" + (small === true ? " is-small" : "")}
      role="progressbar"
      aria-label="Re-run progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${job.processed} of ${job.total} snaps: ${repairJobTally(job)}`}
    >
      {seg.ok > 0 ? <i className="ps-repair-bar__ok" style={width(seg.ok)} /> : null}
      {seg.bad > 0 ? <i className="ps-repair-bar__bad" style={width(seg.bad)} /> : null}
      {seg.skip > 0 ? <i className="ps-repair-bar__skip" style={width(seg.skip)} /> : null}
      {seg.live > 0 ? <i className="ps-repair-bar__live" style={width(seg.live)} /> : null}
      {seg.held > 0 ? <i className="ps-repair-bar__held" style={width(seg.held)} /> : null}
    </div>
  );
}

/** "● 16 fixed  ● 1 failed again  ● 1 skipped" — skipped and failed only
 *  when there are any. */
export function RepairLegend({ job }: { job: EnrichmentRepairJob }): ReactElement {
  return (
    <div className="ps-repair-legend">
      <span>
        <i className="ps-repair-dot is-ok" aria-hidden="true" />
        <b>{job.succeeded.toLocaleString()}</b> fixed
      </span>
      {job.failed > 0 ? (
        <span>
          <i className="ps-repair-dot is-bad" aria-hidden="true" />
          <b>{job.failed.toLocaleString()}</b> failed again
        </span>
      ) : null}
      {job.skipped > 0 ? (
        <span>
          <i className="ps-repair-dot" aria-hidden="true" />
          <b>{job.skipped.toLocaleString()}</b> skipped
        </span>
      ) : null}
    </div>
  );
}

/** What a running job is doing now: reading, or waiting out its pace. */
export function repairActivity(
  job: EnrichmentRepairJob,
  now: number
): { kind: "reading" | "held" | "idle"; text: string; clock: string | null } {
  const oldest = repairOldestInFlightMs(job, now);
  if (oldest === null && job.waitingUntil !== null) {
    const left = Math.max(0, Date.parse(job.waitingUntil) - now);
    return {
      kind: "held",
      text: "Pacing re-runs",
      clock: `next in ${formatRunDuration(left + 999)}`
    };
  }
  if (oldest !== null) {
    return job.inFlight.length === 1
      ? { kind: "reading", text: "Reading a snap", clock: formatRunDuration(oldest) }
      : { kind: "reading", text: `Reading ${job.inFlight.length} snaps`, clock: `longest ${formatRunDuration(oldest)}` };
  }
  return { kind: "idle", text: "Starting the next snap", clock: null };
}

/** The live line in the running view. */
export function RepairActivityLine({ job }: { job: EnrichmentRepairJob }): ReactElement {
  const now = useNow(job.state === "running");
  const activity = repairActivity(job, now);
  return (
    <div className={"ps-repair-now" + (activity.kind === "held" ? " is-held" : "")} role="status">
      <i
        className={"ps-repair-dot " + (activity.kind === "held" ? "is-held" : "is-live")}
        aria-hidden="true"
      />
      <span>{activity.text}</span>
      {activity.clock !== null ? <span className="ps-repair-now__clock">{activity.clock}</span> : null}
    </div>
  );
}

function toastDetail(job: EnrichmentRepairJob, now: number): { text: string; held: boolean } {
  if (job.state === "running") {
    const activity = repairActivity(job, now);
    return {
      text: activity.clock === null ? activity.text : `${activity.text} · ${activity.clock}`,
      held: activity.kind === "held"
    };
  }
  if (job.state === "stopped") return { text: repairStopReasonText(job.stopReason), held: true };
  if (job.state === "completed" && job.failed === 0 && job.skipped === 0) return { text: "AI re-run finished", held: false };
  return { text: repairJobTally(job), held: false };
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
  const now = useNow(running);
  const headline = repairJobHeadline(job);
  const count = repairJobCount(job);
  const detail = toastDetail(job, now);
  return createPortal(
    <div className="ps-repair-toast" role="group" aria-label="AI re-run">
      <div className="ps-repair-toast__row">
        <button
          type="button"
          className="ps-repair-toast__open"
          onClick={onOpen}
          aria-label={`${headline}${count === "" ? "" : `, ${count}`}. Show the AI re-run`}
          data-tip="Show the AI re-run"
        >
          <span className="ps-repair-toast__h">
            {headline}
            {count !== "" ? <span className="ps-repair-toast__count">{count}</span> : null}
          </span>
          <span className={"ps-repair-toast__d" + (detail.held ? " is-held" : "")}>{detail.text}</span>
        </button>
        <button
          type="button"
          className="ps-repair-toast__action"
          onClick={() => (running ? onCancel(job.jobId) : onDismiss(job.jobId))}
        >
          {running ? "Stop" : "Dismiss"}
        </button>
      </div>
      <RepairSplitBar job={job} small />
    </div>,
    document.querySelector(".app-toast-stack") ?? document.body
  );
}

/** The caption model answered again after captures failed to reach it. */
export function EnrichmentRecoveryToast({
  providerLabel,
  failed,
  windowLabel,
  onRerun,
  onDismiss
}: {
  providerLabel: string;
  failed: number;
  /** "10:42 – 11:20 today". */
  windowLabel: string;
  onRerun: () => void;
  onDismiss: () => void;
}): ReactElement {
  return createPortal(
    <div className="ps-repair-toast is-recovery" role="group" aria-label={`${providerLabel} is reachable again`}>
      <div className="ps-repair-toast__txt">
        <span className="ps-repair-toast__h">
          <i className="ps-repair-dot is-ok" aria-hidden="true" />
          {providerLabel} is reachable again
        </span>
        <span className="ps-repair-toast__d is-wrap">
          {plural(failed, "snap")} failed while it was down, {windowLabel}.
        </span>
      </div>
      <div className="ps-repair-toast__actions">
        <button type="button" className="ps-repair-btn is-ghost is-small" onClick={onDismiss}>
          Not now
        </button>
        <button type="button" className="ps-repair-btn is-primary is-small" onClick={onRerun}>
          Re-run <span className="ps-repair-btn__n">{failed.toLocaleString()}</span>
        </button>
      </div>
    </div>,
    document.querySelector(".app-toast-stack") ?? document.body
  );
}
