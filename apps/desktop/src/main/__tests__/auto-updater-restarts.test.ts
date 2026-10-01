import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { UpdateReleaseState } from "../update-release-state";

const mocks = vi.hoisted(() => ({
  userData: "",
  check: vi.fn(),
  version: "1.0.0",
  updater: { on: vi.fn(), setFeedURL: vi.fn(), currentVersion: { version: "1.0.0" } }
}));
vi.mock("electron", () => ({ app: {
  getPath: () => mocks.userData,
  getVersion: () => mocks.version
} }));
vi.mock("electron-updater", () => ({ default: { autoUpdater: {
  ...mocks.updater, checkForUpdates: mocks.check
} } }));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock("../events", () => ({ broadcastRendererEventToLocalWindows: vi.fn() }));
vi.mock("../process-split/event-relay", () => ({ relayRendererEventToPeer: vi.fn() }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 8, 30);
const latestURL = "https://api.github.com/repos/pwrdrvr/PwrSnap/releases/latest";
const pageURL = "https://api.github.com/repos/pwrdrvr/PwrSnap/releases?per_page=100&page=1";
const release = {
  tag_name: "v1.0.0", draft: false, prerelease: false,
  assets: [
    { name: "latest-mac.yml", state: "uploaded" },
    { name: "PwrSnap-1.0.0-universal-mac.zip", state: "uploaded" },
    { name: "latest.yml", state: "uploaded" },
    { name: "PwrSnap-1.0.0-windows-x64-setup.exe", state: "uploaded" }
  ]
};
let updater: typeof import("../auto-updater");
let root: string;
const fetchMock = vi.fn<typeof fetch>();

function serveReleases(): void {
  fetchMock.mockImplementation(async (input) => new Response(
    JSON.stringify(String(input) === latestURL ? release : [release]),
    { headers: { etag: String(input) === latestURL ? '"latest"' : '"page"' } }
  ));
}

async function restart(profile = root): Promise<void> {
  updater?.disposeAutoUpdater();
  vi.resetModules();
  mocks.userData = profile;
  updater = await import("../auto-updater");
  updater.setUpdateSelectionResolver(() => ({ train: "stable", channel: "latest" }));
}

async function diskState(): Promise<UpdateReleaseState> {
  return JSON.parse(await readFile(join(mocks.userData, "pwrsnap-update-release-state.json"), "utf8"));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PWRSNAP_E2E", "0");
  vi.stubGlobal("fetch", fetchMock);
  root = await mkdtemp(join(tmpdir(), "pwrsnap-update-restarts-"));
  fetchMock.mockReset();
  mocks.check.mockReset();
  mocks.updater.on.mockClear();
  mocks.updater.currentVersion.version = "1.0.0";
  mocks.version = "1.0.0";
  serveReleases();
  await restart();
});

