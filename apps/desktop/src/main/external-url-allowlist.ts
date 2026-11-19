// The one allowlist deciding which URLs PwrSnap will hand to the user's
// browser.
//
// It has two consumers and they must not drift, which is why this is a
// module of its own rather than an export of either one:
//
//   - `app:openExternal` (handlers/app-handlers.ts) — the verb the
//     renderer calls deliberately, e.g. the About page's link rows.
//   - the navigation guard (navigation-guard.ts) — the backstop for a
//     `window.open` or a top-level navigation that never asked.
//
// The guard cannot import the handler module: that pulls the command
// bus, the window factory and electron-updater into a file whose whole
// job is one string predicate, and into every test of it.

import { APPLE_FM_LINK_URLS } from "@pwrsnap/shared";
import { CHATGPT_PLAN_HELP_URL, CHATGPT_USAGE_URL } from "@pwrsnap/shared";

/** Links the Sign in with ChatGPT surfaces open, compared whole. */
const CHATGPT_URLS: ReadonlySet<string> = new Set([CHATGPT_USAGE_URL, CHATGPT_PLAN_HELP_URL]);

/** Only product, approved provider help, and scoped repository URLs may open externally. */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "pwrsnap.com" || host.endsWith(".pwrsnap.com")) return true;
  // Apple's own pages on the on-device model, linked from Settings → AI
  // Providers → Apple Intelligence. Exact URLs only: neither Apple host is
  // opened for anything else.
  if (APPLE_FM_LINK_URLS.includes(raw)) return true;
  // Sign in with ChatGPT: OpenAI's UI guidelines require "Manage usage" to
  // open ChatGPT's usage settings, plus the plan help article. Exact URLs
  // only, the same shape as the Codex release index below.
  if (CHATGPT_URLS.has(url.href)) return true;
  if (host === "github.com") {
    // Codex upgrade help links to this one upstream release index only.
    if (url.pathname === "/openai/codex/releases" && !url.search && !url.hash) return true;
    // `/pwrdrvr` (org page) or `/pwrdrvr/<repo>...`; reject `/pwrdrvrx`.
    return url.pathname === "/pwrdrvr" || url.pathname.startsWith("/pwrdrvr/");
  }
  return false;
}
