// The GitHub REST API allows 60 anonymous requests per hour per IP, shared
// by every process on the machine, and one release read costs two of them
// (`/releases/latest` plus the first page). These tests pin the main-process
// cache that keeps Settings mounts and manual checks inside that budget, and
// the back-off that keeps a 403 from being reported as an auth failure.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type UpdateEventHandler = (info?: { version?: string }) => void;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<UpdateEventHandler>>();
  return {
    handlers,
    autoUpdater: {
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      currentVersion: { version: "0.9.0" },
      logger: undefined as unknown,
      on: vi.fn((event: string, handler: UpdateEventHandler) => {
        const eventHandlers = handlers.get(event) ?? new Set();
        eventHandlers.add(handler);
        handlers.set(event, eventHandlers);
        return mocks.autoUpdater;
      }),
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn()
    }
  };
});

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getVersion: () => mocks.autoUpdater.currentVersion.version,
    getPath: () => ""
  } as unknown as typeof import("electron").app,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: mocks.autoUpdater
  }
}));

vi.mock("../events", () => ({
  broadcastRendererEventToLocalWindows: vi.fn()
}));

vi.mock("../process-split/event-relay", () => ({
  relayRendererEventToPeer: vi.fn()
}));

const fetchMock = vi.fn();

const STABLE_TAG = "v1.0.0";

function githubRelease(tagName: string, prerelease = false) {
  const version = tagName.replace(/^v/i, "");
  return {
    tag_name: tagName,
    draft: false,
    prerelease,
    assets: [
      { name: "latest-mac.yml", state: "uploaded" },
      { name: `PwrSnap-${version}-universal-mac.zip`, state: "uploaded" }
    ]
  };
}

function githubResponse(
  body: unknown,
  options: { headers?: Record<string, string>; status?: number } = {}
) {
  const status = options.status ?? 200;
  return {
    headers: new Headers(options.headers ?? {}),
    json: async () => body,
    ok: status >= 200 && status < 300,
    status
  };
}

/** Answer both endpoints the release pager reads: `/releases/latest` and the
 *  first (and only, at this size) page of `/releases`. */
function mockGitHubReleases(releases = [githubRelease(STABLE_TAG)]): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return githubResponse(releases.find((release) => !release.prerelease), {
        headers: { etag: 'W/"latest"' }
      });
    }
    return githubResponse(releases, { headers: { etag: 'W/"releases"' } });
  });
}

function mockNotModified(): void {
  fetchMock.mockImplementation(async () => githubResponse(undefined, { status: 304 }));
}

function mockRateLimited(resetAtMs: number): void {
  fetchMock.mockImplementation(async () =>
    githubResponse(
      { message: "API rate limit exceeded" },
      {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(resetAtMs / 1_000))
        },
        status: 403
      }
    )
  );
}

function requestHeader(callIndex: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[callIndex]?.[1] as
    | { headers?: Record<string, string> }
    | undefined;
  return init?.headers?.[name];
}

/** Index of the fetch call for the releases page (as opposed to
 *  `/releases/latest`), which is the one that carries the list etag. */
function pageCallIndex(from = 0): number {
  return fetchMock.mock.calls.findIndex(
    (call, index) => index >= from && !String(call[0]).includes("/releases/latest")
  );
}

async function importAutoUpdater() {
  return await import("../auto-updater");
}

