// Settings → General.
//
// This page folds in what used to be the
// standalone Appearance page. The opt-in soak toggles (two-process
// mode, DPI-aware export) that briefly lived inline here now have their
// own "Experimental" tab — see pages/ExperimentalPage.tsx.
//
// Theme writes flow through `useSettingsContext().patch`, which the
// main process validates and broadcasts back; every other PwrSnap
// window receives the broadcast via `useAppearanceSync` and re-paints
// in lock-step. Update channel is re-read by the
// auto-updater on the next check; Launch at login syncs the OS
// login-item registration on the main side (launch-at-login.ts) and
// re-reads the live OS state via `app:launchAtLoginStatus` so the card
// can surface a macOS/Windows "disabled it OS-side" divergence.

import { useEffect, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type AppearanceTheme,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type LaunchAtLoginStatus,
  type UpdateChannel
} from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";

const THEME_OPTIONS: readonly SegmentOption<AppearanceTheme>[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" }
];

const UPDATE_CHANNEL_OPTIONS: readonly SegmentOption<UpdateChannel>[] = [
  { id: "latest", label: "Stable" },
  { id: "prerelease", label: "Prerelease" }
];

function releaseVersionText(release: AppUpdateReleaseInfo | undefined): string {
  return release?.version ?? "Unavailable";
}

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") return result.reason;
  if (result.status === "error") return `Update check failed: ${result.message}`;
  if (result.status === "checking") return "Checking for updates...";
  if (result.status === "no-update") return `You're up to date (v${result.version}).`;
  if (result.status === "downloaded") {
    return `Update ready: v${result.version}. Restart to install.`;
  }
  return `Update available: v${result.version}. Downloading in the background.`;
}

function updateStatusText(status: AppUpdateStatus): string | undefined {
  if (status.status === "checking") return "Checking for updates...";
  if (status.status === "available") {
    return `Update available: v${status.version}. Downloading in the background.`;
  }
  if (status.status === "downloading") {
    const percent = status.percent === undefined ? "" : ` (${status.percent}%)`;
    return `Downloading update v${status.version}${percent}.`;
  }
  if (status.status === "downloaded") {
    return `Update ready: v${status.version}. Restart to install.`;
  }
  if (status.status === "install-failed") {
    return `Update to v${status.version} did not finish installing. Retry to download it again and restart.`;
  }
  if (status.status === "error") return `Update check failed: ${status.message}`;
  return undefined;
}

