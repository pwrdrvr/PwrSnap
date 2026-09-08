// Floating toast (lower-left .app-toast-stack) for actionable update
// states: an update is downloaded and ready to install, or a previous
// install attempt did not apply and should be retried.
//
// The Library's roomy variant of the same offer the tray popover and
// the post-capture toast make through AppUpdateRow. Copy comes from
// the shared `appUpdateNotice` so the three surfaces cannot drift, and
// subscription + install live in the shared hooks; what stays here is
// this surface's own layout (content stacked above its actions) and
// its longer, full-sentence wording.
//
// Visible only when status is `downloaded` or `install-failed`; the
// user can either Restart/Retry now or Dismiss (silenced for this
// status + version — the banner re-appears when a new actionable
// state arrives).
//
// Mirrors PwrAgnt's apps/desktop/src/renderer/src/features/update/
// AppUpdateBanner.tsx, adapted to PwrSnap's `dispatch` + `on` helpers
// instead of PwrAgnt's per-method DesktopApi shape.

import { useEffect, useState, type ReactElement } from "react";
import { appUpdateNotice } from "./app-update-notice";
import { useAppUpdateInstall, useAppUpdateStatus } from "./use-app-update";

export function AppUpdateBanner(): ReactElement | null {
  const updateStatus = useAppUpdateStatus();
  const {
    busy: restarting,
    error: restartError,
    install: handleRestart,
    reset: resetRestart
  } = useAppUpdateInstall();
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();

  const notice = appUpdateNotice(updateStatus);
  const noticeKey = notice?.key;

  useEffect(() => {
    if (noticeKey === undefined || dismissedKey === noticeKey) return;
    // A new actionable update state arrived after the user dismissed
    // an older notice — clear stale restart-error / restarting state.
    resetRestart();
  }, [dismissedKey, noticeKey, resetRestart]);

  if (notice === undefined || dismissedKey === notice.key) {
    return null;
  }

  return (
    <aside className="app-update-banner" role="status" aria-live="polite">
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">{notice.title}</p>
        <p className="app-update-banner__message">{notice.message}</p>
        {restartError !== undefined ? (
          <p className="app-update-banner__error">{restartError}</p>
        ) : null}
      </div>
      <div className="app-update-banner__actions">
        <button
          className="app-update-banner__restart"
          type="button"
          disabled={restarting}
          onClick={handleRestart}
        >
          {restarting ? notice.busyAction : notice.action}
        </button>
        <button
          className="app-update-banner__dismiss"
          type="button"
          disabled={restarting}
          aria-label="Dismiss update notification"
          onClick={() => setDismissedKey(notice.key)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
