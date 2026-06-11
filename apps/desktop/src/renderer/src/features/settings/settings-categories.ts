// Single source of truth for the Settings sidebar nav.
//
// Every `id` must be a member of the `SettingsPage` union exported from
// @pwrsnap/shared so deep-linking (`dispatch("settings:open", { page:
// "ai" })`) typechecks end-to-end.
//
// This catalog drives both the sidebar render and the active-page
// routing in the main pane. It originally mirrored the design handoff's
// `CATEGORIES` array (design/src/Settings.jsx), but intentionally
// diverges now: the release trim dropped the unbuilt placeholder pages
// (Startup & Menu Bar, Notifications, Capture defaults, Output & format,
// Annotate, App detection, Experimental) and folded Appearance +
// Developer mode + Update channel into a single "General" page.

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
      { id: "general", name: "General" },
      { id: "hotkeys", name: "Hotkeys" },
      { id: "ai", name: "AI Providers" },
      { id: "local-agents", name: "Local Agents" }
    ]
  },
  {
    group: "Capture",
    items: [{ id: "system-permissions", name: "System Permissions" }]
  },
  {
    group: "Library",
    items: [{ id: "storage", name: "Storage & retention" }]
  },
  {
    group: "Advanced",
    items: [{ id: "about", name: "About" }]
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
