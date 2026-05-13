// Tiny hook that reads the current Settings page from the URL hash
// (`#stage=settings&page=<id>`). Defaults to "ai" when the page param
// is missing or invalid. Re-renders on `hashchange` so deep-link
// navigation updates the visible page without a full reload.
//
// Two navigation drivers feed this hook:
//   1. In-renderer sidebar clicks → `setActivePage` (below) sets the
//      hash; the browser fires `hashchange`; the hook re-reads.
//   2. Main → renderer deep-link via `settings:open { page }` against
//      an already-focused window → main broadcasts the typed
//      `EVENT_CHANNELS.settingsNavigate` event; this hook calls
//      `setActivePage` on receipt. (Previously main interpolated the
//      page id into a `webContents.executeJavaScript` string literal
//      — replaced for transport-safety; see ipc.ts.)

import { useEffect, useState } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type { SettingsNavigateEvent, SettingsPage } from "@pwrsnap/shared";
import { subscribe } from "../../lib/pwrsnap";
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
    const unsubscribe = subscribe(
      EVENT_CHANNELS.settingsNavigate,
      (payload: unknown) => {
        // Main re-validates page-id against SETTINGS_PAGES at the bus
        // boundary, but be defensive — only honor known ids. The
        // `hashchange` listener picks up the resulting hash flip and
        // re-renders.
        const navigate = payload as SettingsNavigateEvent;
        if (
          typeof navigate === "object" &&
          navigate !== null &&
          SETTINGS_PAGE_IDS.has(navigate.page)
        ) {
          setActivePage(navigate.page);
        }
      }
    );
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      unsubscribe();
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