afterEach(async () => {
  updater.disposeAutoUpdater();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("production release requests across process restarts", () => {
  test.each([
    { name: "a stalled latest lookup", latestDelay: null, pageDelay: 4_000, status: "no-update" },
    { name: "two individually slow requests", latestDelay: 4_000, pageDelay: 4_000, status: "no-update" },
    { name: "a stalled release page", latestDelay: 0, pageDelay: null, status: "error" }
  ])("gives each sequential request its own timeout for $name", async ({ latestDelay, pageDelay, status }) => {
    let firstRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstRequestStarted = resolve; });
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((input, init) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected a bounded request");
      signals.push(signal);
      firstRequestStarted();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const isLatest = String(input) === latestURL;
      const delay = isLatest ? latestDelay : pageDelay;
      const timer = delay === null ? undefined : setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(Response.json(isLatest ? release : [release]));
      }, delay);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    }));

    const check = updater.checkForAppUpdatesNow("manual");
    await started;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await check).status).toBe(status);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([latestURL, pageURL]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(latestDelay === null);
    expect(signals[1]?.aborted).toBe(pageDelay === null);
    expect(vi.getTimerCount()).toBe(0);
  });

  // 221 module-graph re-imports (`vi.resetModules` + `import`). That costs
  // ~0.8s on a Mac and sits at the 5s default on the Windows runner, where it
  // has timed out — and a timed-out loop keeps restarting the updater under
  // the next test, so its 14 neighbours failed with it.
  test("20 cold launches/minute and Settings mounts make zero requests during the new-profile grace period", { timeout: 30_000 }, async () => {
    for (let launch = 0; launch < 200; launch++) {
      await restart();
      await updater.checkForAppUpdatesNow("startup");
      await updater.readAppUpdateReleaseVersions();
      vi.setSystemTime(START + (launch + 1) * 3_000);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
    expect((await diskState()).firstSeenAt).toBe(START);

    await restart();
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([latestURL, pageURL]);
    for (let launch = 0; launch < 20; launch++) {
      vi.setSystemTime(START + 10 * MINUTE + launch * 3_000);
      await restart();
      await updater.checkForAppUpdatesNow("startup");
      await Promise.all(Array.from({ length: 5 }, () => updater.readAppUpdateReleaseVersions()));
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.check).not.toHaveBeenCalled();
    expect((await diskState()).lastAttemptAt).toBe(START + 10 * MINUTE);
    expect((await diskState()).cache?.fetchedAt).toBe(START + 10 * MINUTE);
  });

  test("resident startup schedules its first check at ten minutes, then hourly", async () => {
    updater.initAppUpdater(() => ({ train: "stable", channel: "latest" }));
    await updater.checkForAppUpdatesNow("startup");
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Await the same single-flight operation, including its real disk writes.
    await updater.checkForAppUpdatesNow("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await updater.checkForAppUpdatesNow("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("a resident relaunch keeps the original deadline and a downloaded update does not poll every second", async () => {
    await updater.checkForAppUpdatesNow("startup");
    vi.setSystemTime(START + 5 * MINUTE);
    await restart();
    updater.initAppUpdater(() => ({ train: "stable", channel: "latest" }));
    await updater.checkForAppUpdatesNow("startup");
    const downloaded = mocks.updater.on.mock.calls.find(([event]) => event === "update-downloaded")?.[1] as
      (info: { version: string }) => void;
    downloaded({ version: "1.0.1" });
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBe(START + 10 * MINUTE);
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBe(START + 70 * MINUTE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("schedules from the successful response time so network latency does not skip the next hourly refresh", async () => {
    fetchMock.mockImplementation(async (input) => {
      vi.setSystemTime(Date.now() + 500);
      return Response.json(String(input) === latestURL ? release : [release]);
    });
    await updater.checkForAppUpdatesNow("manual");
    expect((await diskState()).cache?.fetchedAt).toBe(START + 1_000);
    await restart();
    vi.setSystemTime(START + HOUR);
    serveReleases();
    updater.initAppUpdater(() => ({ train: "stable", channel: "latest" }));
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await updater.checkForAppUpdatesNow("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test.each(
    (["stable", "beta"] as const).flatMap((train) =>
      (["latest", "prerelease"] as const).flatMap((channel) =>
        ["0.9.0", "1.0.0"].map((version) => ({ train, channel, version }))
      )
    )
  )("$train/$channel on $version shares the same two release endpoints", async ({ train, channel, version }) => {
    mocks.updater.currentVersion.version = version;
    updater.setUpdateSelectionResolver(() => ({ train, channel }));
    mocks.check.mockResolvedValue({ updateInfo: { version: "1.0.0" } });
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([latestURL, pageURL]);
    // A newer selected version alone starts the generic metadata/download path.
    expect(mocks.check).toHaveBeenCalledTimes(version === "0.9.0" ? 1 : 0);
  });

  test("manual and menu checks bypass the delay and reuse persisted ETags after restart", async () => {
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await restart();
    fetchMock.mockImplementation(async () => new Response(null, { status: 304 }));
    await updater.runMenuUpdateCheck();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ "If-None-Match": '"latest"' });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({ "If-None-Match": '"page"' });
    expect((await diskState()).cache?.releases[0]?.tag_name).toBe("v1.0.0");
  });

  test("a manual check racing a deferred Settings read still checks now", async () => {
    await Promise.all([
      updater.readAppUpdateReleaseVersions(),
      updater.checkForAppUpdatesNow("manual")
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each(["startup", "periodic"] as const)("a manual check racing deferred %s still checks now", async (trigger) => {
    const [, manual] = await Promise.all([
      updater.checkForAppUpdatesNow(trigger),
      updater.checkForAppUpdatesNow("manual")
    ]);
    expect(manual.status).toBe("no-update");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("persists API releases with nullable text without retaining unused payload fields", async () => {
    const nullable = { ...release, name: null, published_at: null, body: "unused release notes" };
    fetchMock.mockImplementation(async (input) => Response.json(String(input) === latestURL ? nullable : [nullable]));
    expect((await updater.checkForAppUpdatesNow("manual")).status).toBe("no-update");
    await restart();
    expect((await updater.readAppUpdateReleaseVersions()).stable.latest.version).toBe("v1.0.0");
    const persisted = (await diskState()).cache?.releases[0];
    expect(persisted).not.toHaveProperty("body");
    expect(persisted).not.toHaveProperty("name");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("the cold pager has a hard ceiling of latest plus ten full pages", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === latestURL) return new Response("missing", { status: 404 });
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return Response.json(Array.from({ length: 100 }, (_, index) => ({
        ...release, tag_name: `v1.1.0-alpha.${page * 100 + index}`, prerelease: true
      })));
    });
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://api.github.com/repos/pwrdrvr/PwrSnap/releases?per_page=100&page=10"
    );
    await restart();
    await updater.checkForAppUpdatesNow("startup");
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  test("a due automatic check revalidates the persisted cache across a version/track change", async () => {
    await updater.checkForAppUpdatesNow("manual");
    await restart();
    updater.setUpdateSelectionResolver(() => ({ train: "beta", channel: "prerelease" }));
    mocks.version = "1.1.0-alpha.1";
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + HOUR);
    fetchMock.mockImplementation(async () => new Response(null, { status: 304 }));
    await updater.checkForAppUpdatesNow("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ "If-None-Match": '"latest"' });
    expect((await diskState()).cache?.fetchedAt).toBe(START + HOUR);
    mocks.version = "1.0.0";
  });

  test("a different profile has its own persisted grace period, even when another profile is mature", async () => {
    await updater.checkForAppUpdatesNow("manual");
    vi.setSystemTime(START + HOUR);
    const other = join(root, "new-profile");
    await restart(other);
    await updater.checkForAppUpdatesNow("startup");
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + HOUR + 9 * MINUTE);
    await restart(other);
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + HOUR + 10 * MINUTE);
    await restart(other);
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test.each([403, 429])("persists %i backoff, stops before the second endpoint, and blocks explicit retries until reset", async (status) => {
    const resetAt = START + 2 * HOUR;
    fetchMock.mockResolvedValue(new Response("limited", { status, headers: {
      "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt / 1_000)
    } }));
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await diskState()).rateLimitResetAt).toBe(resetAt);
    for (let launch = 0; launch < 20; launch++) {
      await restart();
      await updater.checkForAppUpdatesNow("startup");
      await updater.checkForAppUpdatesNow("manual");
      await updater.readAppUpdateReleaseVersions();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(resetAt + 1);
    await restart();
    serveReleases();
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await diskState()).rateLimitResetAt).toBeNull();
  });

  test("honors Retry-After without primary-limit headers across restarts", async () => {
    fetchMock.mockResolvedValue(new Response("secondary limit", { status: 429, headers: { "retry-after": "7200" } }));
    await updater.checkForAppUpdatesNow("manual");
    await restart();
    vi.setSystemTime(START + HOUR);
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await diskState()).rateLimitResetAt).toBe(START + 2 * HOUR);
  });

  test("records admission before sending requests and preserves failed-attempt backoff", async () => {
    const admissions: Array<number | null | undefined> = [];
    fetchMock.mockImplementation(async () => {
      // Assert outside the mock: updater error handling intentionally catches
      // thrown errors, including an assertion thrown inside this function.
      admissions.push(await diskState().then((state) => state.lastAttemptAt, () => undefined));
      throw new Error("offline");
    });
    await updater.checkForAppUpdatesNow("manual");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(admissions).toEqual([START, START]);
    for (let launch = 0; launch < 20; launch++) {
      await restart();
      await updater.checkForAppUpdatesNow("startup");
      await updater.readAppUpdateReleaseVersions();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await diskState()).failures).toBe(1);
    // Repeated failures grow the retry delay beyond the one-hour minimum.
    for (let failure = 2; failure <= 4; failure++) {
      vi.setSystemTime(START + (failure - 1) * HOUR);
      await restart();
      await updater.checkForAppUpdatesNow("periodic");
    }
    expect((await diskState()).retryAt).toBe(START + 5 * HOUR);
    vi.setSystemTime(START + 4 * HOUR);
    await restart();
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  test("corrupt state starts a grace period and inaccessible state fails closed", async () => {
    await writeFile(join(root, "pwrsnap-update-release-state.json"), "{broken");
    await updater.checkForAppUpdatesNow("startup");
    expect(fetchMock).not.toHaveBeenCalled();
    const invalidDirectory = join(root, "file");
    await writeFile(invalidDirectory, "not a directory");
    await restart(invalidDirectory);
    expect((await updater.checkForAppUpdatesNow("manual")).status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("E2E returns before storage or network, including manual/menu and release reads", async () => {
    vi.stubEnv("PWRSNAP_E2E", "1");
    mocks.userData = ""; // Would throw if the persistence seam were reached.
    updater.initAppUpdater(() => ({ train: "stable", channel: "latest" }));
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    await updater.checkForAppUpdatesNow("startup");
    await updater.checkForAppUpdatesNow("manual");
    await updater.runMenuUpdateCheck();
    await updater.readAppUpdateReleaseVersions();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.check).not.toHaveBeenCalled();
  });
});
