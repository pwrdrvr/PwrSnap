// Child rows under an expandable Settings sidebar group, and the title-bar
// crumb for them. Two kinds, ported from PwrAgnt's settings nav:
//
//   - AI Providers: one SCREEN per provider, each carrying a status (dot +
//     chip) so the operator can read what is installed and configured
//     without opening anything.
//   - AI Features: one SECTION per card. A section sub keeps the page
//     rendered and scrolls it to that card — a "jump to" link, like
//     PwrAgnt's Messaging → Routes. Sections have no status of their own.
//
// Which pages expand is not decided here: it is exactly the pages that own
// subs in `SETTINGS_PAGE_SUBS` (@pwrsnap/shared), the same allowlist main
// validates `settings:open` deep links against.

import {
  SETTINGS_PAGE_SUBS,
  type AiFeaturesSettingsSub,
  type SettingsPage
} from "@pwrsnap/shared";
import type { AiProviderStatus } from "./ai-provider-status";

export type SettingsNavChild = {
  sub: string;
  label: string;
  /** Set on a provider screen; absent on a jump-to section. */
  status?: AiProviderStatus;
};

/** Pages whose sidebar row expands into child rows. */
export const SETTINGS_NAV_GROUPS: ReadonlySet<SettingsPage> = new Set(
  Object.keys(SETTINGS_PAGE_SUBS) as SettingsPage[]
);

/** Sidebar label for each AI Features section. The page titles its cards
 *  from this too, so a jump link always names the card it lands on. */
export const AI_FEATURE_SECTION_LABELS: Readonly<Record<AiFeaturesSettingsSub, string>> = {
  "default-agents": "Default agents",
  enrichment: "Enrichment",
  usage: "Usage",
  guidance: "Guidance"
};

/** DOM id of the element a section sub scrolls to. */
export function settingsSectionId(page: SettingsPage, sub: string): string {
  return `pss-section-${page}-${sub}`;
}

/** The child rows for `page`, in the order the page reads. */
export function settingsNavChildren(
  page: SettingsPage,
  providerStatuses: readonly AiProviderStatus[]
): readonly SettingsNavChild[] {
  switch (page) {
    case "ai":
      return providerStatuses.map((status) => ({
        sub: status.sub,
        label: status.label,
        status
      }));
    case "ai-features":
      return SETTINGS_PAGE_SUBS["ai-features"].map((sub) => ({
        sub,
        label: AI_FEATURE_SECTION_LABELS[sub]
      }));
    default:
      return [];
  }
}

/** Pages whose subs are SECTIONS of one scrolling page, not separate
 *  screens. A section sub scrolls its card into view (see `Card`'s
 *  `focusRequest`); a screen sub replaces the page's content. */
export const SETTINGS_SECTION_PAGES: ReadonlySet<SettingsPage> = new Set<SettingsPage>([
  "ai-features"
]);

export type PaneRoute = { page: SettingsPage; sub: string | null; request: number };

/**
 * What the Settings pane's own scroll does when the route moves from
 * `prev` to `next`:
 *
 * - `"top"`: a different page, or a different provider SCREEN, replaces the
 *   content, so it starts at the top.
 * - `"none"`: a SECTION positions the pane itself — its card scrolls into
 *   view from wherever the pane already is. Resetting to the top first is
 *   what made every jump link leap to the top and then scroll all the way
 *   back down.
 * - `"travel-top"`: back to a section page's top (its sidebar parent row)
 *   from further down the same page travels up rather than cutting there.
 */
export function paneScrollForRoute(
  prev: PaneRoute,
  next: PaneRoute
): "top" | "none" | "travel-top" {
  const sectionPage = SETTINGS_SECTION_PAGES.has(next.page);
  if (sectionPage && next.sub !== null) return "none";
  if (sectionPage && prev.page === next.page) {
    // Same page, now at its top: from a section, or a re-click of the
    // parent row while scrolled down (only the request moved).
    return prev.sub !== null || prev.request !== next.request ? "travel-top" : "none";
  }
  if (prev.page === next.page && prev.sub === next.sub) return "none";
  return "top";
}

/** Smooth, unless the operator asked the OS for reduced motion. */
export function settingsScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    ? "auto"
    : "smooth";
}
