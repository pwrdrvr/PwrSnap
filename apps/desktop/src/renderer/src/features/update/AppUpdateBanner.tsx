// Floating toast (lower-left .app-toast-stack) that an update is
// downloaded and ready to install.
//
// Subscribes to `events:app-update:status` from main; reads the
// initial status once (in case main fired before this component
// mounted) and races that read against any real event so a fresh
// event always wins. Visible only when status is `downloaded`; the
// user can either Restart now (quitAndInstall) or Dismiss (silenced
// for this version — the banner re-appears when a NEW version is
// downloaded).
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
  const [dismissedVersion, setDismissedVersion] = useState<string | undefined>();
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

  const version =
    updateStatus.status === "downloaded" ? updateStatus.version : undefined;

  useEffect(() => {
    if (version === undefined || dismissedVersion === version) return;
    // A NEW version downloaded after the user dismissed an older
    // banner — clear stale restart-error / restarting state.
    setRestartError(undefined);
    setRestarting(false);
  }, [dismissedVersion, version]);

  if (version === undefined || dismissedVersion === version) {
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
        <p className="app-update-banner__eyebrow">Update ready</p>
        <p className="app-update-banner__message">
          Restart to update to v{version}.
        </p>
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
          {restarting ? "Restarting…" : "Restart"}
        </button>
        <button
          className="app-update-banner__dismiss"
          type="button"
          disabled={restarting}
          aria-label="Dismiss update notification"
          onClick={() => setDismissedVersion(version)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
