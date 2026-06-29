// Floating toast (lower-left .app-toast-stack) for actionable update
// states: an update is downloaded and ready to install, or a previous
// install attempt did not apply and should be retried.
//
// Subscribes to `events:app-update:status` from main; reads the
// initial status once (in case main fired before this component
// mounted) and races that read against any real event so a fresh
// event always wins. Visible only when status is `downloaded` or
// `install-failed`; the user can either Restart/Retry now or Dismiss
// (silenced for this status + version — the banner re-appears when a
// new actionable state arrives).
//
// Mirrors PwrAgnt's apps/desktop/src/renderer/src/features/update/
// AppUpdateBanner.tsx, adapted to PwrSnap's `dispatch` + `on` helpers
// instead of PwrAgnt's per-method DesktopApi shape.

import { useEffect, useState, type ReactElement } from "react";
import type { AppUpdateStatus } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

export function AppUpdateBanner(): ReactElement | null {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({
    status: "idle"
  });
  const [dismissedKey, setDismissedKey] = useState<string | undefined>();
  const [restartError, setRestartError] = useState<string | undefined>();
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.appUpdateStatus,
      (payload) => {
        receivedEvent = true;
        if (cancelled) return;
        setUpdateStatus(payload as AppUpdateStatus);
      }
    );
    void (async () => {
      const result = await dispatch("app:update:status", {});
      if (cancelled || receivedEvent || !result.ok) return;
      setUpdateStatus(result.value);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const notice =
    updateStatus.status === "downloaded"
      ? {
          key: `downloaded:${updateStatus.version}`,
          eyebrow: "Update ready",
          message: `Restart to update to v${updateStatus.version}.`,
          action: "Restart",
          busyAction: "Restarting..."
        }
      : updateStatus.status === "install-failed"
        ? {
            key: `install-failed:${updateStatus.version}`,
            eyebrow: "Update retry needed",
            message: `The update to v${updateStatus.version} did not finish installing. Retry to download it again and restart.`,
            action: "Retry update",
            busyAction: "Retrying..."
          }
        : undefined;

  const noticeKey = notice?.key;

  useEffect(() => {
    if (noticeKey === undefined || dismissedKey === noticeKey) return;
    // A new actionable update state arrived after the user dismissed
    // an older notice — clear stale restart-error / restarting state.
    setRestartError(undefined);
    setRestarting(false);
  }, [dismissedKey, noticeKey]);

  if (notice === undefined || dismissedKey === notice.key) {
    return null;
  }

  const handleRestart = async (): Promise<void> => {
    setRestarting(true);
    setRestartError(undefined);
    const result = await dispatch("app:update:install", {});
    if (!result.ok) {
      setRestartError(result.error.message);
      setRestarting(false);
      return;
    }
    if (result.value.status === "error") {
      setRestartError(result.value.message);
      setRestarting(false);
    }
    // status === "restarting" → main is about to quit-and-install;
    // no further UI work needed, the window will go away.
  };

  return (
    <aside className="app-update-banner" role="status" aria-live="polite">
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">{notice.eyebrow}</p>
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
          onClick={() => {
            void handleRestart();
          }}
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
