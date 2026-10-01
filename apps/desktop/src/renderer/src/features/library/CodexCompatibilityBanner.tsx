import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type CodexCliCompatibilityAlert,
  type DesktopCodexVersionAdvisory,
  type Settings,
  type SettingsChangedEvent
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import { CodexUpgradeHelp } from "../settings/CodexUpgradeHelp";

/**
 * Durable Library-window warning for the launch guard or an enabled AI
 * connection's outdated model catalog. Mounted in
 * App's toast stack (outside Library navigation), snapshot-read on mount, and
 * keyed by the command/detected/required tuple so repeated failures cannot
 * create duplicate notices.
 */
export function CodexCompatibilityBanner(): ReactElement | null {
  const [alert, setAlert] = useState<CodexCliCompatibilityAlert | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [advisory, setAdvisory] = useState<DesktopCodexVersionAdvisory | null>(null);
  const [dismissedAdvisoryKey, setDismissedAdvisoryKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.settingsChanged, (payload) => {
      receivedEvent = true;
      if (!cancelled) setSettings((payload as SettingsChangedEvent).settings);
    });
    void dispatch("settings:read", {}).then((result) => {
      if (!cancelled && !receivedEvent && result.ok) setSettings(result.value);
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, []);

  // An automatic read uses the store's publication; only Settings Refresh
  // forces discovery. Disabled AI neither probes nor produces a model toast.
  const discoveryKey = settings?.ai.enabled
    ? JSON.stringify([settings.codex.mode, settings.codex.pinnedPath, settings.codex.profile])
    : null;
  useEffect(() => {
    setAdvisory(null);
    if (discoveryKey === null) return;
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = window.pwrsnapApi?.on(EVENT_CHANNELS.codexVersionAdvisoryChanged, (payload) => {
      receivedEvent = true;
      if (!cancelled) setAdvisory(payload as DesktopCodexVersionAdvisory | null);
    });
    void dispatch("settings:refreshCodexDiscovery", { force: false }).then((result) => {
      if (!cancelled && !receivedEvent && result.ok) setAdvisory(result.value.versionAdvisory ?? null);
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [discoveryKey]);

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
    if (alert === null) {
      // Compatibility was restored. Re-arm renderer dismissal so a later
      // regression of the same command/version tuple (and therefore the same
      // stable key) is visible again without requiring a Library remount.
      setDismissedKey(null);
      setOpenError(null);
      return;
    }
    if (alert.key === dismissedKey) return;
    setOpenError(null);
  }, [alert, dismissedKey]);

  const showFailure = alert !== null && alert.key !== dismissedKey;
  const advisoryKey = advisory ? JSON.stringify(advisory) : null;
  const showAdvisory = discoveryKey !== null && advisory !== null && advisoryKey !== dismissedAdvisoryKey;
  if (!showFailure && !showAdvisory) return null;

  const openSettings = async (): Promise<void> => {
    setOpenError(null);
    // The banner is about one binary, so land on the Codex screen (binary
    // selection + connection test), not the AI Providers hub.
    const result = await dispatch("settings:open", { page: "ai", sub: "codex" });
    if (!result.ok) setOpenError(result.error.message);
  };

  return (
    <aside
      className={`app-update-banner codex-compatibility-banner${showFailure ? "" : " codex-version-banner"}`}
      role="alert"
      aria-live="assertive"
    >
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">
          {showFailure ? "Codex update required" : "Update Codex for GPT-6.1-Sol"}
        </p>
        <p className="app-update-banner__message">
          {showFailure
            ? `Codex CLI ${alert!.detectedVersion} can’t be used. PwrSnap requires ${alert!.requiredVersion} or newer.`
            : `Codex ${advisory!.version} is out of date. Update to Codex ${advisory!.minimumVersion}+ for GPT-6.1-Sol and the current model catalog.`}
        </p>
        {showAdvisory ? <CodexUpgradeHelp key={advisoryKey} advisory={advisory!} /> : null}
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
          onClick={() => {
            if (showFailure) setDismissedKey(alert!.key);
            if (showAdvisory) setDismissedAdvisoryKey(advisoryKey);
          }}
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
