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
// in lock-step. Update train/track are re-read by the
// auto-updater on the next check; Launch at login syncs the OS
// login-item registration on the main side (launch-at-login.ts) and
// re-reads the live OS state via `app:launchAtLoginStatus` so the card
// can surface a macOS/Windows "disabled it OS-side" divergence.

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type AppearanceTheme,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type LaunchAtLoginStatus,
  type QuickCaptureAction,
  type UpdateChannel,
  type UpdateTrain
} from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";

const THEME_OPTIONS: readonly SegmentOption<AppearanceTheme>[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" }
];

const QUICK_CAPTURE_ACTION_OPTIONS: readonly SegmentOption<QuickCaptureAction>[] = [
  { id: "ask", label: "Ask" },
  { id: "snap", label: "Snap" },
  { id: "record", label: "Record" }
];

const UPDATE_TRAIN_OPTIONS: readonly SegmentOption<UpdateTrain>[] = [
  { id: "stable", label: "Stable" },
  { id: "beta", label: "Beta" }
];

const UPDATE_CHANNEL_OPTIONS: readonly SegmentOption<UpdateChannel>[] = [
  { id: "latest", label: "Latest" },
  { id: "prerelease", label: "Prerelease" }
];

function releaseVersionText(release: AppUpdateReleaseInfo | undefined): string {
  return release?.version ?? "Unavailable";
}

function releaseHelpText(releases: AppUpdateReleaseVersions | undefined): string {
  if (!releases) return "Release versions are loading.";
  return [
    `Stable latest: ${releaseVersionText(releases.stable.latest)}`,
    `Stable prerelease: ${releaseVersionText(releases.stable.prerelease)}`,
    `Beta latest: ${releaseVersionText(releases.beta.latest)}`,
    `Beta prerelease: ${releaseVersionText(releases.beta.prerelease)}`
  ].join(". ");
}

function updateResultText(result: AppUpdateCheckResult): string {
  if (result.status === "skipped") return result.reason;
  if (result.status === "error") return `Update check failed: ${result.message}`;
  if (result.status === "checking") return "Checking for updates...";
  if (result.status === "no-update") return `You're up to date (v${result.version}).`;
  if (result.status === "downloaded") {
    return result.downgrade === true
      ? `v${result.version} ready. Restart to switch.`
      : `Update ready: v${result.version}. Restart to install.`;
  }
  return result.downgrade === true
    ? `Switching to v${result.version}. Downloading in the background.`
    : `Update available: v${result.version}. Downloading in the background.`;
}

