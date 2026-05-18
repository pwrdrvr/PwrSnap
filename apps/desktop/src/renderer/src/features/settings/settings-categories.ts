// Single source of truth for the Settings sidebar nav.
//
// Mirrors the `CATEGORIES` array in design/src/Settings.jsx
// (lines 33–53). Every `id` must be a member of the `SettingsPage`
// union exported from @pwrsnap/shared so deep-linking
// (`dispatch("settings:open", { page: "ai" })`) typechecks end-to-end.
//
// Slice B uses this catalog for both the sidebar render and for routing
// the active page in the main pane. Subsequent slices (D / E) replace
// the per-page <ComingSoon /> with the real page components without
// touching this file.

import type { SettingsPage } from "@pwrsnap/shared";

export type SettingsCategoryItem = {
  id: SettingsPage;
  name: string;
};

export type SettingsCategory = {
  group: string;
  items: SettingsCategoryItem[];
};

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    group: "General",
    items: [
      { id: "startup", name: "Startup & Menu Bar" },
      { id: "appearance", name: "Appearance" },
      { id: "hotkeys", name: "Hotkeys" },
      { id: "notifications", name: "Notifications" },
      { id: "ai", name: "AI Providers" }
    ]
  },
  {
    group: "Capture",
    items: [
      { id: "capture", name: "Capture defaults" },
      { id: "output", name: "Output & format" },
      { id: "annotate", name: "Annotate" }
    ]
  },
  {
    group: "Library",
    items: [
      { id: "storage", name: "Storage & retention" },
      { id: "sources", name: "App detection" }
    ]
  },
  {
    group: "Advanced",
    items: [
      { id: "experimental", name: "Experimental" },
      { id: "about", name: "About" }
    ]
  }
] as const;

/** Flat list of every nav item, in sidebar order. Useful for routing
 *  + lookups (find name for an id, etc.). */
export const SETTINGS_PAGES_FLAT: readonly SettingsCategoryItem[] =
  SETTINGS_CATEGORIES.flatMap((c) => c.items);

/** All valid page ids — used by `useActivePage` to validate the hash. */
export const SETTINGS_PAGE_IDS: ReadonlySet<SettingsPage> = new Set(
  SETTINGS_PAGES_FLAT.map((i) => i.id)
);
