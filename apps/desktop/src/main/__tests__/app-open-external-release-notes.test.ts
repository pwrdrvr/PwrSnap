// The two halves of the release-notes link have to agree, and they live in
// different packages: `releaseNotesUrl` (packages/shared) composes the URL,
// and `isAllowedExternalUrl` (main/external-url-allowlist.ts) decides
// whether the process that owns `shell.openExternal` will open it. A
// shared-package test can only re-state the allowlist rule; this one runs
// it — through BOTH consumers of that predicate, because the control is an
// `<a href>` and therefore has two ways out of the renderer:
//
//   - a plain click, which `onClick` cancels and routes through the
//     `app:openExternal` verb;
//   - a middle-click or cmd-click, which `onClick` never sees at all —
//     Chromium turns it into a `window.open` that only the navigation guard
//     is there to answer.
//
// A URL the verb opens and the guard blocks would be a control that works
// on one input and silently does nothing on the other.
//
// The composer is deliberately narrow — anchored semver, one path template —
// so the interesting case is not "does a good URL pass" alone but "can the
// composer be made to produce one that shouldn't".
import { afterEach, describe, expect, test, vi } from "vitest";
import { releaseNotesUrl, PWRSNAP_RELEASES_URL, PWRSNAP_REPO_URL } from "@pwrsnap/shared";

const openExternal = vi.fn(async (_url: string): Promise<void> => undefined);

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getVersion: () => "1.1.0",
    getPath: () => "",
    isPackaged: false
  } as unknown as typeof import("electron").app,
  screen: {
    getPrimaryDisplay: () => ({ id: 1 }),
    getAllDisplays: () => []
  } as unknown as typeof import("electron").screen,
  shell: {
    openExternal: (url: string) => openExternal(url)
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
}));

// The updater module reaches for electron-updater and the network at import
// time; none of that is this file's subject.
vi.mock("../auto-updater", () => ({
  cancelAppUpdateDownload: vi.fn(),
  checkForAppUpdatesNow: vi.fn(),
  installDownloadedAppUpdate: vi.fn(),
  isUserUpdateCheckRunning: vi.fn(() => false),
  readAppUpdateReleaseVersions: vi.fn(),
  readAppUpdateStatus: vi.fn(),
  runMenuUpdateCheck: vi.fn()
}));

const { bus } = await import("../command-bus");
const { registerAppCommonHandlers } = await import("../handlers/app-handlers");
const { decideNavigation } = await import("../navigation-guard");

registerAppCommonHandlers();

async function open(url: string): Promise<boolean> {
  const result = await bus.dispatch("app:openExternal", { url }, { principal: "ipc" });
  return result.ok;
}

/** What the navigation guard does with a `window.open` for `url` — the path
 *  a cmd-click takes, which never reaches `onClick`. `allowSameApp: false`
 *  is how `setWindowOpenHandler` calls it: PwrSnap opens no windows of its
 *  own this way, so nothing is "same app" here. */
function modifierClick(url: string): ReturnType<typeof decideNavigation> {
  return decideNavigation(
    url,
    { rendererEntryPath: "/app/out/renderer/index.html", devServerUrl: undefined, currentUrl: "" },
    { allowSameApp: false }
  );
}

afterEach(() => {
  openExternal.mockClear();
});

describe("both gates accept what releaseNotesUrl composes", () => {
  test.each([
    ["a stable tag", "1.1.1"],
    ["a tag carrying the leading v", "v1.1.0"],
    ["a prerelease tag", "1.1.0-beta.5"],
    ["an alpha tag", "v1.1.0-alpha.11"],
    ["build metadata, which escapes to %2B", "1.1.1+build.3"]
  ])("opens the release page for %s", async (_label, version) => {
    const url = releaseNotesUrl(version);
    expect(url).toBeDefined();
    expect(await open(url as string)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(url);
    // Same URL, other input: the guard hands it to the browser rather than
    // blocking it or letting it navigate a BrowserWindow.
    expect(modifierClick(url as string)).toEqual({ action: "external", url });
  });

  test("opens the two constants the About page falls back to", async () => {
    for (const url of [PWRSNAP_REPO_URL, PWRSNAP_RELEASES_URL]) {
      expect(await open(url)).toBe(true);
    }
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  test("still refuses a GitHub URL outside the org", async () => {
    // Positive control on the allowlist itself. Without it the cases above
    // would pass just as happily against a handler that opened anything.
    expect(await open("https://github.com/someone-else/PwrSnap/releases")).toBe(false);
    expect(await open("http://github.com/pwrdrvr/PwrSnap/releases")).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();

    // And the other input refuses them too, so the anchor cannot become the
    // way around the verb that the guard was added to close.
    expect(modifierClick("https://github.com/someone-else/PwrSnap/releases")).toEqual({
      action: "block"
    });
    expect(modifierClick("http://github.com/pwrdrvr/PwrSnap/releases")).toEqual({
      action: "block"
    });
  });
});
