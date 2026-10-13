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
    logWarn: vi.fn(),
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

// These behavior suites use a mature profile. Disk/restart/grace-period
// behavior is exercised with the real store in auto-updater-restarts.test.ts.
vi.mock("../update-release-state", async (importOriginal) => ({
  ...await importOriginal<typeof import("../update-release-state")>(),
  createUpdateReleaseStateStore: () => ({
    read: async () => ({
      schemaVersion: 1, firstSeenAt: 0, lastAttemptAt: null,
      retryAt: null, rateLimitResetAt: null, failures: 0, cache: null
    }),
    write: async () => undefined
  })
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

vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: vi.fn() })
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

/** Model fetch/body consumption honoring the request's abort signal. */
function delayedResponse<T>(value: T, signal: AbortSignal, delayMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, delayMs);
    function abort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
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
    mocks.logWarn.mockClear();
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

  test.each(["headers", "body"] as const)("allows slow release %s beyond five seconds", async (phase) => {
    const updater = await importAutoUpdater();
    let pageSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input: string, { signal }: { signal: AbortSignal }) => {
      if (input.includes("/releases/latest")) return githubResponse(githubRelease(STABLE_TAG));
      pageSignal = signal;
      const releases = [githubRelease(STABLE_TAG)];
      return phase === "headers"
        ? delayedResponse(githubResponse(releases), signal, 10_000)
        : { ...githubResponse(releases), json: () => delayedResponse(releases, signal, 10_000) };
    });

    const check = updater.checkForAppUpdatesNow("menu");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(pageSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);

    expect(await check).toEqual({ status: "available", version: STABLE_TAG.slice(1) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    // Finishing the body must dispose the deadline, too.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pageSignal?.aborted).toBe(false);
  });

  test.each(["headers", "body"] as const)("reports a stalled release %s request with its deadline and endpoint", async (phase) => {
    const updater = await importAutoUpdater();
    let pageSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (input: string, { signal }: { signal: AbortSignal }) => {
      if (input.includes("/releases/latest")) return githubResponse(githubRelease(STABLE_TAG));
      pageSignal = signal;
      const releases = [githubRelease(STABLE_TAG)];
      return phase === "headers"
        ? delayedResponse(githubResponse(releases), signal, 120_000)
        : { ...githubResponse(releases), json: () => delayedResponse(releases, signal, 120_000) };
    });

    const check = updater.checkForAppUpdatesNow("menu");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(pageSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = await check;
    expect(result).toEqual({
      status: "error",
      message: "Checking for updates timed out after 60 seconds. Check your connection and try again."
    });
    expect(updater.readAppUpdateStatus()).toEqual(result);
    expect(pageSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith("GitHub release request failed", expect.objectContaining({
      url: "https://api.github.com/repos/pwrdrvr/PwrSnap/releases?per_page=100&page=1",
      elapsedMs: 60_000,
      timeoutMs: 60_000,
      timedOut: true,
      phase,
      status: phase === "body" ? 200 : undefined,
      errorName: "AbortError"
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("keeps the release-list deadline independent of a timed-out optional latest lookup", async () => {
    const updater = await importAutoUpdater();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(async (input: string, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return input.includes("/releases/latest")
        ? delayedResponse(githubResponse(githubRelease(STABLE_TAG)), signal, 120_000)
        : delayedResponse(githubResponse([githubRelease(STABLE_TAG)]), signal, 10_000);
    });

    const versions = updater.readAppUpdateReleaseVersions();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await versions).stable.latest.version).toBe(STABLE_TAG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.logWarn).toHaveBeenCalledWith("GitHub release request failed", expect.objectContaining({
      url: "https://api.github.com/repos/pwrdrvr/PwrSnap/releases/latest",
      timedOut: true
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  test("logs transport causes without misreporting them as request deadlines", async () => {
    const updater = await importAutoUpdater();
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" });
    fetchMock.mockRejectedValue(new TypeError("fetch failed", { cause }));

    const versions = await updater.readAppUpdateReleaseVersions();

    expect(versions.stable.latest.unavailableReason).toBe("fetch failed");
    expect(mocks.logWarn).toHaveBeenCalledWith("GitHub release request failed", expect.objectContaining({
      timedOut: false,
      errorName: "TypeError",
      message: "fetch failed",
      cause: "getaddrinfo ENOTFOUND api.github.com",
      code: "ENOTFOUND"
    }));
    expect(vi.getTimerCount()).toBe(0);
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

    // A manual check bypasses the TTL and reuses the stored ETag.
    // Anonymous 304 responses still count against the quota.
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

    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_CHECK_INTERVAL_MS + 1);
    mockGitHubReleases();
    const recovered = await updater.readAppUpdateReleaseVersions();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileLimited);
    expect(recovered.stable.latest.version).toBe(STABLE_TAG);
  });

  // Losing the `/latest` terminator is expensive: the pager keeps walking
  // until a short page, so a full first page costs RELEASE_MAX_PAGES (10)
  // requests from the budget this cache exists to protect.
  test("falls back to the cached latest tag when /releases/latest fails", async () => {
    const updater = await importAutoUpdater();

    await updater.readAppUpdateReleaseVersions();
    const callsAfterWarmup = fetchMock.mock.calls.length;

    // A full first page, so only the latest tag can stop the walk.
    const fullPage = [
      ...Array.from({ length: 99 }, (_, index) =>
        githubRelease(`v1.1.0-alpha.${99 - index}`, true)
      ),
      githubRelease(STABLE_TAG)
    ];
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return githubResponse({ message: "boom" }, { status: 500 });
      }
      return githubResponse(fullPage, { headers: { etag: 'W/"page1-moved"' } });
    });
    await vi.advanceTimersByTimeAsync(updater.APP_UPDATE_RELEASE_CACHE_TTL_MS + 1);

    const versions = await updater.readAppUpdateReleaseVersions();

    // `/releases/latest` + page 1 only — the cached tag still terminates the
    // walk. Without the fallback this pages to RELEASE_MAX_PAGES.
    expect(fetchMock.mock.calls.length).toBe(callsAfterWarmup + 2);
    expect(versions.stable.latest.version).toBe(STABLE_TAG);
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
