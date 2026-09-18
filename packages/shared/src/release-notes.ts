// Where a version's release notes live, and the one place that composes
// the URL.
//
// PwrSnap publishes every build as a GitHub Release, and the notes for a
// version are on that release's page. Nothing in the app could reach them
// before this module: Settings -> About opens the CHANGELOG that shipped
// INSIDE the running build, which by construction says nothing about the
// version being offered to you — a v1.1.0 install cannot carry v1.1.1's
// notes. So every surface that names a version also needs a way out to the
// published page, and they all compose it here so they cannot disagree.
//
// The URL is DERIVED from the version rather than read from the feed, even
// though `AppUpdateReleaseInfo.url` carries GitHub's own `html_url` for the
// four published slots. Two reasons:
//
//   - The status surfaces have no feed record to read. `AppUpdateStatus`
//     carries a bare version through checking/available/downloading/
//     downloaded/canceled/install-failed, and plumbing a URL onto every one
//     of those transitions — including the ones electron-updater raises,
//     which never saw our GitHub read — is a lot of wire for a string that
//     is a pure function of the version.
//   - `html_url` is remote data. It is inside the org today, and
//     `app:openExternal`'s allowlist would refuse anything that wasn't, but
//     a URL we compose from a version we already trust needs no such
//     argument.
//
// Deriving is exact because the release tag IS `v` + the version: every tag
// this repo has ever published matches, `apps/desktop/scripts/release.mjs`
// makes them, and `configureAutoUpdaterFeedForRelease` in
// main/auto-updater.ts already builds its asset URL on the same assumption.

/** PwrSnap's public source repository. */
export const PWRSNAP_REPO_URL = "https://github.com/pwrdrvr/PwrSnap";

/** Every published build, newest first — the fallback when a specific
 *  version cannot be resolved into a tag. */
export const PWRSNAP_RELEASES_URL = `${PWRSNAP_REPO_URL}/releases`;

/** Tag shape the release lane publishes: `1.2.3`, `1.2.3-beta.4`, with an
 *  optional `+build` suffix. Only ever used with `.test()`, so every group is
 *  non-capturing — the anchors and the character classes are the whole point,
 *  and they are what stop a version carrying a path separator, a scheme or a
 *  query from reaching the template below. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The GitHub release page for one version, or `undefined` when the version
 * is not one this repo could have tagged.
 *
 * Accepts a bare version (`1.1.1`, as `AppUpdateStatus` carries it) or a tag
 * (`v1.1.1`, as `AppUpdateReleaseInfo.version` carries it — that field holds
 * GitHub's `tag_name` verbatim), so a caller never has to know which side of
 * that seam its string came from.
 *
 * Returning `undefined` rather than a best-effort URL is the point: a link
 * that isn't there is a smaller failure than one that lands on a 404, and it
 * is the only honest answer for a development build whose version is not a
 * published release at all (`0.0.0`, a dirty local build, an E2E override).
 */
export function releaseNotesUrl(version: string | undefined | null): string | undefined {
  if (typeof version !== "string") return undefined;
  const tag = version.trim().replace(/^v/i, "");
  if (!SEMVER.test(tag)) return undefined;
  // Everything SEMVER admits is already URL-safe except `+`, which has to be
  // escaped or GitHub reads it as a space.
  return `${PWRSNAP_REPO_URL}/releases/tag/v${encodeURIComponent(tag)}`;
}