function updateStatusText(status: AppUpdateStatus): string | undefined {
  if (status.status === "checking") return "Checking for updates...";
  if (status.status === "available") {
    return status.downgrade === true
      ? `Switching to v${status.version}. Downloading in the background.`
      : `Update available: v${status.version}. Downloading in the background.`;
  }
  if (status.status === "downloading") {
    const percent = status.percent === undefined ? "" : ` (${status.percent}%)`;
    return status.downgrade === true
      ? `Downloading v${status.version}${percent}.`
      : `Downloading update v${status.version}${percent}.`;
  }
  if (status.status === "downloaded") {
    return status.downgrade === true
      ? `v${status.version} ready. Restart to switch.`
      : `Update ready: v${status.version}. Restart to install.`;
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
  const [pendingSelection, setPendingSelection] = useState<{
    channel: UpdateChannel;
    train: UpdateTrain;
  }>();
  const channel: UpdateChannel =
    pendingSelection?.channel ?? settings?.updates.channel ?? "latest";
  const train: UpdateTrain =
    pendingSelection?.train ?? settings?.updates.train ?? "stable";
  const selectionRef = useRef({ channel, train });
  selectionRef.current = { channel, train };
  const videoCaptureCursor = settings?.recording.videoCaptureCursor ?? true;
  const imageCaptureCursor = settings?.recording.imageCaptureCursor ?? true;
  const quickCaptureAction: QuickCaptureAction =
    settings?.recording.quickCaptureAction ?? "ask";
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
    if (pendingSelection === undefined) return;
    if (
      settings?.updates.channel === pendingSelection.channel &&
      settings?.updates.train === pendingSelection.train
    ) {
      setPendingSelection(undefined);
    }
  }, [pendingSelection, settings?.updates.channel, settings?.updates.train]);

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

  const persistUpdateSelection = (next: {
    channel: UpdateChannel;
    train: UpdateTrain;
  }): void => {
    // Persist both keys, including stable/latest, so a Beta binary
    // does not re-infer after the operator picks Stable. Keep the pair
    // in local pending state so a second click before the settings
    // broadcast cannot overwrite the first axis from a stale render.
    selectionRef.current = next;
    setPendingSelection(next);
    void patch({ updates: next });
  };

  const onTrainChange = ready
    ? (next: UpdateTrain): void => {
        persistUpdateSelection({ train: next, channel: selectionRef.current.channel });
      }
    : (): void => {};

  const onChannelChange = ready
    ? (next: UpdateChannel): void => {
        persistUpdateSelection({ train: selectionRef.current.train, channel: next });
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

  const updateTrainOptions: readonly SegmentOption<UpdateTrain>[] =
    UPDATE_TRAIN_OPTIONS.map((option) => ({
      ...option,
      meta:
        releaseVersions === undefined
          ? "Loading..."
          // Index by the selected track, the same way the track control
          // indexes by the selected train. Showing `.latest` here labels a
          // train with a version that selecting it would not resolve to.
          : releaseVersionText(releaseVersions[option.id][channel])
    }));
  const updateChannelOptions: readonly SegmentOption<UpdateChannel>[] =
    UPDATE_CHANNEL_OPTIONS.map((option) => ({
      ...option,
      meta:
        releaseVersions === undefined
          ? "Loading..."
          : releaseVersionText(releaseVersions[train][option.id])
    }));
  const updateAction =
    updateStatus.status === "downloaded"
      ? {
          version: updateStatus.version,
          label: updateStatus.downgrade === true ? "Restart to Switch" : "Restart to Update",
          busyLabel: "Restarting...",
          ariaLabel:
            updateStatus.downgrade === true
              ? `Restart to Switch (${updateStatus.version})`
              : `Restart to Update (${updateStatus.version})`
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
      // The check just revalidated main's release cache, so this read is
      // served from memory and costs no GitHub request. It clears any stale
      // Unavailable slot labels left by an earlier failed read.
      const versions = await dispatch("app:update:releases", {});
      if (versions.ok) {
        setReleaseVersions(versions.value);
      }
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
          <p className="pss__main-sub">Appearance, startup, and updates.</p>
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

      <Card eyebrow="CAPTURE" title="After you select">
        <Row
          label="What ↵ does once you have a selection"
          sub="Ask offers both — ↵ snaps, R records the same selection. Snap hides the Record action entirely. Record makes ↵ start a recording and moves Snap to S. The Video Capture hotkey always records, whichever you pick."
          tag="action"
        >
          <SegmentedControl<QuickCaptureAction>
            options={QUICK_CAPTURE_ACTION_OPTIONS}
            value={quickCaptureAction}
            onChange={(next) => {
              if (!ready) return;
              void patch({ recording: { quickCaptureAction: next } });
            }}
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
              if (!ready) return;
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
              if (!ready) return;
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

      <Card eyebrow="UPDATES" title="Updates">
        <Row
          label="Release channel"
          sub="Stable is the smoke-checked train. Beta follows main and stays selectable even when its versions are still Unavailable."
          tag={train}
        >
          <SegmentedControl
            options={updateTrainOptions}
            value={train}
            onChange={onTrainChange}
          />
        </Row>
        <Row
          label="Update track"
          sub={`Latest is smoke-checked. Prerelease is newer and may not install. ${releaseHelpText(releaseVersions)}`}
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
