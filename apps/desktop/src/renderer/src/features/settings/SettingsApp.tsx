// Top-level Settings shell. Mirrors the design's `Settings` component
// (design/src/Settings.jsx lines 711–728): a grid of title-bar +
// sidebar + main scroll area.
//
// Every sidebar entry now maps to a real page (general / hotkeys / ai /
// system-permissions / storage / about). `ComingSoon` is retained as
// the switch's default arm so a future page id added to the union
// before its component lands renders a placeholder rather than nothing.

import type { ReactElement } from "react";
import { ComingSoon } from "./ComingSoon";
import { SettingsProvider } from "./SettingsContext";
import { SETTINGS_PAGES_FLAT } from "./settings-categories";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { Sidebar } from "./Sidebar";
import { useActivePage } from "./useActivePage";
import { HotkeysPage } from "./pages/HotkeysPage";
import { AboutPage } from "./pages/AboutPage";
import { GeneralPage } from "./pages/GeneralPage";
import { AIProvidersPage } from "./pages/AIProvidersPage";
import { StoragePage } from "./pages/StoragePage";
import { SystemPermissionsPage } from "./pages/SystemPermissionsPage";

// Eyebrow strings for the placeholder pages. Mirrors the design's
// per-page `pss__main-eyebrow` values so the placeholder reads as the
// right kind of page even before the real content lands.
const EYEBROW_BY_PAGE: Record<string, string> = {
  general: "General",
  hotkeys: "General",
  ai: "Providers",
  "system-permissions": "Capture",
  storage: "Library",
  about: "Advanced"
};

export function SettingsApp(): ReactElement {
  const active = useActivePage();
  const item = SETTINGS_PAGES_FLAT.find((i) => i.id === active) ?? SETTINGS_PAGES_FLAT[0]!;
  const eyebrow = EYEBROW_BY_PAGE[active] ?? "Settings";

  let page: ReactElement;
  switch (active) {
    case "general":
      page = <GeneralPage />;
      break;
    case "hotkeys":
      page = <HotkeysPage />;
      break;
    case "ai":
      page = <AIProvidersPage />;
      break;
    case "about":
      page = <AboutPage />;
      break;
    case "storage":
      page = <StoragePage />;
      break;
    case "system-permissions":
      page = <SystemPermissionsPage />;
      break;
    default:
      page = <ComingSoon eyebrow={eyebrow} title={item.name} />;
      break;
  }

  return (
    <SettingsProvider>
      <div className="pss" data-screen-label="Settings">
        <SettingsTitleBar here={item.name} />
        <Sidebar active={active} />
        <main className="pss__main">{page}</main>
      </div>
    </SettingsProvider>
  );
}
