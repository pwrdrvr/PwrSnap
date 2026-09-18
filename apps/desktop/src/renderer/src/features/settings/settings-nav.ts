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
