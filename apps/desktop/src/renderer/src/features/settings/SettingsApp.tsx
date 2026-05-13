// Top-level Settings shell. Mirrors the design's `Settings` component
// (design/src/Settings.jsx lines 711–728): a grid of title-bar +
// sidebar + main scroll area.
//
// Slice B renders every page as `<ComingSoon />`. Slices D / E will
// swap the per-id branches for real page components — adding a page
// then is one switch arm, not a structural change.

import type { ReactElement } from "react";
import { ComingSoon } from "./ComingSoon";
import { SETTINGS_PAGES_FLAT } from "./settings-categories";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { Sidebar } from "./Sidebar";
import { useActivePage } from "./useActivePage";

// Eyebrow strings for the placeholder pages. Mirrors the design's
// per-page `pss__main-eyebrow` values so the placeholder reads as the
// right kind of page even before the real content lands.
const EYEBROW_BY_PAGE: Record<string, string> = {
  startup: "General",
  hotkeys: "General",
  notifications: "General",
  ai: "Providers",
  capture: "Capture",
  output: "Capture",
  annotate: "Capture",
  storage: "Library",
  sources: "Library",
  experimental: "Advanced",
  about: "Advanced"
};

export function SettingsApp(): ReactElement {
  const active = useActivePage();
  const item = SETTINGS_PAGES_FLAT.find((i) => i.id === active) ?? SETTINGS_PAGES_FLAT[0]!;
  const eyebrow = EYEBROW_BY_PAGE[active] ?? "Settings";
  return (
    <div className="pss" data-screen-label="Settings">
      <SettingsTitleBar here={item.name} />
      <Sidebar active={active} />
      <main className="pss__main">
        <ComingSoon eyebrow={eyebrow} title={item.name} />
      </main>
    </div>
  );
}
