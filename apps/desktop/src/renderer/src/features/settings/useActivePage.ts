// Tiny hook that reads the current Settings page from the URL hash
// (`#stage=settings&page=<id>`). Defaults to "ai" when the page param
// is missing or invalid. Re-renders on `hashchange` so deep-link
// navigation from main (via `webContents.executeJavaScript` setting
// `location.hash`) updates the visible page without a full reload.

import { useEffect, useState } from "react";
import type { SettingsPage } from "@pwrsnap/shared";
import { SETTINGS_PAGE_IDS } from "./settings-categories";

const DEFAULT_PAGE: SettingsPage = "ai";

/**
 * Pure parser. Extracted so it's trivially testable without a DOM —
 * the hook just wraps this + a `hashchange` listener.
 */
export function pageFromHash(hash: string): SettingsPage {
  const stripped = hash.replace(/^#/, "");
  const params = new URLSearchParams(stripped);
  const raw = params.get("page");
  if (raw === null) return DEFAULT_PAGE;
  if (SETTINGS_PAGE_IDS.has(raw as SettingsPage)) {
    return raw as SettingsPage;
  }
  return DEFAULT_PAGE;
}

export function useActivePage(): SettingsPage {
  const [page, setPage] = useState<SettingsPage>(() => pageFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = (): void => {
      setPage(pageFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);
  return page;
}

/** Replace the `page` param on the hash, preserving `stage=settings`.
 *  Sidebar nav buttons call this; `hashchange` then propagates the
 *  change back through `useActivePage`. */
export function setActivePage(page: SettingsPage): void {
  window.location.hash = `stage=settings&page=${page}`;
}
