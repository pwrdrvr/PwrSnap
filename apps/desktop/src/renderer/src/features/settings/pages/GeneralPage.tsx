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
// auto-updater on the next check.

import type { ReactElement } from "react";
import type { AppearanceTheme, UpdateChannel } from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, Switch, type SegmentOption } from "../components";
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
  const channel: UpdateChannel = settings?.updates.channel ?? "latest";

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

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">General</h1>
          <p className="pss__main-sub">
            Appearance, update channel, and developer options.
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
    </>
  );
}
