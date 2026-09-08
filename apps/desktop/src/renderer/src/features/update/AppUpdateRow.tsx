// The compact "an update is ready — restart into it" row, for the two
// surfaces a user opens all day: the tray popover and the post-capture
// float-over toast. The Library's own lower-left toast is a separate,
// roomier component (AppUpdateBanner) that shares this one's copy and
// hooks.
//
// Self-contained on purpose — it subscribes, dispatches and renders
// nothing until there is something to press — so a host surface adds
// it with a single element and needs no props, state or plumbing of
// its own.
//
// Placement:
//   tray        — a full-bleed strip under .ps-tray__hdr, above Quick
//                 Capture. Part of the popover's chrome stack.
//   float-over  — an inset card under .fo__hdr, on the toast's own
//                 12px gutter.

import { useEffect, useState, type ReactElement } from "react";
import { appUpdateNotice } from "./app-update-notice";
import { useAppUpdateInstall, useAppUpdateStatus } from "./use-app-update";

export type AppUpdateRowVariant = "tray" | "float-over";

/** Dismissals are renderer-scoped, not component-scoped.
 *
 *  The float-over toast remounts per capture (`key={record.id}` in
 *  FloatOverHost), so component state would put a just-dismissed row
 *  straight back on the user's next snap. A module-level set survives
 *  the remount; a fresh mount reads it for its initial state.
 *
 *  Deliberately not persisted anywhere. Restarting is the whole point
 *  of the row, and an update silenced across relaunches is a bug in
 *  waiting — the next app start is exactly when we want to ask again. */
const dismissedNoticeKeys = new Set<string>();

/** Test seam: the set above outlives a component tree, so a suite that
 *  dismisses in one case would leak into the next. */
export function resetAppUpdateDismissals(): void {
  dismissedNoticeKeys.clear();
}

const VARIANTS: Record<
  AppUpdateRowVariant,
  { className: string; dismissible: boolean }
> = {
  // No dismiss in the tray. The popover is only on screen because the
  // user opened it, so nothing is being interrupted — and a dismissed
  // strip would leave Settings → Updates as the only way back to the
  // Restart button.
  tray: { className: "psu--tray", dismissible: false },
  // The toast arrives unbidden after every capture, so it must be
  // possible to make it stop for this version.
  "float-over": { className: "psu--fo", dismissible: true }
};

function ReadyIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v11" />
      <path d="m7.5 10 4.5 4.5 4.5-4.5" />
      <path d="M4.5 18.5h15" />
    </svg>
  );
}

function RetryIcon(): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function AppUpdateRow({
  variant
}: {
  variant: AppUpdateRowVariant;
}): ReactElement | null {
  const status = useAppUpdateStatus();
  const { busy, error, install, reset } = useAppUpdateInstall();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(dismissedNoticeKeys)
  );

  const notice = appUpdateNotice(status);
  const noticeKey = notice?.key;

  useEffect(() => {
    if (noticeKey === undefined) return;
    // A new actionable state superseded whatever the last one left
    // behind — don't show its error next to a different version.
    reset();
  }, [noticeKey, reset]);

  if (notice === undefined || dismissed.has(notice.key)) return null;

  const { className, dismissible } = VARIANTS[variant];

  return (
    <div
      className={`psu ${className}${notice.kind === "retry" ? " is-retry" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="psu__icon" aria-hidden="true">
        {notice.kind === "retry" ? <RetryIcon /> : <ReadyIcon />}
      </span>
      <span className="psu__text">
        <span className="psu__title">{notice.title}</span>
        <span className={error === undefined ? "psu__sub" : "psu__sub psu__err"}>
          {error ?? notice.compact}
        </span>
      </span>
      <span className="psu__actions">
        <button className="psu__go" type="button" disabled={busy} onClick={install}>
          {busy ? notice.busyAction : notice.compactAction}
        </button>
        {dismissible ? (
          <button
            className="psu__x"
            type="button"
            disabled={busy}
            aria-label="Dismiss update notification"
            onClick={() => {
              dismissedNoticeKeys.add(notice.key);
              setDismissed(new Set(dismissedNoticeKeys));
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        ) : null}
      </span>
    </div>
  );
}
