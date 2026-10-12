// Review and re-run AI enrichment for snaps it failed on or never saw.
//
// One dialog, three views, each replacing the one before it so no two speak
// at once:
//
//   set up   — what to re-run (Failed / Never ran tiles, with live counts),
//              then one line of refinements ("Captured in the last 30 days
//              from all apps · one at a time"), each a token with a small
//              popover. The total lives in the one primary button.
//   running  — a big count, a split bar (fixed / failed again / skipped /
//              in flight) and one live line. Closing it leaves the job
//              running, collapsed to a toast in the lower-left stack.
//   outcome  — one message for how it ended, and the obvious next step.
//
// Main owns the job (`codex:repair:*`); every view is drawn from the job as
// broadcast. The design is "PwrSnap Enrichment Repair" in Claude Design.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  EnrichmentRepairAppCount,
  EnrichmentRepairAppFacet,
  EnrichmentRepairCriteria,
  EnrichmentRepairJob,
  EnrichmentRepairOpenRequest,
  EnrichmentRepairPreview,
  EnrichmentRepairStatus
} from "@pwrsnap/shared";

import { dispatch } from "../../../lib/pwrsnap";
import { useModal } from "../../../lib/useModal";
import { APP_INFO } from "../captures";
import {
  AppsPopover,
  PacePopover,
  RepairToken,
  WhenPopover,
  type RepairPopoverId
} from "./EnrichmentRepairPopovers";
import { RepairActivityLine, RepairLegend, RepairSplitBar } from "./EnrichmentRepairProgress";
import {
  ALL_APPS,
  DEFAULT_REPAIR_WINDOW,
  WINDOW_PRESETS,
  formatElapsed,
  plural,
  repairAppsToken,
  repairCriteria,
  repairJobRecap,
  repairOutcome,
  repairPaceToken,
  repairSetupFromRequest,
  repairStopReasonText,
  repairWindowToken,
  type RepairConcurrency,
  type RepairWindow,
  type RepairWindowPreset
} from "./enrichment-repair-model";

const PREVIEW_DEBOUNCE_MS = 150;
const BOTH: EnrichmentRepairStatus[] = ["failed", "never"];

function appLabel(app: EnrichmentRepairAppCount): string {
  if (app.appKey === "") return "Unknown app";
  return app.name ?? APP_INFO[app.appKey]?.name ?? app.bundleId ?? app.appKey;
}

async function preview(criteria: EnrichmentRepairCriteria): Promise<EnrichmentRepairPreview | null> {
  const result = await dispatch("codex:repair:preview", { criteria });
  return result.ok ? result.value : null;
}

