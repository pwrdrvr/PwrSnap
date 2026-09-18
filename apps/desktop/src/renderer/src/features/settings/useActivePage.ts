// Tiny hook that reads the current Settings route from the URL hash
// (`#stage=settings&page=<id>[&sub=<id>]`). Defaults to "general" (the
// first sidebar item) when the page param is missing or invalid. Re-renders
// on `hashchange` so deep-link navigation updates the visible page
// without a full reload.
//
// `sub` is a place WITHIN a page, reached from the sidebar's child rows:
// a provider screen on AI Providers, or a section AI Features scrolls to.
// It is validated against the page's own sub-id set (`SETTINGS_PAGE_SUBS`
// in @pwrsnap/shared — the same list main checks `settings:open` against);
// an unknown or misplaced sub drops to the page's hub rather than rendering
// a blank screen.
//
// Two navigation drivers feed this hook:
//   1. In-renderer sidebar clicks → `setActivePage` (below) sets the
//      hash; the browser fires `hashchange`; the hook re-reads.
//   2. Main → renderer deep-link via `settings:open { page, sub? }`
//      against an already-focused window → main broadcasts the typed
//      `EVENT_CHANNELS.settingsNavigate` event; this hook calls
//      `setActivePage` on receipt. (Previously main interpolated the
//      page id into a `webContents.executeJavaScript` string literal
//      — replaced for transport-safety; see ipc.ts.)

import { useEffect, useState } from "react";
import { EVENT_CHANNELS, isSettingsSub } from "@pwrsnap/shared";
import type { SettingsNavigateEvent, SettingsPage } from "@pwrsnap/shared";
import { subscribe } from "../../lib/pwrsnap";
import { SETTINGS_PAGE_IDS } from "./settings-categories";

const DEFAULT_PAGE: SettingsPage = "general";

export type SettingsRoute = {
  page: SettingsPage;
  /** Screen within `page`, or `null` for the page's hub. */
  sub: string | null;
};

export type ActiveSettingsRoute = SettingsRoute & {
  /** Bumps on every navigation request, INCLUDING a request for the route
   *  already shown (a re-click of the current sidebar row). A section sub
   *  keys its scroll on this, so clicking "Usage" again after scrolling
   *  away brings the card back. */
  request: number;
};

/** Fired by `setActivePage` when asked for the route already on the hash:
 *  assigning an unchanged hash fires no `hashchange`. */
const ROUTE_REREQUEST_EVENT = "pss:settings-route-rerequest";

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
  return { page, sub: isSettingsSub(page, sub) ? sub : null };
}

export function useActiveRoute(): ActiveSettingsRoute {
  const [route, setRoute] = useState<ActiveSettingsRoute>(() => ({
    ...routeFromHash(window.location.hash),
    request: 0
  }));
  useEffect(() => {
    const onHashChange = (): void => {
      const next = routeFromHash(window.location.hash);
      // Keep the same object when nothing moved so consumers keyed on the
      // route don't re-run for an unrelated hash write.
      setRoute((prev) =>
        prev.page === next.page && prev.sub === next.sub
          ? prev
          : { ...next, request: prev.request + 1 }
      );
    };
    const onRerequest = (): void => {
      setRoute((prev) => ({ ...prev, request: prev.request + 1 }));
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(ROUTE_REREQUEST_EVENT, onRerequest);
    const unsubscribe = subscribe(
      EVENT_CHANNELS.settingsNavigate,
      (payload: unknown) => {
        // Main re-validates page-id against SETTINGS_PAGES at the bus
        // boundary, but be defensive — only honor known ids. The
        // `hashchange` listener picks up the resulting hash flip and
        // re-renders.
        //
        // A `sub` main did not validate for this page is dropped here too,
        // landing on the hub — a navigation is never refused over it.
        const navigate = payload as SettingsNavigateEvent;
        if (
          typeof navigate === "object" &&
          navigate !== null &&
          SETTINGS_PAGE_IDS.has(navigate.page)
        ) {
          setActivePage(
            navigate.page,
            isSettingsSub(navigate.page, navigate.sub) ? navigate.sub : undefined
          );
        }
      }
    );
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(ROUTE_REREQUEST_EVENT, onRerequest);
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
  const hash =
    sub === undefined
      ? `stage=settings&page=${page}`
      : `stage=settings&page=${page}&sub=${encodeURIComponent(sub)}`;
  // Already there: still a request (a re-click re-scrolls a section), but
  // `hashchange` would drop it — as it drops any rewrite that moves neither
  // page nor sub. Compare ROUTES, not strings, so a hash spelling the same
  // route differently cannot swallow the request.
  const current = routeFromHash(window.location.hash);
  const next = routeFromHash(`#${hash}`);
  if (current.page === next.page && current.sub === next.sub) {
    window.dispatchEvent(new Event(ROUTE_REREQUEST_EVENT));
    return;
  }
  window.location.hash = hash;
}
