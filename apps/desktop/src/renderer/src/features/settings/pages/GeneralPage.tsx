// Settings → General.
//
// This page folds in what used to be the
// standalone Appearance page. The opt-in soak toggles (two-process
// mode, DPI-aware export) that briefly lived inline here now have their
// own "Experimental" tab — see pages/ExperimentalPage.tsx, and the
// release train/track moved to pages/UpdatesPage.tsx.
//
// Theme writes flow through `useSettingsContext().patch`, which the
// main process validates and broadcasts back; every other PwrSnap
// window receives the broadcast via `useAppearanceSync` and re-paints
// in lock-step. Launch at login syncs the OS
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

import { useEffect, useState, type ReactElement } from "react";
import {
  type AppearanceTheme,
  type LaunchAtLoginStatus,
  type QuickCaptureAction
} from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { dispatch } from "../../../lib/pwrsnap";
import { useSettingsContext } from "../SettingsContext";
import { setActivePage } from "../useActivePage";

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

export function GeneralPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;
  const theme: AppearanceTheme = settings?.appearance.theme ?? "system";
  const launchAtLogin = settings?.general.launchAtLogin ?? false;
  const videoCaptureCursor = settings?.recording.videoCaptureCursor ?? true;
  const imageCaptureCursor = settings?.recording.imageCaptureCursor ?? true;
  const showRegionFrame = settings?.recording.showRegionFrame ?? true;
  const quickCaptureAction: QuickCaptureAction =
    settings?.recording.quickCaptureAction ?? "ask";
  // Audio defaults for new recordings. Both ship OFF — recording either
  // source is privacy-relevant, so the user opts in explicitly.
  const includeSystemAudio = settings?.recording.includeSystemAudio ?? false;
  const includeMicrophone = settings?.recording.includeMicrophone ?? false;
  // Matching-text affordance ("+ Add label" after an arrow lands).
  // Defaults ON; the hook falls back to true while settings are loading,
  // so mirror that here rather than flashing the switch off.
  const matchingTextEnabled = settings?.editor.matchingText.enabled ?? true;
  const platform = window.pwrsnapApi?.platform;
  // The FFmpeg backend that drives Windows recording captures screen
  // video only and logs a warning when either toggle is on
  // (recording-service.ts). Say so rather than letting the switches
  // imply audio the recorder will silently drop.
  const audioSupported = platform !== "win32";

  // Live OS-side registration state, distinct from the saved toggle —
  // macOS/Windows let the user disable a registered login item OS-side
  // without telling us. Re-read after every toggle flip: by the time
  // `patch()` resolves and the settings broadcast lands, main has
  // already synced the registration (the write handler awaits the
  // main-side listeners), so this read sees the fresh state.
  const [loginItemStatus, setLoginItemStatus] = useState<LaunchAtLoginStatus | null>(null);

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

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">General</h1>
          <p className="pss__main-sub">Appearance, capture defaults, and startup.</p>
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

      <Card eyebrow="CAPTURE" title="Recording frame">
        <Row
          label="Outline the area being recorded"
          sub="Draws a tangerine frame around the recorded region while a video capture runs. Never appears in the recording itself."
          tag="video"
        >
          <Switch
            on={showRegionFrame}
            onChange={(next) => {
              if (!ready) return;
              void patch({ recording: { showRegionFrame: next } });
            }}
          />
        </Row>
      </Card>

      <Card eyebrow="CAPTURE" title="Recording audio">
        <Row
          label="Include system audio"
          sub={
            audioSupported
              ? "Records what your Mac is playing alongside the screen. Needs the System Audio permission — without it, recording refuses to start."
              : "Windows recordings are video-only for now, so this has no effect there. The preference is saved for when the Windows recorder grows audio support."
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
              ? "Records your voice alongside the screen — narration, walkthroughs. Needs the Microphone permission — without it, recording refuses to start."
              : "Windows recordings are video-only for now, so this has no effect there. The preference is saved for when the Windows recorder grows audio support."
          }
          tag="video"
        >
          <Switch
            on={includeMicrophone}
            onChange={(next) => {
              if (!ready) return;
              void patch({ recording: { includeMicrophone: next } });
            }}
          />
        </Row>
        {audioSupported && (includeSystemAudio || includeMicrophone) ? (
          // `recording:start` hard-fails when a requested audio source
          // isn't granted (recording-handlers.ts preflight), so send the
          // user to the grant surface the moment they opt in rather than
          // letting them discover it mid-take.
          <Row
            label="Audio permissions"
            sub="Recording refuses to start if a source you've enabled here isn't granted. Check the status of each source before your next take."
            tag="check"
          >
            {/* `.pss__row-r` is a stretch column, so a bare button fills
                the row's full width. Wrap it the way System Permissions
                wraps its own row buttons so this one hugs its label. */}
            <div style={{ display: "flex" }}>
              <button
                className="pss__top-btn"
                type="button"
                onClick={() => setActivePage("system-permissions")}
              >
                Open System Permissions
              </button>
            </div>
          </Row>
        ) : null}
      </Card>

      <Card eyebrow="EDITOR" title="Annotation">
        <Row
          label="Offer a label after placing an arrow"
          sub="Pops a “+ Add label” chip near the arrow's tail for 8 seconds. Click it to drop matching text in the arrow's color; ignore it and it disappears."
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

    </>
  );
}
