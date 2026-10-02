import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type CodexCliCompatibilityAlert,
  type DesktopCodexVersionAdvisory,
  type Settings,
  type SettingsChangedEvent
} from "@pwrsnap/shared";
import { dispatch } from "../../lib/pwrsnap";
import {
  CODEX_RELEASES_URL,
  codexUpgradeNextStep,
  copyAccessibleName,
  copyLabel,
  openCodexReleases,
  useCopyCommand
} from "../settings/CodexUpgradeHelp";

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
    <CodexBannerCard
      // Copy feedback belongs to one command: a new alert or advisory
      // starts from "Copy command" again.
      key={`${showFailure ? alert!.key : ""}|${showAdvisory ? advisoryKey : ""}`}
      alert={showFailure ? alert : null}
      advisory={showAdvisory ? advisory : null}
      openError={openError}
      onOpenSettings={() => { void openSettings(); }}
      onDismiss={() => {
        if (showFailure) setDismissedKey(alert!.key);
        if (showAdvisory) setDismissedAdvisoryKey(advisoryKey);
      }}
    />
  );
}

/**
 * One card for both notices. The launch failure, or an advisory whose binary
 * cannot run at all, is a danger card ("required"); an advisory on a binary
 * that runs is a warn card ("available"). When the installer has a known
 * upgrade command, copying it is the primary action and Settings drops to a
 * text link; otherwise Settings is primary (it shows which binary, which says
 * how it was installed).
 */
function CodexBannerCard({ alert, advisory, openError, onOpenSettings, onDismiss }: {
  alert: CodexCliCompatibilityAlert | null;
  advisory: DesktopCodexVersionAdvisory | null;
  openError: string | null;
  onOpenSettings: () => void;
  onDismiss: () => void;
}): ReactElement {
  const command = advisory?.upgradeCommand;
  const { state, copy } = useCopyCommand(command);
  const required = alert !== null || advisory?.blocking === true;
  const headline = alert !== null
    ? `Codex CLI ${alert.detectedVersion} can’t be used. PwrSnap requires ${alert.requiredVersion} or newer.`
    : advisory!.blocking
      ? `Codex ${advisory!.version} is too old to run.`
      : `Codex ${advisory!.version} predates GPT-6.1-Sol.`;
  const message = advisory ? `${headline} ${codexUpgradeNextStep(advisory)}` : headline;

  return (
    <aside
      className={`app-update-banner ${required ? "codex-compatibility-banner" : "codex-version-banner"}`}
      // Only a Codex that cannot run interrupts a screen reader; an optional
      // update is announced politely, like the other informational toasts.
      role={required ? "alert" : "status"}
      aria-live={required ? "assertive" : "polite"}
    >
      <div className="app-update-banner__content">
        <p className="app-update-banner__eyebrow">
          {required ? "Codex update required" : "Codex update available"}
        </p>
        <p className="app-update-banner__message">{message}</p>
        {command ? <pre className="app-update-banner__command">{command}</pre> : null}
        {openError !== null ? (
          <p className="app-update-banner__error">{openError}</p>
        ) : null}
      </div>
      <div className="app-update-banner__actions">
        {command ? (
          <button
            className="app-update-banner__restart"
            type="button"
            aria-label={copyAccessibleName(state)}
            onClick={() => { void copy(); }}
          >
            {copyLabel(state, "Copy command")}
          </button>
        ) : (
          <button className="app-update-banner__restart" type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        )}
        <button
          className="app-update-banner__dismiss"
          type="button"
          aria-label="Dismiss Codex compatibility notification"
          onClick={onDismiss}
        >
          Dismiss
        </button>
        {command ? (
          <button className="app-update-banner__notes" type="button" onClick={onOpenSettings}>
            Codex settings
          </button>
        ) : advisory?.installer === "unknown" ? (
          // A real, copyable URL; the click routes through app:openExternal
          // (see the navigation-guard section of AGENTS.md).
          <a
            className="app-update-banner__notes"
            href={CODEX_RELEASES_URL}
            onClick={(event) => {
              event.preventDefault();
              openCodexReleases();
            }}
          >
            Codex releases ↗
          </a>
        ) : null}
      </div>
    </aside>
  );
}
