// Settings → General.
//
// Mirrors PwrAgent, whose "General" tab hosts Appearance + Developer
// mode + Update channel. This page folds in what used to be the
// standalone Appearance page plus the two cards that previously lived
// under "Experimental" (Developer mode, Update channel) — the
// Experimental page is gone now that its only other toggle (the unused
// PwrSnap1 file-format slot) has been removed.
//
// Theme writes flow through `useSettingsContext().patch`, which the
// main process validates and broadcasts back; every other PwrSnap
// window receives the broadcast via `useAppearanceSync` and re-paints
// in lock-step. Developer mode re-installs the application menu's View
// submenu on the main side; Update channel is re-read by the
// auto-updater on the next check; Launch at login syncs the OS
// login-item registration on the main side (launch-at-login.ts) and
// re-reads the live OS state via `app:launchAtLoginStatus` so the card
// can surface a macOS/Windows "disabled it OS-side" divergence.

import { useEffect, useState, type ReactElement } from "react";
import type { AppearanceTheme, LaunchAtLoginStatus, UpdateChannel } from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
import { dispatch } from "../../../lib/pwrsnap";
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

export function GeneralPage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const ready = settings !== null;
  const theme: AppearanceTheme = settings?.appearance.theme ?? "system";
  const developerMode = settings?.general.developerMode ?? false;
  const launchAtLogin = settings?.general.launchAtLogin ?? false;
  const channel: UpdateChannel = settings?.updates.channel ?? "latest";
  const platform = window.pwrsnapApi?.platform;

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

  const onDeveloperModeChange = ready
    ? (next: boolean): void => {
        void patch({ general: { developerMode: next } });
      }
    : undefined;

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

  // macOS-only: the two-process split doesn't exist on other platforms
  // (the boot is always single-process there), so don't show a switch
  // that can't do anything.
  const isMac = window.pwrsnapApi?.platform === "darwin";
  const processSplit = settings?.experimental.processSplit ?? false;
  const onProcessSplitChange = ready
    ? (next: boolean): void => {
        void patch({ experimental: { processSplit: next } });
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
          <p className="pss__main-sub">
            Appearance, startup, update channel, and developer options.
          </p>
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
          <SegmentedControl
            options={UPDATE_CHANNEL_OPTIONS}
            value={channel}
            onChange={onChannelChange}
          />
        </Row>
      </Card>

      <Card eyebrow="DEVELOPER" title="Developer mode">
        <Row
          label="Show developer menu items"
          sub="Expose Reload, Force Reload, and Toggle Developer Tools in the View menu. Useful for filing bug reports or hacking on PwrSnap."
          tag="developer"
        >
          <Switch on={developerMode} onChange={onDeveloperModeChange} />
        </Row>
      </Card>

      {isMac ? (
        <Card eyebrow="EXPERIMENTAL" title="Two-process mode">
          <Row
            label="Run the capture agent and Library as separate processes"
            sub="The menu-bar capture agent and the Library window run as separate apps, so capture overlays never disturb the Library or flash the Dock. Turn off to revert to single-process mode. Takes effect after PwrSnap is quit and relaunched."
            tag="process-split"
          >
            <Switch on={processSplit} onChange={onProcessSplitChange} />
          </Row>
        </Card>
      ) : null}
    </>
  );
}