export function EnrichmentRepairDialog({
  job,
  request,
  providerLabel,
  aiEnabled,
  altModifierLabel,
  onJobChange,
  onEnableAi,
  onClose
}: {
  job: EnrichmentRepairJob | null;
  /** Set when something else opened the dialog (the rail, Settings, the
   *  back-online toast): open on set up, configured as it asks. */
  request?: EnrichmentRepairOpenRequest | undefined;
  /** Who reads the snaps: "Codex", "Local llama.cpp". */
  providerLabel: string;
  aiEnabled: boolean;
  /** "⌥" on macOS, "Alt" elsewhere. */
  altModifierLabel: string;
  onJobChange: (job: EnrichmentRepairJob | null) => void;
  /** Turn AI enrichment back on (the Library's own toggle, consent and all). */
  onEnableAi: () => void;
  onClose: () => void;
}): ReactElement {
  const running = job?.state === "running";
  // A finished job shows its outcome, unless the dialog was opened to set
  // up a new run or the user asked for one.
  const [wantSetup, setWantSetup] = useState(request !== undefined);
  const view: "setup" | "running" | "outcome" = running
    ? "running"
    : job !== null && !wantSetup
      ? "outcome"
      : "setup";

  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModal<HTMLElement>({ onClose, initialFocusRef: closeRef });

  // A job that runs while the dialog is open ends on its outcome, even when
  // the dialog was opened to set up a new one.
  useEffect(() => {
    if (running) setWantSetup(false);
  }, [running]);

  // Each view replaces the last, taking the focused control with it (Start,
  // Stop, a follow-up): put focus somewhere a keyboard user can go on from.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) closeRef.current?.focus();
  }, [view, dialogRef]);

  const startJob = useCallback(
    async (criteria: EnrichmentRepairCriteria, concurrency: number): Promise<string | null> => {
      const result = await dispatch("codex:repair:start", { criteria, concurrency });
      if (!result.ok) return result.error.message;
      setWantSetup(false);
      onJobChange(result.value);
      return null;
    },
    [onJobChange]
  );

  const dismissJob = useCallback(async (): Promise<void> => {
    if (job === null) return;
    onJobChange(null);
    await dispatch("codex:repair:dismiss", { jobId: job.jobId });
  }, [job, onJobChange]);

  return (
    <div
      className="ps-repair__backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ps-repair"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ps-repair-title"
        tabIndex={-1}
      >
        <header className="ps-repair__hdr">
          <div>
            <div className="ps-repair__eyebrow">AI enrichment</div>
            <h2 id="ps-repair-title" className="ps-repair__title">
              {view === "running" ? "Re-running AI" : "Re-run AI"}
            </h2>
            <div className="ps-repair__by">
              Reads with <b>{providerLabel}</b>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ps-repair__x"
            aria-label={running ? "Hide" : "Close"}
            data-tip={running ? "Hide" : "Close"}
            data-tip-detail={running ? "The re-run keeps going" : undefined}
            onClick={onClose}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {view === "setup" ? (
          <RepairSetup
            request={request}
            altModifierLabel={altModifierLabel}
            onStart={startJob}
            onClose={onClose}
          />
        ) : view === "running" && job !== null ? (
          <RepairRunning job={job} onClose={onClose} onJobChange={onJobChange} />
        ) : job !== null ? (
          <RepairOutcomeView
            job={job}
            aiEnabled={aiEnabled}
            onStart={startJob}
            onEnableAi={onEnableAi}
            onDone={() => {
              void dismissJob();
              onClose();
            }}
            onSetUpAnother={() => {
              setWantSetup(true);
              void dismissJob();
            }}
          />
        ) : null}
      </section>
    </div>
  );
}

// ---- Set up -------------------------------------------------------------

