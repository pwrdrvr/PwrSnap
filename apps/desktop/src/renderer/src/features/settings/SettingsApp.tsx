// Top-level Settings shell. Mirrors the design's `Settings` component
// (design/src/Settings.jsx lines 711–728): a grid of title-bar +
// sidebar + main scroll area.
//
// The page switch is EXHAUSTIVE over `SettingsPage` (note the `never`
// default arm): every member of the union must map to a real component,
// so you can't add a sidebar page id without also giving it a screen —
// tsc fails the build otherwise. That compile-time guarantee replaces
// the old `ComingSoon` runtime placeholder now that there are no
// unbuilt pages left.

import type { ReactElement } from "react";
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

export function SettingsApp(): ReactElement {
  const active = useActivePage();
  const item = SETTINGS_PAGES_FLAT.find((i) => i.id === active) ?? SETTINGS_PAGES_FLAT[0]!;

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
    default: {
      // Exhaustiveness guard: if a new SettingsPage member is added
      // without a case above, `active` is no longer `never` and this
      // assignment is a compile error.
      const _exhaustive: never = active;
      throw new Error(`SettingsApp: unhandled page ${String(_exhaustive)}`);
    }
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
