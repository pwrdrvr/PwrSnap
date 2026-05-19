// One-shot "Upgrading library…" banner. Subscribes to
// `events:legacy-bundle-migration:progress` from main; visible while
// the migration is running, auto-dismisses ~3s after `status:
// "complete"` so the user has time to read the final count.
//
// Most users see no banner at all — the migration is a no-op when no
// pre-bundle rows exist. First-launch upgraders see "Upgrading
// library… 142 / 400" tick up over ~20s for a typical library.

import { useEffect, useState, type ReactElement } from "react";
import { EVENT_CHANNELS, type LegacyBundleMigrationProgress } from "@pwrsnap/shared";

const COMPLETE_AUTO_DISMISS_MS = 3_000;

export function LegacyMigrationBanner(): ReactElement | null {
  const [progress, setProgress] = useState<LegacyBundleMigrationProgress | null>(null);

  useEffect(() => {
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.legacyBundleMigrationProgress,
      (payload) => {
        setProgress(payload as LegacyBundleMigrationProgress);
      }
    );
    return () => {
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
