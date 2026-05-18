// Settings → General → Appearance.
//
// Single segmented control over `appearance.theme`. Writes flow
// through `useSettingsContext().patch`, which the main process
// validates and broadcasts back. Every other PwrSnap window receives
// the broadcast via `useAppearanceSync` and re-paints in lock-step.
//
// Why only theme (no density): density is a per-product design call
// and the PwrAgent #476 patterns it ships (thread-row chip
// suppression, sidebar gap tightening) don't have direct PwrSnap
// counterparts. Deferred to a follow-up.

import type { ReactElement } from "react";
import type { AppearanceTheme } from "@pwrsnap/shared";
import { Card, Row, SegmentedControl, type SegmentOption } from "../components";
import { useSettingsContext } from "../SettingsContext";

const THEME_OPTIONS: readonly SegmentOption<AppearanceTheme>[] = [
  { id: "system", label: "System" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" }
];

export function AppearancePage(): ReactElement {
  const { settings, patch } = useSettingsContext();
  const theme: AppearanceTheme = settings?.appearance.theme ?? "system";
  const ready = settings !== null;

  const onChange = ready
    ? (next: AppearanceTheme): void => {
        void patch({ appearance: { theme: next } });
      }
    : (): void => {
        /* settings not loaded yet — control is interactive but
           clicks no-op until the snapshot lands. The interactive
           state matches PwrAgent's pattern; readers don't expect
           the control to look disabled before the very first IPC
           roundtrip completes (typically <50ms). */
      };

  // Help text mirrors PwrAgent's wording — when the user has picked
  // "System", surface whichever resolved theme is currently applied
  // so the choice doesn't read as ambiguous. We pull resolution off
  // the documentElement attribute the bootstrap + useAppearance
  // hook set, rather than calling matchMedia again here — that
  // attribute is the canonical truth for what the user is actually
  // looking at.
  const resolvedLabel: "Dark" | "Light" =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light"
      ? "Light"
      : "Dark";

  const help =
    theme === "system"
      ? `Following the operating system — currently ${resolvedLabel.toLowerCase()}.`
      : `Locked to ${theme === "light" ? "light" : "dark"} regardless of the OS.`;

  return (
    <>
      <div className="pss__main-hdr">
        <div className="pss__main-hdr-l">
          <div className="pss__main-eyebrow">General</div>
          <h1 className="pss__main-title">Appearance</h1>
          <p className="pss__main-sub">
            Choose how PwrSnap windows look. System tracks your macOS
            appearance and flips live when you toggle it; Dark and Light
            pin the renderer regardless. The menu-bar tray popover
            always follows the OS so it matches the system popover
            material — this preference doesn't apply there.
          </p>
        </div>
      </div>

      <Card eyebrow="THEME" title="Theme">
        <Row label="Color scheme" sub={help} tag="theme">
          <SegmentedControl<AppearanceTheme>
            options={THEME_OPTIONS}
            value={theme}
            onChange={onChange}
          />
        </Row>
      </Card>
    </>
  );
}
