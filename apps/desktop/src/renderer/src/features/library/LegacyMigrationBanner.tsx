// One-shot "Upgrading library…" banner. Subscribes to
// `events:legacy-bundle-migration:progress` from main and renders a
// progress chip while the migration runs; auto-dismisses ~3s after
// `status: "complete"` so the user has time to read the final count.
//
// Most users see no banner at all — the migration is a no-op when no
// pre-bundle rows exist. First-launch upgraders see "Upgrading
// library… 142 / 400" tick up over ~20s for a typical library.
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

  return (
    <div
      className="legacy-migration-banner"
      role="status"
      aria-live="polite"
      style={{
        padding: "8px 14px",
        background: "var(--surface-1, #161312)",
        borderBottom: "1px solid var(--border-subtle, #2a2624)",
        color: "var(--text-secondary, #c7bdb5)",
        font: "500 12px var(--font-sans, system-ui)",
        display: "flex",
        alignItems: "center",
        gap: 10
      }}
    >
      {status === "running" ? (
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: "1.5px solid currentColor",
            borderTopColor: "transparent",
            animation: "spin 0.9s linear infinite",
            display: "inline-block"
          }}
        />
      ) : (
        <span aria-hidden style={{ color: failed === 0 ? "#7fc97f" : "#e8a04a" }}>
          ✓
        </span>
      )}
      <span>{label}</span>
    </div>
  );
}
