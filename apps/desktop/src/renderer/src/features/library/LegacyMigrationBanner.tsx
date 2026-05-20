// One-shot "Upgrading library…" toast. Subscribes to
// `events:legacy-bundle-migration:progress` from main and renders a
// floating chip in the bottom-right while the migration runs; auto-
// dismisses ~3s after `status: "complete"` so the user has time to
// read the final count.
//
// Most users see no toast at all — the migration is a no-op when no
// pre-bundle rows exist. First-launch upgraders see "Upgrading
// library… 142 / 400" tick up over ~20s for a typical library.
//
// Placement note: previously rendered above `.psl__topbar` in
// app-shell's flex column. That put the banner in the title-bar
// row, where macOS draws its stoplight buttons (red/yellow/green)
// at fixed window coordinates — they painted ON TOP of the
// banner's text, leaving the count partially occluded. Moving to
// position:fixed in the bottom-right takes the toast out of the
// stoplight overlap zone entirely and matches the native macOS
// notification-banner location, which users instinctively read as
// "transient app status."
//
// Cold-start race: the migration kicks off in main's whenReady
// handler at the same time the renderer is loading. The first batch
// of `webContents.send` events fires BEFORE the renderer's IPC
// listener has attached — those events get dropped (Electron doesn't
// buffer fire-and-forget IPC). For migrations that finish in under a
// second on small libraries, the banner would never appear at all.
//
// Fix: subscribe FIRST so we don't drop any events that fire while
// the bus query is in flight, THEN query `migration:status` for the
// current cached snapshot. If the snapshot is non-null and we don't
// already have fresher state from a live event, we surface it.

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type LegacyBundleMigrationProgress } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import "./LegacyMigrationBanner.css";

const COMPLETE_AUTO_DISMISS_MS = 3_000;

export function LegacyMigrationBanner(): ReactElement | null {
  const [progress, setProgress] = useState<LegacyBundleMigrationProgress | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 1. Subscribe FIRST. If a "running" event arrives between this
    //    line and the bus-query resolution below, we don't want to
    //    miss it.
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.legacyBundleMigrationProgress,
      (payload) => {
        setProgress(payload as LegacyBundleMigrationProgress);
      }
    );

    // 2. Query the cached snapshot. Recovers from the race where
    //    main started broadcasting before this effect ran. Only
    //    overwrite if we don't already have fresher state from a
    //    live event delivered after step 1 but before this resolves.
    void dispatch("migration:status", {}).then((result) => {
      if (cancelled) return;
      if (result.ok && result.value !== null) {
        const snapshot = result.value;
        setProgress((current) => current ?? snapshot);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (progress?.status !== "complete") return;
    const t = setTimeout(() => setProgress(null), COMPLETE_AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [progress?.status]);

  if (progress === null) return null;

  const { status, done, total, failed } = progress;
  const label =
    status === "complete"
      ? failed === 0
        ? `Library upgraded · ${done} / ${total}`
        : `Library upgraded · ${done - failed} of ${total} migrated, ${failed} skipped`
      : `Upgrading library… ${done} / ${total}`;

  // Progress fraction for the bar — 0..1. Clamp to avoid NaN on the
  // tiny window between "total=0 emit" and "first row processed."
  const fraction =
    total > 0 ? Math.min(1, Math.max(0, done / total)) : status === "complete" ? 1 : 0;
  const isComplete = status === "complete";
  const indicatorClass = isComplete
    ? failed === 0
      ? "psl-migration__check psl-migration__check--ok"
      : "psl-migration__check psl-migration__check--warn"
    : "psl-migration__spinner";

  return (
    <div
      className={`psl-migration${isComplete ? " is-complete" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span aria-hidden className={indicatorClass}>
        {isComplete ? "✓" : null}
      </span>
      <div className="psl-migration__body">
        <span className="psl-migration__label">{label}</span>
        {!isComplete && total > 0 && (
          <span
            className="psl-migration__bar"
            aria-hidden
            style={{ ["--psl-migration-progress" as string]: fraction.toString() }}
          />
        )}
      </div>
    </div>
  );
}