describe("auto updater release cache", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalE2E = process.env.PWRSNAP_E2E;
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin"
    });
    process.env.NODE_ENV = "production";
    delete process.env.PWRSNAP_E2E;
    mocks.handlers.clear();
    mocks.autoUpdater.checkForUpdates.mockReset();
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: STABLE_TAG.slice(1) }
    });
    mocks.autoUpdater.setFeedURL.mockReset();
    mocks.autoUpdater.on.mockClear();
    mocks.autoUpdater.currentVersion = { version: "0.9.0" };
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    mockGitHubReleases();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalE2E === undefined) {
      delete process.env.PWRSNAP_E2E;
    } else {
      process.env.PWRSNAP_E2E = originalE2E;
    }
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform
    });
    globalThis.fetch = originalFetch;
    const { disposeAutoUpdater } = await import("../auto-updater");
    disposeAutoUpdater();
    vi.useRealTimers();
    await vi.resetModules();
  });

  test("serves a repeat release read from the cache without a second request", async () => {
    const updater = await importAutoUpdater();

    const first = await updater.readAppUpdateReleaseVersions();
    // One refresh = `/releases/latest` + one page.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.stable.latest.version).toBe(STABLE_TAG);
  });

  test("shares one refresh between concurrent readers", async () => {
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));

    const [versions, check] = await Promise.all([
      updater.readAppUpdateReleaseVersions(),
      updater.checkForAppUpdatesNow("periodic")
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(versions.stable.latest.version).toBe(STABLE_TAG);
    expect(check.status).not.toBe("error");
  });

  test("refetches once the cache entry expires", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1);
    await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("revalidates a user-initiated check conditionally and keeps the cached list on 304", async () => {
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));

    await updater.readAppUpdateReleaseVersions();
    const callsBefore = fetchMock.mock.calls.length;
    mockNotModified();

    // A manual check bypasses the TTL, but the stored etag makes the
    // revalidation a 304, which GitHub does not charge against the quota.
    const check = await updater.checkForAppUpdatesNow("manual");

    const revalidated = pageCallIndex(callsBefore);
    expect(revalidated).toBeGreaterThanOrEqual(callsBefore);
    expect(requestHeader(revalidated, "If-None-Match")).toBe('W/"releases"');
    expect(check.status).not.toBe("error");

    const versions = await updater.readAppUpdateReleaseVersions();
    expect(versions.stable.latest.version).toBe(STABLE_TAG);
    expect(versions.stable.latest.unavailableReason).toBeUndefined();
  });

  test("reports the rate-limit reset time instead of a bare 403", async () => {
    const updater = await importAutoUpdater();
    mockRateLimited(Date.now() + 30 * 60 * 1_000);

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toMatch(
      /GitHub rate limit reached\. Update checks resume at /
    );
    expect(versions.stable.latest.unavailableReason).not.toMatch(/403/);
  });

  test("stops requesting while rate limited and serves the last good list", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    mockRateLimited(Date.now() + 30 * 60 * 1_000);
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1);

    // One refresh discovers the limit; later reads must not spend another.
    await updater.readAppUpdateReleaseVersions();
    const callsAfterDiscovery = fetchMock.mock.calls.length;
    expect(callsAfterDiscovery).toBeGreaterThan(2);

    const stale = await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterDiscovery);
    expect(stale.stable.latest.version).toBe(STABLE_TAG);
    expect(stale.stable.latest.unavailableReason).toBeUndefined();
  });

  test("resumes requesting after the rate-limit window passes", async () => {
    const updater = await importAutoUpdater();
    mockRateLimited(Date.now() + 30 * 60 * 1_000);

    await updater.readAppUpdateReleaseVersions();
    const callsWhileLimited = fetchMock.mock.calls.length;

    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(callsWhileLimited);

    await vi.advanceTimersByTimeAsync(31 * 60 * 1_000);
    mockGitHubReleases();
    const recovered = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileLimited);
    expect(recovered.stable.latest.version).toBe(STABLE_TAG);
  });

  // E2E launches set NODE_ENV=production, so the production gate is open and
  // these reads would be real network calls. `settings:open` with no page
  // mounts Settings -> General, which reads the release list on mount.
  test("makes no GitHub request under PWRSNAP_E2E", async () => {
    process.env.PWRSNAP_E2E = "1";
    const updater = await importAutoUpdater();

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(versions.stable.latest.version).toBeUndefined();
    expect(versions.stable.latest.unavailableReason).toBe("No stable release found.");
  });

  test("makes no GitHub request for a manual check under PWRSNAP_E2E", async () => {
    process.env.PWRSNAP_E2E = "1";
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));

    const check = await updater.checkForAppUpdatesNow("manual");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(check).toEqual({ status: "no-update", version: "0.9.0" });
  });
});
