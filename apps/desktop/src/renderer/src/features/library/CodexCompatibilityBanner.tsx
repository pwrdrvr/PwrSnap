import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type CodexCliCompatibilityAlert
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";

/**
 * Durable Library-window warning for the exact too-old CLI guard. Mounted in
 * App's toast stack (outside Library navigation), snapshot-read on mount, and
 * keyed by the command/detected/required tuple so repeated failures cannot
 * create duplicate notices.
 */
export function CodexCompatibilityBanner(): ReactElement | null {
  const [alert, setAlert] = useState<CodexCliCompatibilityAlert | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(
      EVENT_CHANNELS.codexCompatibilityAlertChanged,
      (payload) => {
        receivedEvent = true;
        if (cancelled) return;
        setAlert(payload as CodexCliCompatibilityAlert | null);
      }
    );
    void (async () => {
      const result = await dispatch("codex:compatibilityAlert", {});
      if (cancelled || receivedEvent || !result.ok) return;
      setAlert(result.value);
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (alert === null || alert.key === dismissedKey) return;
    setOpenError(null);
  }, [alert, dismissedKey]);

  if (alert === null || alert.key === dismissedKey) return null;

  const openSettings = async (): Promise<void> => {
    setOpenError(null);
    const result = await dispatch("settings:open", { page: "ai" });
    if (!result.ok) setOpenError(result.error.message);
  };

  return (
    <aside
      className="app-update-banner codex-compatibility-banner"
      role="alert"
      aria-live="assertive"
    >
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">Codex update required</p>
        <p className="app-update-banner__message">
          {`Codex CLI ${alert.detectedVersion} can’t be used. PwrSnap requires ${alert.requiredVersion} or newer.`}
        </p>
        {openError !== null ? (
          <p className="app-update-banner__error">{openError}</p>
        ) : null}
      </div>
      <div className="app-update-banner__actions">
        <button
          className="app-update-banner__restart"
          type="button"
          onClick={() => {
            void openSettings();
          }}
        >
          Open Settings
        </button>
        <button
          className="app-update-banner__dismiss"
          type="button"
          aria-label="Dismiss Codex compatibility notification"
          onClick={() => setDismissedKey(alert.key)}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
