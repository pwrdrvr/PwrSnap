import { describe, expect, it } from "vitest";
import { PWRSNAP_RELEASES_URL, PWRSNAP_REPO_URL, releaseNotesUrl } from "../release-notes";

describe("releaseNotesUrl", () => {
  it("builds the tag page for a bare version, as AppUpdateStatus carries it", () => {
    expect(releaseNotesUrl("1.1.1")).toBe("https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.1");
  });

  it("builds the same page for a tag, as AppUpdateReleaseInfo carries it", () => {
    // `AppUpdateReleaseInfo.version` is GitHub's `tag_name` verbatim, so the
    // two sides of that seam must not need different call sites.
    expect(releaseNotesUrl("v1.1.1")).toBe(releaseNotesUrl("1.1.1"));
    expect(releaseNotesUrl("V1.1.1")).toBe(releaseNotesUrl("1.1.1"));
  });

  it("keeps prerelease identifiers, which is most of what this repo publishes", () => {
    expect(releaseNotesUrl("v1.1.0-beta.5")).toBe(
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.0-beta.5"
    );
    expect(releaseNotesUrl("1.1.0-alpha.11")).toBe(
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.0-alpha.11"
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(releaseNotesUrl("  1.1.1  ")).toBe(releaseNotesUrl("1.1.1"));
  });

  it("escapes build metadata rather than letting `+` read as a space", () => {
    expect(releaseNotesUrl("1.1.1+build.3")).toBe(
      "https://github.com/pwrdrvr/PwrSnap/releases/tag/v1.1.1%2Bbuild.3"
    );
  });

  it("answers undefined for anything this repo could not have tagged", () => {
    // No link beats a link onto a 404 — and a dev build's version is not a
    // published release at all.
    for (const version of [
      undefined,
      null,
      "",
      "   ",
      "latest",
      "1.1",
      "1.1.1.1",
      "1.1.x",
      "next"
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("refuses a version that would escape the tag path", () => {
    // The regex is anchored precisely so a crafted version cannot compose a
    // URL that leaves `/pwrdrvr/PwrSnap/releases/tag/`.
    for (const version of [
      "1.1.1/../../../evil",
      "1.1.1?x=1",
      "1.1.1#frag",
      "https://evil.example/1.1.1",
      "1.1.1 1.1.2"
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("composes URLs `app:openExternal` will accept", () => {
    // Mirrors `isAllowedExternalUrl` in main/handlers/app-handlers.ts: https,
    // host github.com, path under `/pwrdrvr/`. A link the bus refuses is a
    // dead link, and nothing else in the app would notice.
    for (const url of [
      PWRSNAP_REPO_URL,
      PWRSNAP_RELEASES_URL,
      releaseNotesUrl("1.1.1"),
      releaseNotesUrl("v1.1.0-beta.5")
    ]) {
      expect(url).toBeDefined();
      expect(url?.startsWith("https://github.com/pwrdrvr/")).toBe(true);
    }
  });
});