function RepairSetup({
  request,
  altModifierLabel,
  onStart,
  onClose
}: {
  request: EnrichmentRepairOpenRequest | undefined;
  altModifierLabel: string;
  onStart: (criteria: EnrichmentRepairCriteria, concurrency: number) => Promise<string | null>;
  onClose: () => void;
}): ReactElement {
  const initial = useMemo(() => repairSetupFromRequest(request), [request]);
  const [statuses, setStatuses] = useState<readonly EnrichmentRepairStatus[]>(initial.statuses ?? ["failed"]);
  const [window, setWindow] = useState<RepairWindow>(initial.window ?? DEFAULT_REPAIR_WINDOW);
  const [apps, setApps] = useState<EnrichmentRepairAppFacet>(ALL_APPS);
  const [concurrency, setConcurrency] = useState<RepairConcurrency>(1);
  const [appQuery, setAppQuery] = useState("");
  const [popover, setPopover] = useState<RepairPopoverId | null>(null);
  const [counts, setCounts] = useState<EnrichmentRepairPreview | null>(null);
  const [windowCounts, setWindowCounts] = useState<Partial<Record<RepairWindowPreset, number>> | null>(null);
  const [wider, setWider] = useState<EnrichmentRepairPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const now = Date.now();

  // Every app any preview has named, so a picked app that drops to zero in
  // a narrower window keeps its name and icon.
  const seenApps = useRef(new Map<string, EnrichmentRepairAppCount>());

  // The tiles show both counts even when one (or neither) is ticked, so the
  // preview always asks for something; the batch is only what is ticked.
  const previewStatuses = useMemo(() => (statuses.length === 0 ? BOTH : statuses), [statuses]);
  const criteria = useMemo(
    () => repairCriteria({ statuses: previewStatuses, window, apps, now: Date.now() }),
    [previewStatuses, window, apps]
  );

  useEffect(() => {
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      void dispatch("codex:repair:preview", { criteria }).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          for (const app of result.value.apps) seenApps.current.set(app.appKey, app);
          setCounts(result.value);
          setError(null);
        } else {
          setError(result.error.message);
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [criteria]);

  // The window popover shows what each preset would run.
  useEffect(() => {
    if (popover !== "when") return undefined;
    // Counts for other tiles or apps would label the wrong batch.
    setWindowCounts(null);
    let cancelled = false;
    const stamp = Date.now();
    void Promise.all(
      WINDOW_PRESETS.map(async (preset) => {
        const value = await preview(
          repairCriteria({ statuses: previewStatuses, window: { kind: "preset", preset: preset.id }, apps, now: stamp })
        );
        return [preset.id, value?.total] as const;
      })
    ).then((entries) => {
      if (cancelled) return;
      const next: Partial<Record<RepairWindowPreset, number>> = {};
      for (const [id, total] of entries) if (total !== undefined) next[id] = total;
      setWindowCounts(next);
    });
    return () => {
      cancelled = true;
    };
  }, [popover, previewStatuses, apps]);

  const total = statuses.length === 0 ? 0 : (counts?.total ?? 0);
  const empty = counts !== null && statuses.length > 0 && total === 0;
  const allTime = window.kind === "preset" && window.preset === "all";

  // Nothing here: does anything older qualify? Offered as one-click chips.
  useEffect(() => {
    if (!empty || allTime) {
      setWider(null);
      return undefined;
    }
    let cancelled = false;
    void preview(repairCriteria({ statuses: BOTH, window: { kind: "preset", preset: "all" }, apps, now: Date.now() })).then(
      (value) => {
        if (!cancelled) setWider(value);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [empty, allTime, apps]);

  const appRows = useMemo(() => {
    const rows = [...(counts?.apps ?? [])];
    for (const appKey of apps.appIds) {
      if (!rows.some((row) => row.appKey === appKey)) {
        const seen = seenApps.current.get(appKey);
        rows.push({ appKey, bundleId: seen?.bundleId ?? null, name: seen?.name ?? null, count: 0 });
      }
    }
    const query = appQuery.trim().toLowerCase();
    return query.length === 0 ? rows : rows.filter((row) => appLabel(row).toLowerCase().includes(query));
  }, [counts, apps.appIds, appQuery]);

  const nameOfKey = (appKey: string): string => {
    const seen = seenApps.current.get(appKey);
    return appLabel(seen ?? { appKey, bundleId: null, name: null, count: 0 });
  };

  const toggleStatus = (status: EnrichmentRepairStatus): void => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : BOTH.filter((s) => s === status || current.includes(s))
    );
  };

  const start = async (): Promise<void> => {
    if (starting || total === 0) return;
    setStarting(true);
    setError(null);
    // Re-anchor a "last N days" window to now: the dialog may have sat open
    // since `criteria` was built.
    const message = await onStart(repairCriteria({ statuses, window, apps, now: Date.now() }), concurrency);
    setStarting(false);
    if (message !== null) setError(message);
  };

  const windowToken = repairWindowToken(window, now);
  const windowSet = windowToken !== repairWindowToken(DEFAULT_REPAIR_WINDOW, now);

  const tile = (status: EnrichmentRepairStatus, label: string, detail: string): ReactElement => {
    const n = counts?.byStatus[status];
    const on = statuses.includes(status);
    return (
      <label className={"ps-repair-tile" + (on ? " is-on" : "") + (n === 0 ? " is-zero" : "")}>
        <input
          type="checkbox"
          className="ps-repair-tile__input"
          checked={on}
          onChange={() => toggleStatus(status)}
        />
        <span className="ps-repair-tile__box" aria-hidden="true">
          {on ? "✓" : ""}
        </span>
        <span className="ps-repair-tile__label">{label}</span>
        <span className="ps-repair-tile__n">{n === undefined ? "–" : n.toLocaleString()}</span>
        <span className="ps-repair-tile__sub">{detail}</span>
      </label>
    );
  };

  return (
    <>
      <div className="ps-repair__body">
        <div className="ps-repair-tiles" role="group" aria-label="Which snaps">
          {tile("failed", "Failed", "The last AI run failed or was cancelled")}
          {tile("never", "Never ran", "AI has not read these yet")}
        </div>

        <div className="ps-repair-scope">
          <span>Captured</span>
          <RepairToken
            id="when"
            label="Captured"
            value={windowToken}
            set={windowSet}
            open={popover === "when"}
            onOpenChange={setPopover}
          >
            {(close) => (
              <WhenPopover window={window} counts={windowCounts} now={now} onChange={setWindow} close={close} />
            )}
          </RepairToken>
          <span>from</span>
          <RepairToken
            id="apps"
            label="Apps"
            value={repairAppsToken(apps, nameOfKey)}
            set={apps.appIds.length > 0}
            open={popover === "apps"}
            onOpenChange={setPopover}
          >
            {() => (
              <AppsPopover
                apps={apps}
                rows={appRows}
                query={appQuery}
                counting={counts === null}
                altModifierLabel={altModifierLabel}
                nameOf={appLabel}
                onQueryChange={setAppQuery}
                onAppsChange={setApps}
              />
            )}
          </RepairToken>
          <span aria-hidden="true">·</span>
          <RepairToken
            id="pace"
            label="At a time"
            value={repairPaceToken(concurrency)}
            set={concurrency !== 1}
            open={popover === "pace"}
            onOpenChange={setPopover}
          >
            {(close) => <PacePopover concurrency={concurrency} onChange={setConcurrency} close={close} />}
          </RepairToken>
        </div>

        {empty ? (
          <RepairEmpty
            statuses={statuses}
            windowToken={windowToken}
            allTime={allTime}
            narrowed={apps.appIds.length > 0}
            wider={wider}
            onWiden={(status) => {
              setStatuses([status]);
              setWindow({ kind: "preset", preset: "all" });
            }}
          />
        ) : null}

        {error !== null ? (
          <div className="ps-repair__error" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      <footer className="ps-repair__foot">
        <span className="ps-repair__foot-l">
          {statuses.length === 0 ? (
            "Pick Failed, Never ran, or both."
          ) : counts === null ? (
            "Counting…"
          ) : total > 0 ? (
            <>
              <b>{plural(total, "snap")}</b>, newest first, paced outside the budget new captures use.
            </>
          ) : (
            "Nothing to re-run in this range."
          )}
        </span>
        <span className="ps-repair__actions">
          {total > 0 ? (
            <>
              <button type="button" className="ps-repair-btn is-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="ps-repair-btn is-primary"
                disabled={starting}
                onClick={() => void start()}
              >
                {starting ? (
                  "Starting…"
                ) : (
                  <>
                    Re-run <span className="ps-repair-btn__n">{total.toLocaleString()}</span>{" "}
                    {total === 1 ? "snap" : "snaps"}
                  </>
                )}
              </button>
            </>
          ) : (
            <button type="button" className="ps-repair-btn is-primary" onClick={onClose}>
              Close
            </button>
          )}
        </span>
      </footer>
    </>
  );
}

function RepairEmpty({
  statuses,
  windowToken,
  allTime,
  narrowed,
  wider,
  onWiden
}: {
  statuses: readonly EnrichmentRepairStatus[];
  windowToken: string;
  allTime: boolean;
  narrowed: boolean;
  wider: EnrichmentRepairPreview | null;
  onWiden: (status: EnrichmentRepairStatus) => void;
}): ReactElement {
  const scope = `captured ${windowToken}${narrowed ? " in these apps" : ""}`;
  const title =
    statuses.length === 2
      ? `Every snap ${scope} has AI results.`
      : statuses[0] === "failed"
        ? `No failed snaps ${scope}.`
        : `AI has read every snap ${scope}.`;
  const chips = (wider === null ? [] : statuses)
    .map((status) => ({ status, n: wider?.byStatus[status] ?? 0 }))
    .filter((chip) => chip.n > 0);
  return (
    <div className="ps-repair-empty">
      <div className="ps-repair-empty__t">{title}</div>
      {allTime ? null : chips.length > 0 ? (
        <>
          <div className="ps-repair-empty__d">Older snaps still have some to re-run:</div>
          <div className="ps-repair-empty__try">
            {chips.map((chip) => (
              <button key={chip.status} type="button" className="ps-repair-chip" onClick={() => onWiden(chip.status)}>
                All time · <span className="ps-repair-chip__n">{chip.n.toLocaleString()}</span>{" "}
                {chip.status === "failed" ? "failed" : "never ran"}
              </button>
            ))}
          </div>
        </>
      ) : wider !== null ? (
        <div className="ps-repair-empty__d">Nothing older needs it either.</div>
      ) : null}
    </div>
  );
}

// ---- Running --------------------------------------------------------------

function RepairRunning({
  job,
  onClose,
  onJobChange
}: {
  job: EnrichmentRepairJob;
  onClose: () => void;
  onJobChange: (job: EnrichmentRepairJob | null) => void;
}): ReactElement {
  const [stopping, setStopping] = useState(false);
  const pct = job.total > 0 ? Math.floor((job.processed / job.total) * 100) : 0;
  const stop = async (): Promise<void> => {
    setStopping(true);
    const result = await dispatch("codex:repair:cancel", { jobId: job.jobId });
    setStopping(false);
    if (result.ok) onJobChange(result.value);
  };
  return (
    <>
      <div className="ps-repair__body">
        <div className="ps-repair-big">
          <span className="ps-repair-big__done">{job.processed.toLocaleString()}</span>
          <span className="ps-repair-big__of">/ {job.total.toLocaleString()}</span>
          <span className="ps-repair-big__w">{job.total === 1 ? "snap" : "snaps"}</span>
          <span className="ps-repair-big__pct">{pct}%</span>
        </div>
        <RepairSplitBar job={job} />
        <RepairLegend job={job} />
        <RepairActivityLine job={job} />
        <div className="ps-repair-recap">{repairJobRecap(job, Date.now())}</div>
      </div>
      <footer className="ps-repair__foot">
        <span className="ps-repair__foot-l">Keeps going if you close this.</span>
        <span className="ps-repair__actions">
          <button
            type="button"
            className="ps-repair-btn is-ghost is-danger"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
          <button type="button" className="ps-repair-btn is-primary" onClick={onClose}>
            Run in background
          </button>
        </span>
      </footer>
    </>
  );
}

// ---- Outcome --------------------------------------------------------------

function RepairOutcomeView({
  job,
  aiEnabled,
  onStart,
  onEnableAi,
  onDone,
  onSetUpAnother
}: {
  job: EnrichmentRepairJob;
  aiEnabled: boolean;
  onStart: (criteria: EnrichmentRepairCriteria, concurrency: number) => Promise<string | null>;
  onEnableAi: () => void;
  onDone: () => void;
  onSetUpAnother: () => void;
}): ReactElement {
  const outcome = repairOutcome(job) ?? "clean";
  // The follow-up batch: what failed again, or what is left of this one.
  // Fixed snaps leave both sets, so re-running the same criteria is a
  // resume without a resume verb.
  const followUp = useMemo<EnrichmentRepairCriteria | null>(() => {
    if (outcome === "mixed") return { ...job.criteria, statuses: ["failed"] };
    if (outcome === "cancelled" || outcome === "stopped") return job.criteria;
    return null;
  }, [outcome, job.criteria]);
  const [followUpCount, setFollowUpCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (followUp === null) {
      setFollowUpCount(null);
      return undefined;
    }
    let cancelled = false;
    void preview(followUp).then((value) => {
      if (!cancelled) setFollowUpCount(value?.total ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [followUp]);

  const startFollowUp = async (): Promise<void> => {
    if (followUp === null || starting) return;
    setStarting(true);
    setError(null);
    const message = await onStart(followUp, job.concurrency);
    setStarting(false);
    if (message !== null) setError(message);
  };

  const elapsed =
    job.finishedAt === null ? null : formatElapsed(Date.parse(job.finishedAt) - Date.parse(job.startedAt));
  const notStarted = Math.max(0, job.total - job.processed);
  const skippedSentence =
    job.skipped === 0
      ? ""
      : job.skipped === 1
        ? " 1 was skipped: something else read it first, or it was deleted."
        : ` ${job.skipped.toLocaleString()} were skipped: something else read them first, or they were deleted.`;

  let badge: { tone: string; glyph: string };
  let title: ReactElement;
  let detail: ReactElement | string;
  switch (outcome) {
    case "empty":
      badge = { tone: "is-ok", glyph: "✓" };
      title = <>Nothing to re-run</>;
      detail = "Every snap it looked at already had AI results.";
      break;
    case "clean":
      badge = { tone: "is-ok", glyph: "✓" };
      title = (
        <>
          {job.skipped === 0 ? "All " : ""}
          <span className="ps-repair-out__m">{job.succeeded.toLocaleString()}</span> fixed
        </>
      );
      detail = `${elapsed === null ? "Finished." : `Finished in ${elapsed}.`}${skippedSentence}`;
      break;
    case "mixed":
      badge = { tone: "is-mixed", glyph: "!" };
      title = (
        <>
          <span className="ps-repair-out__m">{job.succeeded.toLocaleString()}</span> of{" "}
          <span className="ps-repair-out__m">{job.total.toLocaleString()}</span> fixed
        </>
      );
      detail = (
        <>
          <b>{job.failed.toLocaleString()} failed again</b> and {job.failed === 1 ? "stays" : "stay"} marked
          Failed.{skippedSentence}
        </>
      );
      break;
    case "cancelled":
      badge = { tone: "is-off", glyph: "■" };
      title = (
        <>
          Stopped at <span className="ps-repair-out__m">{job.processed.toLocaleString()}</span> of{" "}
          <span className="ps-repair-out__m">{job.total.toLocaleString()}</span>
        </>
      );
      detail = (
        <>
          <b>{job.succeeded.toLocaleString()} fixed</b>
          {job.failed > 0 ? `, ${job.failed.toLocaleString()} failed again` : ""}
          {job.skipped > 0 ? `, ${job.skipped.toLocaleString()} skipped` : ""}. {plural(notStarted, "snap")}{" "}
          {notStarted === 1 ? "was" : "were"} not started.
        </>
      );
      break;
    case "stopped":
      badge = { tone: "is-warn", glyph: "‖" };
      title = <>Paused: {repairStopReasonText(job.stopReason)}</>;
      detail = (
        <>
          <b>
            {job.processed.toLocaleString()} of {job.total.toLocaleString()}
          </b>{" "}
          done before it stopped.
          {aiEnabled ? "" : ` Turn AI back on to read the other ${notStarted.toLocaleString()}.`}
        </>
      );
      break;
  }

  const primary: ReactElement | null =
    outcome === "stopped" && !aiEnabled ? (
      <button type="button" className="ps-repair-btn is-primary" onClick={onEnableAi}>
        Turn on AI
      </button>
    ) : followUp !== null && followUpCount !== null && followUpCount > 0 ? (
      <button type="button" className="ps-repair-btn is-primary" disabled={starting} onClick={() => void startFollowUp()}>
        {starting ? (
          "Starting…"
        ) : (
          <>
            Re-run <span className="ps-repair-btn__n">{followUpCount.toLocaleString()}</span>{" "}
            {outcome === "mixed" ? "failed" : "left"}
          </>
        )}
      </button>
    ) : null;

  return (
    <>
      <div className="ps-repair__body">
        <div className="ps-repair-out">
          <span className={"ps-repair-out__badge " + badge.tone} aria-hidden="true">
            {badge.glyph}
          </span>
          <div>
            <div className="ps-repair-out__t" role="status">
              {title}
            </div>
            <div className="ps-repair-out__d">{detail}</div>
          </div>
        </div>
        {outcome === "empty" ? null : (
          <>
            <RepairSplitBar job={job} />
            <RepairLegend job={job} />
          </>
        )}
        <div className="ps-repair-recap">{repairJobRecap(job, Date.now())}</div>
        {error !== null ? (
          <div className="ps-repair__error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <footer className="ps-repair__foot">
        <span className="ps-repair__foot-l">
          <button type="button" className="ps-repair-link" onClick={onSetUpAnother}>
            Re-run other snaps…
          </button>
        </span>
        <span className="ps-repair__actions">
          <button type="button" className={"ps-repair-btn " + (primary === null ? "is-primary" : "is-ghost")} onClick={onDone}>
            Done
          </button>
          {primary}
        </span>
      </footer>
    </>
  );
}
