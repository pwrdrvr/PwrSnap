// Review and re-run AI enrichment for snaps it failed on or never saw.
//
// Pick what to re-run (Failed, Never ran, or both), a capture-time window,
// and which apps. The counts are live from main. Start hands the batch to
// a background job in main (`codex:repair:*`), which works through it one
// snap at a time, newest first, without eating the budget new captures
// need. Closing the dialog while it runs collapses it to a progress toast
// in the lower-left stack; clicking the toast opens the dialog again.
//
// Apps work like a picker: every app runs until you click some. A click
// selects or unselects an app; ⌥-click excludes one. So "never ran, just
// the three apps I search most" is three clicks, and "the rest" later is
// the same dialog with All apps.

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  EnrichmentRepairAppCount,
  EnrichmentRepairAppFacet,
  EnrichmentRepairJob,
  EnrichmentRepairPreview,
  EnrichmentRepairStatus
} from "@pwrsnap/shared";

import { dispatch } from "../../../lib/pwrsnap";
import { useModal } from "../../../lib/useModal";
import { AppIcon } from "../../shared/AppIcons";
import { APP_INFO } from "../captures";
import { RepairProgressBar, RepairProgressSummary } from "./EnrichmentRepairProgress";
import {
  ALL_APPS,
  REPAIR_CONCURRENCY_OPTIONS,
  WINDOW_PRESETS,
  plural,
  repairAppRowState,
  repairCriteria,
  toggleRepairApp,
  type RepairConcurrency,
  type RepairWindowPreset
} from "./enrichment-repair-model";

const PREVIEW_DEBOUNCE_MS = 150;

const STATUS_OPTIONS: ReadonlyArray<{ id: EnrichmentRepairStatus; label: string; detail: string }> = [
  { id: "failed", label: "Failed", detail: "The last AI run failed or was cancelled" },
  { id: "never", label: "Never ran", detail: "AI has not read these snaps yet" }
];

function appLabel(app: EnrichmentRepairAppCount): string {
  if (app.appKey === "") return "Unknown app";
  return app.name ?? APP_INFO[app.appKey]?.name ?? app.bundleId ?? app.appKey;
}

