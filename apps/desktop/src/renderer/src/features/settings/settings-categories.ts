// Single source of truth for the Settings sidebar nav.
//
// Every `id` must be a member of the `SettingsPage` union exported from
// @pwrsnap/shared so deep-linking (`dispatch("settings:open", { page:
// "ai" })`) typechecks end-to-end.
//
// This catalog drives the sidebar, the active-page routing in the main
// pane, and each page's eyebrow (`settingsGroupOf`), so a page always names
// the group it sits in. Groups follow PwrAgent's Settings nav, chosen by
// what the operator is setting up:
//
// - App: how PwrSnap itself behaves — General, Hotkeys, Updates (the
//   release-channel matrix is too tall to ride along on another page).
// - AI: the two AI pages side by side, because one is no use without the
//   other. AI Providers says what is installed and working; AI Features
//   says which of them does each job. Local Agents (agents calling IN over
//   MCP) follows them, as it does in PwrGit.
// - Capture, Library: unchanged.
// - Support: previews, diagnostics and the build — Experimental,
//   Troubleshooting, About — the same group PwrAgent ends on. The
//   Troubleshooting page keeps the id `developer`, so deep links that
//   already name it keep working (PwrGit kept `diagnostics` the same way).

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
    group: "App",
    items: [
      { id: "general", name: "General" },
      { id: "hotkeys", name: "Hotkeys" },
      { id: "updates", name: "Updates" }
    ]
  },
  {
    group: "AI",
    items: [
      { id: "ai", name: "AI Providers" },
      { id: "ai-features", name: "AI Features" },
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
    group: "Support",
    items: [
      { id: "experimental", name: "Experimental" },
      { id: "developer", name: "Troubleshooting" },
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

/** The sidebar group a page sits in. Every page header's eyebrow reads
 *  this, so the eyebrow and the sidebar can never name different groups. */
export function settingsGroupOf(page: SettingsPage): string {
  return SETTINGS_CATEGORIES.find((c) => c.items.some((i) => i.id === page))?.group ?? "";
}

/** The sidebar name of a page — the title its header shows. */
export function settingsPageName(page: SettingsPage): string {
  return SETTINGS_PAGES_FLAT.find((i) => i.id === page)?.name ?? "";
}
