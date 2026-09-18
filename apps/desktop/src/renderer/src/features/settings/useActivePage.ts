// Tiny hook that reads the current Settings route from the URL hash
// (`#stage=settings&page=<id>[&sub=<id>]`). Defaults to "general" (the
// first sidebar item) when the page param is missing or invalid. Re-renders
// on `hashchange` so deep-link navigation updates the visible page
// without a full reload.
//
// `sub` is a screen WITHIN a page — today only the AI Providers page has
// them (one per provider, reached from the sidebar's child rows). It is
// validated against the page's own sub-id set; an unknown or misplaced
// sub drops to the page's hub rather than rendering a blank screen.
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
import { isAiProviderSub } from "./ai-provider-status";
import { SETTINGS_PAGE_IDS } from "./settings-categories";

const DEFAULT_PAGE: SettingsPage = "general";

export type SettingsRoute = {
  page: SettingsPage;
  /** Screen within `page`, or `null` for the page's hub. */
  sub: string | null;
};

/** Whether `sub` names a screen that `page` actually has. */
export function isSettingsSub(page: SettingsPage, sub: string): boolean {
  return page === "ai" && isAiProviderSub(sub);
}

/**
 * Pure parser. Extracted so it's trivially testable without a DOM —
 * the hook just wraps this + a `hashchange` listener.
 */
export function routeFromHash(hash: string): SettingsRoute {
  const stripped = hash.replace(/^#/, "");
  const params = new URLSearchParams(stripped);
  const raw = params.get("page");
  const page =
    raw !== null && SETTINGS_PAGE_IDS.has(raw as SettingsPage)
      ? (raw as SettingsPage)
      : DEFAULT_PAGE;
  const sub = params.get("sub");
  return { page, sub: sub !== null && isSettingsSub(page, sub) ? sub : null };
}

export function pageFromHash(hash: string): SettingsPage {
  return routeFromHash(hash).page;
}

export function useActiveRoute(): SettingsRoute {
  const [route, setRoute] = useState<SettingsRoute>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const onHashChange = (): void => {
      const next = routeFromHash(window.location.hash);
      // Keep the same object when nothing moved so consumers keyed on the
      // route don't re-run for an unrelated hash write.
      setRoute((prev) => (prev.page === next.page && prev.sub === next.sub ? prev : next));
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
  return route;
}

/** Replace the route on the hash, preserving `stage=settings`. Sidebar nav
 *  buttons call this; `hashchange` then propagates the change back through
 *  `useActiveRoute`. Omitting `sub` lands on the page's hub — which is also
 *  what a main-process `settings:open { page }` deep link does. */
export function setActivePage(page: SettingsPage, sub?: string): void {
  window.location.hash =
    sub === undefined
      ? `stage=settings&page=${page}`
      : `stage=settings&page=${page}&sub=${encodeURIComponent(sub)}`;
}
