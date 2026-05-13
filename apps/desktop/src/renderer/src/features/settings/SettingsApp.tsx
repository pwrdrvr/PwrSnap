// Top-level Settings shell. Mirrors the design's `Settings` component
// (design/src/Settings.jsx lines 711–728): a grid of title-bar +
// sidebar + main scroll area.
//
// Slice B rendered every page as `<ComingSoon />`. Slices D + E swap
// in real pages for hotkeys / ai / about / experimental; the rest
// remain ComingSoon until their backing surfaces land.

import type { ReactElement } from "react";
import { ComingSoon } from "./ComingSoon";
import { SETTINGS_PAGES_FLAT } from "./settings-categories";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { Sidebar } from "./Sidebar";
import { useActivePage } from "./useActivePage";
import { HotkeysPage } from "./pages/HotkeysPage";
import { AboutPage } from "./pages/AboutPage";
import { ExperimentalPage } from "./pages/ExperimentalPage";
import { AIProvidersPage } from "./pages/AIProvidersPage";

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

  let page: ReactElement;
  switch (active) {
    case "hotkeys":
      page = <HotkeysPage />;
      break;
    case "ai":
      page = <AIProvidersPage />;
      break;
    case "about":
      page = <AboutPage />;
      break;
    case "experimental":
      page = <ExperimentalPage />;
      break;
    default:
      page = <ComingSoon eyebrow={eyebrow} title={item.name} />;
      break;
  }

  return (
    <div className="pss" data-screen-label="Settings">
      <SettingsTitleBar here={item.name} />
      <Sidebar active={active} />
      <main className="pss__main">{page}</main>
    </div>
  );
}
