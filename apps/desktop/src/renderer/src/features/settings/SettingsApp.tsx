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

import { useLayoutEffect, useRef, type ReactElement } from "react";
import { AiProvidersProvider, useAiProvidersContext } from "./AiProvidersContext";
import { SettingsProvider } from "./SettingsContext";
import { SETTINGS_PAGES_FLAT } from "./settings-categories";
import { SettingsTitleBar } from "./SettingsTitleBar";
import { Sidebar } from "./Sidebar";
import { setActivePage, useActiveRoute } from "./useActivePage";
import { HotkeysPage } from "./pages/HotkeysPage";
import { AboutPage } from "./pages/AboutPage";
import { GeneralPage } from "./pages/GeneralPage";
import { UpdatesPage } from "./pages/UpdatesPage";
import { AIProvidersPage } from "./pages/AIProvidersPage";
import { LocalAgentsPage } from "./pages/LocalAgentsPage";
import { StoragePage } from "./pages/StoragePage";
import { SystemPermissionsPage } from "./pages/SystemPermissionsPage";
import { ExperimentalPage } from "./pages/ExperimentalPage";
import { DeveloperPage } from "./pages/DeveloperPage";

export function SettingsApp(): ReactElement {
  return (
    <SettingsProvider>
      <AiProvidersProvider>
        <SettingsShell />
      </AiProvidersProvider>
    </SettingsProvider>
  );
}

function SettingsShell(): ReactElement {
  const { page: active, sub } = useActiveRoute();
  const { statuses } = useAiProvidersContext();
  const item = SETTINGS_PAGES_FLAT.find((i) => i.id === active) ?? SETTINGS_PAGES_FLAT[0]!;
  // Crumb label from the same catalog the sidebar renders, so the two
  // can't name a screen differently.
  const subLabel =
    sub !== null && active === "ai"
      ? statuses.find((status) => status.sub === sub)?.label
      : undefined;

  // `<main>` outlives every page switch, so without this a page opened
  // from a scrolled one lands mid-way down. Layout effect: reset before
  // paint rather than flash the old offset.
  const mainRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (mainRef.current !== null) mainRef.current.scrollTop = 0;
  }, [active, sub]);

  let page: ReactElement;
  switch (active) {
    case "general":
      page = <GeneralPage />;
      break;
    case "updates":
      page = <UpdatesPage />;
      break;
    case "hotkeys":
      page = <HotkeysPage />;
      break;
    case "ai":
      page = <AIProvidersPage sub={sub} />;
      break;
    case "local-agents":
      page = <LocalAgentsPage />;
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
    case "experimental":
      page = <ExperimentalPage />;
      break;
    case "developer":
      page = <DeveloperPage />;
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
    <div className="pss" data-screen-label="Settings">
      {subLabel !== undefined ? (
        <SettingsTitleBar
          here={subLabel}
          parent={{ label: item.name, onOpen: () => setActivePage(active) }}
        />
      ) : (
        <SettingsTitleBar here={item.name} />
      )}
      <Sidebar active={active} sub={sub} />
      <main className="pss__main" ref={mainRef}>
        {page}
      </main>
    </div>
  );
}