export function GeneralPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;
  const theme: AppearanceTheme = settings?.appearance.theme ?? "system";
  const launchAtLogin = settings?.general.launchAtLogin ?? false;
  const channel: UpdateChannel = settings?.updates.channel ?? "latest";
  const videoCaptureCursor = settings?.recording.videoCaptureCursor ?? true;
  const imageCaptureCursor = settings?.recording.imageCaptureCursor ?? true;
  const platform = window.pwrsnapApi?.platform;

  // Live OS-side registration state, distinct from the saved toggle —
  // macOS/Windows let the user disable a registered login item OS-side
  // without telling us. Re-read after every toggle flip: by the time
  // `patch()` resolves and the settings broadcast lands, main has
  // already synced the registration (the write handler awaits the
  // main-side listeners), so this read sees the fresh state.
  const [loginItemStatus, setLoginItemStatus] = useState<LaunchAtLoginStatus | null>(null);
  const [releaseVersions, setReleaseVersions] = useState<AppUpdateReleaseVersions | undefined>();
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({ status: "idle" });
  const [updateResult, setUpdateResult] = useState<AppUpdateCheckResult | undefined>();
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateRestarting, setUpdateRestarting] = useState(false);
  const [updateRestartError, setUpdateRestartError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("app:launchAtLoginStatus", {});
      if (cancelled || !result.ok) return;
      setLoginItemStatus(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [launchAtLogin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await dispatch("app:update:releases", {});
      if (cancelled || !result.ok) return;
      setReleaseVersions(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let receivedEvent = false;
    const unsubscribe = subscribe(EVENT_CHANNELS.appUpdateStatus, (payload) => {
      receivedEvent = true;
      if (cancelled) return;
      const next = payload as AppUpdateStatus;
      setUpdateStatus(next);
      if (next.status === "downloaded" || next.status === "install-failed") {
        setUpdateRestartError(undefined);
        setUpdateRestarting(false);
      }
    });
    void (async () => {
      const result = await dispatch("app:update:status", {});
      if (cancelled || receivedEvent || !result.ok) return;
      setUpdateStatus(result.value);
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const onThemeChange = ready
    ? (next: AppearanceTheme): void => {
        void patch({ appearance: { theme: next } });
      }
    : (): void => {
        /* settings not loaded yet — control is interactive but
           clicks no-op until the snapshot lands. Matches PwrAgent's
           pattern; readers don't expect the control to look disabled
           before the very first IPC roundtrip completes (<50ms). */
      };

  const onLaunchAtLoginChange = ready
    ? (next: boolean): void => {
        void patch({ general: { launchAtLogin: next } });
      }
    : undefined;

  const onChannelChange = ready
    ? (next: UpdateChannel): void => {
        void patch({ updates: { channel: next } });
      }
    : (): void => {};

  // Surface the resolved theme when the user is on "System" so the
  // choice doesn't read as ambiguous. Pulled off the documentElement
  // attribute the bootstrap + useAppearance hook set — the canonical
  // truth for what the user is actually looking at.
  const resolvedLabel: "Dark" | "Light" =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? "Light"
      : "Dark";

  const themeHelp =
    theme === "system"
      ? `Following the operating system — currently ${resolvedLabel.toLowerCase()}.`
      : `Locked to ${theme === "light" ? "light" : "dark"} regardless of the OS.`;

  const updateChannelOptions: readonly SegmentOption<UpdateChannel>[] =
    UPDATE_CHANNEL_OPTIONS.map((option) => ({
      ...option,
      meta:
        releaseVersions === undefined
          ? "Loading..."
          : releaseVersionText(releaseVersions[option.id])
    }));
  const updateAction =
    updateStatus.status === "downloaded"
      ? {
          version: updateStatus.version,
          label: "Restart to Update",
          busyLabel: "Restarting...",
          ariaLabel: `Restart to Update (${updateStatus.version})`
        }
      : updateStatus.status === "install-failed"
        ? {
            version: updateStatus.version,
            label: "Retry Update",
            busyLabel: "Retrying...",
            ariaLabel: `Retry Update (${updateStatus.version})`
          }
        : undefined;
  const liveUpdateStatus = updateStatusText(updateStatus);
  const visibleUpdateStatus =
    liveUpdateStatus ?? (updateResult !== undefined ? updateResultText(updateResult) : undefined);
  const visibleUpdateStatusIsError =
    liveUpdateStatus !== undefined
      ? updateStatus.status === "error"
      : updateResult?.status === "error";

  const checkForUpdates = async (): Promise<void> => {
    setUpdateChecking(true);
    setUpdateResult(undefined);
    try {
      const result = await dispatch("app:update:check", {});
      if (!result.ok) {
        setUpdateResult({ status: "error", message: result.error.message });
        return;
      }
      setUpdateResult(result.value);
      setUpdateStatus(result.value);
    } finally {
      setUpdateChecking(false);
    }
  };

  const restartToUpdate = async (): Promise<void> => {
    setUpdateRestarting(true);
    setUpdateRestartError(undefined);
    const result = await dispatch("app:update:install", {});
    if (!result.ok) {
      setUpdateRestartError(result.error.message);
      setUpdateRestarting(false);
      return;
    }
    if (result.value.status === "error") {
      setUpdateRestartError(result.value.message);
      setUpdateRestarting(false);
    }
  };

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">General</h1>
          <p className="pss__main-sub">Appearance, startup, and update channel.</p>
        </div>
      </div>

      <Card eyebrow="APPEARANCE" title="Appearance">
        <Row label="Color scheme" sub={themeHelp} tag="theme">
          <SegmentedControl<AppearanceTheme>
            options={THEME_OPTIONS}
            value={theme}
            onChange={onThemeChange}
          />
        </Row>
      </Card>

      <Card eyebrow="CAPTURE" title="Cursor capture">
        <Row
          label="Capture the cursor in screenshots"
          sub="Adds the mouse pointer to new screenshots as its own layer — select, move, or delete it in the editor like any annotation."
          tag="images"
        >
          <Switch
            on={imageCaptureCursor}
            onChange={(next) => {
              void patch({ recording: { imageCaptureCursor: next } });
            }}
          />
        </Row>
        <Row
          label="Capture the cursor in recordings"
          sub="Bakes the pointer into new video recordings. Press C in the recording selector to override per-recording."
          tag="video"
        >
          <Switch
            on={videoCaptureCursor}
            onChange={(next) => {
              void patch({ recording: { videoCaptureCursor: next } });
            }}
          />
        </Row>
      </Card>

      <Card eyebrow="STARTUP" title="Launch at login">
        <Row
          label="Start PwrSnap when you sign in"
          sub="Starts in the background — the tray icon and capture hotkeys are ready immediately, without opening the Library."
          tag="login"
        >
          <Switch on={launchAtLogin} onChange={onLaunchAtLoginChange} />
        </Row>
        {loginItemStatus !== null &&
        !loginItemStatus.supported &&
        loginItemStatus.reason === "dev-build" ? (
          <Row
            label="Development build"
            sub="OS registration is skipped in unpackaged builds — the preference is saved, but only packaged builds add the login item."
            tag="dev"
          >
            <span className="pss__opt-sub">Saved only</span>
          </Row>
        ) : null}
        {loginItemStatus?.blockedByOs === true ? (
          <Row
            label="Disabled by the operating system"
            sub={
              platform === "darwin"
                ? "PwrSnap's login item is switched off in System Settings → General → Login Items, so it won't start at sign-in until you re-enable it there."
                : platform === "win32"
                  ? "PwrSnap's startup entry is disabled in Task Manager → Startup apps, so it won't start at sign-in until you re-enable it there."
                  : "PwrSnap's autostart entry is disabled in your desktop environment's startup settings, so it won't start at sign-in until you re-enable it there."
            }
            tag="action required"
          >
            {platform === "darwin" || platform === "win32" ? (
              // `app:openLoginItemsSettings` only has a deep link on
              // macOS/Windows; on Linux startup management lives in
              // per-DE tools, so the sub copy carries the pointer and
              // no dead button is rendered.
              <button
                className="pss__top-btn"
                type="button"
                onClick={() => {
                  void dispatch("app:openLoginItemsSettings", {});
                }}
              >
                Open startup settings
              </button>
            ) : (
              <span className="pss__opt-sub">Re-enable in your startup tool</span>
            )}
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="UPDATES" title="Update channel">
        <Row
          label="Release stream"
          sub='"Stable" tracks the latest signed release. "Prerelease" includes betas and alphas — earlier features, more rough edges. Takes effect on the next update check.'
          tag={channel}
        >
          <div className="pss__update-channel">
            <SegmentedControl
              options={updateChannelOptions}
              value={channel}
              onChange={onChannelChange}
            />
            {updateAction !== undefined ? (
              <button
                className="pss__top-btn is-active"
                type="button"
                aria-label={updateAction.ariaLabel}
                disabled={updateRestarting}
                onClick={() => {
                  void restartToUpdate();
                }}
              >
                {updateRestarting ? updateAction.busyLabel : updateAction.label}
              </button>
            ) : (
              <button
                className="pss__top-btn"
                type="button"
                disabled={updateChecking}
                onClick={() => {
                  void checkForUpdates();
                }}
              >
                {updateChecking ? "Checking..." : "Check for Updates"}
              </button>
            )}
            {updateAction !== undefined ? (
              <span className="pss__update-note">
                Update version: {updateAction.version}
              </span>
            ) : null}
            {visibleUpdateStatus !== undefined ? (
              <span
                className={
                  "pss__update-note" +
                  (visibleUpdateStatusIsError ? " pss__update-note--error" : "")
                }
                role={visibleUpdateStatusIsError ? "alert" : undefined}
              >
                {visibleUpdateStatus}
              </span>
            ) : null}
            {updateRestartError !== undefined ? (
              <span className="pss__update-note pss__update-note--error" role="alert">
                {updateRestartError}
              </span>
            ) : null}
          </div>
        </Row>
      </Card>

    </>
  );
}
