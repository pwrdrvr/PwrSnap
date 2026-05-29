// Library-level toast for the boot-time v1 → v2 doctor sweep.
//
// Mirrors `LegacyMigrationBanner` exactly — same visual treatment
// (reuses the `.psl-migration` CSS class set), same race-recovery
// pattern (subscribe FIRST, then query the cached snapshot), same
// auto-dismiss timing. The only differences are the event channel,
// the status verb, and the user-facing label.
//
// Why this banner exists separate from `V1ToV2DoctorBanner.tsx`:
//   • `V1ToV2DoctorBanner` is the per-capture inline banner that
//     renders INSIDE the editor when `useEnsureV2` upgrades a v1
//     capture on first edit-open. Visible only when the editor is.
//   • This component is the library-wide toast for the boot-time
//     EAGER sweep (`migrateAllV1OnBoot`), which can take minutes on
//     a library of a few hundred v1 captures. Without it, the user
//     sees disk I/O, fan spin, and no UI signal at all.
//
// captureId filter:
//   The doctor emits two flavors of `v1ToV2DoctorProgress`:
//     1. Per-capture events — `captureId: <id>` — fired by
//        `migrateBundleV1ToV2` at each step of a single upgrade.
//        These are what the editor banner listens to.
//     2. Aggregate sweep events — `captureId: null` — fired by
//        `migrateAllV1OnBoot` (and `reconcileV1ToV2OnBoot`) at
//        start, every N rows, and at completion.
//   The library toast cares ONLY about (2). Filtering on
//   `captureId === null` keeps the toast from flickering once-per-
//   row as the sweep ticks; the bar updates only on aggregate ticks.
//
// Cold-start race: identical to `LegacyMigrationBanner` — main's
// boot pipeline starts emitting before the renderer's IPC listener
// attaches. Subscribe first, then read the `v1ToV2:status` snapshot
// to recover any events that fired before subscription.
//
// PR-2 follow-up: when the v1 → v2 doctor itself gets deleted
// (once the install base is fully v2), this component is a single
// `git rm` away. The CSS class set stays — `LegacyMigrationBanner`
// owns it and isn't going anywhere.

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type V1ToV2DoctorProgress } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import "./LegacyMigrationBanner.css";

const COMPLETE_AUTO_DISMISS_MS = 3_000;

// The aggregate-progress variants of V1ToV2DoctorProgress. The third
// variant (`status: "failed"`) is always per-capture (captureId
// non-null) and is routed to the editor banner — never makes it past
// the filter in the effect below.
type AggregateProgress = Extract<V1ToV2DoctorProgress, { status: "running" | "complete" }>;

export function V1ToV2LibraryMigrationBanner(): ReactElement | null {
  const [progress, setProgress] = useState<AggregateProgress | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Aggregate-only filter — see file comment. Per-capture events
    // (captureId non-null) belong to the editor's `V1ToV2DoctorBanner`
    // and would cause this toast to thrash if we forwarded them.
    // Per-capture failure events (`status: "failed"`) likewise have
    // a non-null captureId by type and so are filtered here too.
    const onProgress = (payload: V1ToV2DoctorProgress): void => {
      if (payload.captureId !== null) return;
      if (payload.status === "failed") return; // type-narrow + defense
      setProgress(payload);
    };

    // 1. Subscribe FIRST. If an aggregate event arrives between
    //    this line and the snapshot read below, we don't miss it.
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.v1ToV2DoctorProgress,
      (payload) => onProgress(payload as V1ToV2DoctorProgress)
    );

    // 2. Pick up any aggregate event that landed BEFORE subscription
    //    (cold-start race). Only set if we don't already have fresher
    //    live state from a post-subscribe event delivery.
    void dispatch("v1ToV2:status", {}).then((result) => {
      if (cancelled) return;
      if (!result.ok || result.value === null) return;
      const snapshot = result.value;
      if (snapshot.captureId !== null) return;
      if (snapshot.status === "failed") return;
      setProgress((current) => current ?? snapshot);
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
        ? `Captures modernized · ${done} / ${total}`
        : `Captures modernized · ${done - failed} of ${total} migrated, ${failed} skipped`
      : `Modernizing captures… ${done} / ${total}`;

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
