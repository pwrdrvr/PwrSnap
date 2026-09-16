// The two halves of the release-notes link have to agree, and they live in
// different packages: `releaseNotesUrl` (packages/shared) composes the URL,
// and `isAllowedExternalUrl` (this folder's app-handlers) decides whether
// the process that owns `shell.openExternal` will open it. A shared-package
// test can only re-state the allowlist rule; this one runs it.
//
// The composer is deliberately narrow — anchored semver, one path template —
// so the interesting case is not "does a good URL pass" alone but "can the
// composer be made to produce one that shouldn't".
import { afterEach, describe, expect, test, vi } from "vitest";
import { releaseNotesUrl, PWRSNAP_RELEASES_URL, PWRSNAP_REPO_URL } from "@pwrsnap/shared";

const openExternal = vi.fn(async () => undefined);

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

registerAppCommonHandlers();

async function open(url: string): Promise<boolean> {
  const result = await bus.dispatch("app:openExternal", { url }, { principal: "ipc" });
  return result.ok;
}

afterEach(() => {
  openExternal.mockClear();
});

describe("app:openExternal accepts what releaseNotesUrl composes", () => {
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
  });
});