export function EnrichmentRepairDialog({
  job,
  altModifierLabel,
  onJobChange,
  onClose
}: {
  job: EnrichmentRepairJob | null;
  /** "⌥" on macOS, "Alt" elsewhere. */
  altModifierLabel: string;
  onJobChange: (job: EnrichmentRepairJob | null) => void;
  onClose: () => void;
}): ReactElement {
  const running = job?.state === "running";
  const [statuses, setStatuses] = useState<readonly EnrichmentRepairStatus[]>(["failed"]);
  const [preset, setPreset] = useState<RepairWindowPreset>("30d");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [apps, setApps] = useState<EnrichmentRepairAppFacet>(ALL_APPS);
  const [appQuery, setAppQuery] = useState("");
  const [preview, setPreview] = useState<EnrichmentRepairPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [concurrency, setConcurrency] = useState<RepairConcurrency>(1);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useModal<HTMLElement>({ onClose, initialFocusRef: closeRef });

  const criteria = useMemo(
    () => repairCriteria({ statuses, preset, custom, apps, now: Date.now() }),
    [statuses, preset, custom, apps]
  );

  // Live counts. Re-read as the job finishes snaps, since each one it
  // repairs leaves these sets.
  const processed = job?.processed ?? 0;
  const jobState = job?.state ?? null;
  useEffect(() => {
    if (criteria.statuses.length === 0) {
      setPreview({ total: 0, byStatus: { failed: 0, never: 0 }, apps: [] });
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void dispatch("codex:repair:preview", { criteria }).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setPreview(result.value);
          setError(null);
        } else {
          setError(result.error.message);
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [criteria, processed, jobState]);

  // Apps with something to re-run, plus any the user picked that dropped to
  // zero (so they can still be unpicked).
  const appRows = useMemo(() => {
    const rows = [...(preview?.apps ?? [])];
    for (const appKey of apps.appIds) {
      if (!rows.some((row) => row.appKey === appKey)) {
        rows.push({ appKey, bundleId: null, name: null, count: 0 });
      }
    }
    const query = appQuery.trim().toLowerCase();
    return query.length === 0 ? rows : rows.filter((row) => appLabel(row).toLowerCase().includes(query));
  }, [preview, apps.appIds, appQuery]);

  const total = preview?.total ?? 0;
  const canStart = !running && !starting && statuses.length > 0 && total > 0;

  const toggleStatus = (status: EnrichmentRepairStatus): void => {
    setStatuses((current) =>
      current.includes(status) ? current.filter((s) => s !== status) : [...current, status]
    );
  };

  const start = async (): Promise<void> => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    const result = await dispatch("codex:repair:start", { criteria, concurrency });
    setStarting(false);
    if (result.ok) onJobChange(result.value);
    else setError(result.error.message);
  };

  const cancelJob = async (): Promise<void> => {
    if (job === null) return;
    const result = await dispatch("codex:repair:cancel", { jobId: job.jobId });
    if (result.ok) onJobChange(result.value);
  };

  const dismissJob = async (): Promise<void> => {
    if (job === null) return;
    await dispatch("codex:repair:dismiss", { jobId: job.jobId });
    onJobChange(null);
  };

  const appsSummary =
    apps.appIds.length === 0
      ? "All apps"
      : apps.mode === "include"
        ? `${plural(apps.appIds.length, "app")} selected`
        : `All but ${plural(apps.appIds.length, "app")}`;

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
              Re-run AI on snaps
            </h2>
          </div>
          <button ref={closeRef} type="button" className="ps-repair__btn" onClick={onClose}>
            {running ? "Hide" : "Close"}
          </button>
        </header>

        <fieldset className="ps-repair__form" disabled={running}>
          <div className="ps-repair__section">
            <div className="ps-repair__label">Snaps</div>
            <div className="ps-repair__chips">
              {STATUS_OPTIONS.map((option) => (
                <label key={option.id} className="ps-repair__check" data-tip={option.detail}>
                  <input
                    type="checkbox"
                    checked={statuses.includes(option.id)}
                    onChange={() => toggleStatus(option.id)}
                  />
                  <span>{option.label}</span>
                  <span className="ps-repair__count">
                    {preview === null ? "–" : preview.byStatus[option.id].toLocaleString()}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="ps-repair__section">
            <div className="ps-repair__label">Captured</div>
            <div className="ps-repair__segmented" role="radiogroup" aria-label="Capture window">
              {WINDOW_PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === option.id}
                  className={"ps-repair__seg" + (preset === option.id ? " is-active" : "")}
                  onClick={() => setPreset(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {preset === "custom" ? (
              <div className="ps-repair__dates">
                <label>
                  <span>From</span>
                  <input
                    type="date"
                    value={custom.from}
                    onChange={(event) => setCustom((c) => ({ ...c, from: event.target.value }))}
                  />
                </label>
                <label>
                  <span>To</span>
                  <input
                    type="date"
                    value={custom.to}
                    onChange={(event) => setCustom((c) => ({ ...c, to: event.target.value }))}
                  />
                </label>
              </div>
            ) : null}
          </div>

          <div className="ps-repair__section">
            <div className="ps-repair__label">
              At a time{" "}
              <span className="ps-repair__label-note">· the connection's own limit in AI Providers still applies</span>
            </div>
            <div className="ps-repair__segmented" role="radiogroup" aria-label="Snaps at a time">
              {REPAIR_CONCURRENCY_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={concurrency === option}
                  className={"ps-repair__seg" + (concurrency === option ? " is-active" : "")}
                  onClick={() => setConcurrency(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div className="ps-repair__section ps-repair__section--apps">
            <div className="ps-repair__apps-hdr">
              <div className="ps-repair__label">
                Apps <span className="ps-repair__label-note">· {appsSummary}</span>
              </div>
              {apps.appIds.length > 0 ? (
                <button type="button" className="ps-repair__link" onClick={() => setApps(ALL_APPS)}>
                  All apps
                </button>
              ) : null}
            </div>
            <input
              type="search"
              className="ps-repair__search"
              placeholder="Find an app…"
              aria-label="Find an app"
              value={appQuery}
              onChange={(event) => setAppQuery(event.target.value)}
            />
            <div className="ps-repair__apps" role="group" aria-label="Apps to re-run">
              {appRows.length === 0 ? (
                <div className="ps-repair__empty">
                  {preview === null ? "Counting…" : "No snaps match."}
                </div>
              ) : (
                appRows.map((app) => {
                  const state = repairAppRowState(apps, app.appKey);
                  const name = appLabel(app);
                  const dimmed = state === "neutral" && apps.mode === "include" && apps.appIds.length > 0;
                  return (
                    <button
                      key={app.appKey}
                      type="button"
                      aria-pressed={state !== "neutral"}
                      aria-label={
                        state === "excluded" ? `${name} (excluded)` : state === "included" ? `${name} (selected)` : name
                      }
                      className={
                        "ps-repair__app" +
                        (state === "included" ? " is-active" : "") +
                        (state === "excluded" ? " is-excluded" : "") +
                        (dimmed ? " is-dimmed" : "")
                      }
                      data-tip={
                        state === "included"
                          ? `Click to unselect ${name}`
                          : state === "excluded"
                            ? `Click to include ${name} again`
                            : `Click to select ${name}`
                      }
                      data-tip-detail={`${altModifierLabel}-click to ${state === "excluded" ? "stop excluding" : "exclude"} it`}
                      onClick={(event) => setApps((current) => toggleRepairApp(current, app.appKey, event.altKey))}
                    >
                      <span className="ps-repair__app-icon">
                        <AppIcon
                          app={app.appKey === "" ? "any" : app.appKey}
                          size={11}
                          name={name}
                          bundleId={app.bundleId ?? undefined}
                        />
                      </span>
                      <span className="ps-repair__app-name">{name}</span>
                      <span className="ps-repair__count">{app.count.toLocaleString()}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </fieldset>

        {job !== null ? (
          <div className="ps-repair__job">
            <RepairProgressSummary job={job} />
            <RepairProgressBar job={job} />
          </div>
        ) : null}

        {error !== null ? (
          <div className="ps-repair__error" role="alert">
            {error}
          </div>
        ) : null}

        <footer className="ps-repair__foot">
          <span className="ps-repair__plan">
            {running
              ? "Runs newest first and keeps some AI budget free for new snaps."
              : total > 0
                ? `${plural(total, "snap")}, newest first, ${concurrency === 1 ? "one at a time" : `${concurrency} at a time`}.`
                : statuses.length === 0
                  ? "Pick Failed, Never ran, or both."
                  : "Nothing to re-run."}
          </span>
          <span className="ps-repair__actions">
            {running ? (
              <button type="button" className="ps-repair__btn" onClick={() => void cancelJob()}>
                Stop
              </button>
            ) : job !== null ? (
              <button type="button" className="ps-repair__btn" onClick={() => void dismissJob()}>
                Clear result
              </button>
            ) : null}
            {running ? null : (
              <button
                type="button"
                className="ps-repair__btn is-primary"
                disabled={!canStart}
                onClick={() => void start()}
              >
                {starting ? "Starting…" : total > 0 ? `Re-run ${plural(total, "snap")}` : "Re-run"}
              </button>
            )}
          </span>
        </footer>
      </section>
    </div>
  );
}
