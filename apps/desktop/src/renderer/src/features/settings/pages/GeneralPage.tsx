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
//
// The two CAPTURE cards own the `settings.recording.*` defaults for new
// captures: cursor baking (images + video) and audio sources (video).
// Audio is the one pair with a hard dependency — `recording:start`
// refuses to run when a requested source isn't granted — so opting in
// surfaces a jump to System Permissions.
//
// The EDITOR card hosts `editor.matchingText.enabled`. There is no
// Settings → Editor page (see settings-categories.ts), and the schema
// comments used to point at one — so the only opt-out for the
// "+ Add label" chip was hand-editing pwrsnap-settings.json. One card
// here beats a page for a single toggle.

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  EVENT_CHANNELS,
  type AppearanceTheme,
  type AppUpdateCheckResult,
  type AppUpdateReleaseInfo,
  type AppUpdateReleaseVersions,
  type AppUpdateStatus,
  type LaunchAtLoginStatus,
  type UpdateChannel,
  type UpdateTrain
} from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { dispatch, subscribe } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";

/** Shared by both audio rows off macOS. One constant, not two literals:
 *  only one of the two is pinned by a test, so a copy edit to the other
 *  would ship stale. */
const AUDIO_UNSUPPORTED_SUB =
  "Recording audio is macOS-only for now — PwrSnap records video only on this platform. The preference is saved for when the recorder here grows audio support.";

const THEME_OPTIONS: readonly SegmentOption<AppearanceTheme>[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" }
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
  // Audio defaults for new recordings. Both ship OFF — recording either
  // source is privacy-relevant, so the user opts in explicitly.
  const includeSystemAudio = settings?.recording.includeSystemAudio ?? false;
  const includeMicrophone = settings?.recording.includeMicrophone ?? false;
  // Matching-text affordance ("+ Add label" after an arrow lands).
  // Defaults ON; the hook falls back to true while settings are loading,
  // so mirror that here rather than flashing the switch off.
  const matchingTextEnabled = settings?.editor.matchingText.enabled ?? true;
  const platform = window.pwrsnapApi?.platform;
  // Recording audio is macOS-only, so this is a POSITIVE test. Windows
  // records through FFmpeg, which captures screen video only and logs a
  // warning when either toggle is on (recording-service.ts); Linux has
  // no recorder at all (resolveRecorderBinary returns null off darwin).
  // `platform !== "win32"` would read Linux — and an absent preload
  // bridge — as macOS and show them Mac-specific copy.
  const audioSupported = platform === "darwin";

  // Microphone opt-in has to REQUEST the grant, not just save a flag.
  // macOS reports `not-determined` until something calls
  // askForMediaAccess, and nothing else in the app ever does for the mic
  // — while `recording:start` REJECTS an ungranted microphone rather
  // than degrading to video-only (recording-handlers.ts preflight). So
  // persisting `true` on an un-granted mic bricks every subsequent
  // recording, with the failure surfacing only as a best-effort
  // notification. index.ts's own routing comment asks for exactly this:
  // "When mic features ship, request them in-context, not here."
  //
  // Off darwin `permissions:request` is a no-op that returns "granted",
  // so this costs nothing there.
  const [micDenied, setMicDenied] = useState(false);
  const onMicrophoneChange = (next: boolean): void => {
    if (!ready) return;
    if (!next) {
      setMicDenied(false);
      void patch({ recording: { includeMicrophone: false } });
      return;
    }
    if (!audioSupported) {
      // No recorder here can use the mic, so there is no grant to ask
      // for — just remember the preference for when one can.
      void patch({ recording: { includeMicrophone: true } });
      return;
    }
    void (async () => {
      const result = await dispatch("permissions:request", {
        permission: "microphone"
      });
      const granted = result.ok && result.value.status === "granted";
      setMicDenied(!granted);
      // Only persist the opt-in once the OS has actually said yes.
      if (granted) await patch({ recording: { includeMicrophone: true } });
    })();
  };

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

      <Card eyebrow="CAPTURE" title="Recording audio">
        <Row
          label="Include system audio"
          sub={
            audioSupported
              ? "Records what your Mac is playing alongside the screen. Shares the Screen Recording grant you already gave PwrSnap — there's no separate permission to enable."
              : AUDIO_UNSUPPORTED_SUB
          }
          tag="video"
        >
          <Switch
            on={includeSystemAudio}
            onChange={(next) => {
              if (!ready) return;
              void patch({ recording: { includeSystemAudio: next } });
            }}
          />
        </Row>
        <Row
          label="Include your microphone"
          sub={
            audioSupported
              ? "Records your voice alongside the screen — narration, walkthroughs. macOS asks for permission the first time you switch this on."
              : AUDIO_UNSUPPORTED_SUB
          }
          tag="video"
        >
          <Switch
            on={includeMicrophone}
            onChange={onMicrophoneChange}
          />
        </Row>
        {micDenied ? (
          // The OS said no (or the user dismissed the prompt). We did NOT
          // persist the toggle — `recording:start` REJECTS an ungranted
          // microphone rather than degrading to video-only
          // (recording-handlers.ts preflight), so saving it here would
          // brick every subsequent recording with a failure that only
          // surfaces as a best-effort notification.
          <Row
            label="Microphone is blocked"
            sub="macOS won't prompt twice. Turn Microphone on for PwrSnap in System Settings → Privacy & Security, then switch this back on."
            tag="action required"
          >
            <button
              className="pss__top-btn"
              type="button"
              onClick={() => setActivePage("system-permissions")}
            >
              Open System Permissions
            </button>
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="EDITOR" title="Annotation">
        <Row
          label="Offer a label after placing an arrow"
          sub="Pops a “+ Add label” chip near the arrow's tail. Click it to drop matching text in the arrow's color; ignore it and it fades on its own."
          tag="arrows"
        >
          <Switch
            on={matchingTextEnabled}
            onChange={(next) => {
              if (!ready) return;
              void patch({ editor: { matchingText: { enabled: next } } });
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
