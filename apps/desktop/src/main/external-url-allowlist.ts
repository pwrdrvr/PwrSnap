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

/** URLs PwrSnap is allowed to open in the user's default browser. Keeps
 *  `shell.openExternal` from becoming an arbitrary-navigation gadget: a
 *  compromised/buggy renderer can only reach the product site, the docs
 *  site, and PwrDrvr's own GitHub org. https-only. GitHub is scoped to
 *  the `/pwrdrvr/*` path so an attacker can't bounce the user to an
 *  arbitrary repo/gist/profile under the (trusted) github.com host. */
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
  if (host === "github.com") {
    // `/pwrdrvr` (org page) or `/pwrdrvr/<repo>...`; reject `/pwrdrvrx`.
    return url.pathname === "/pwrdrvr" || url.pathname.startsWith("/pwrdrvr/");
  }
  return false;
}
