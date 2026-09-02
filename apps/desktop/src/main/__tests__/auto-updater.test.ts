import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppUpdateInstallAttempt } from "../update-install-attempt-store";

type UpdateEventHandler = (info?: { version?: string }) => void;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<UpdateEventHandler>>();
  return {
    appPaths: { userData: "", home: "" },
    handlers,
    installAttemptStore: {
      clear: vi.fn(),
      filePath: vi.fn(() => "D:\\pwrsnap-smoke\\user-data\\pwrsnap-update-install-attempt.json"),
      read: vi.fn<() => AppUpdateInstallAttempt | undefined>(),
      write: vi.fn(
        (attempt: Omit<AppUpdateInstallAttempt, "schemaVersion">): AppUpdateInstallAttempt => ({
          schemaVersion: 1,
          ...attempt
        })
      )
    },
    resolveSelection: vi.fn((): { channel: "latest" | "prerelease"; train: "stable" | "beta" } => ({
      channel: "latest",
      train: "stable"
    })),
    autoUpdater: {
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      channel: "latest",
      checkForUpdates: vi.fn(),
      currentVersion: { version: "1.0.0" },
      logger: undefined as unknown,
      on: vi.fn((event: string, handler: UpdateEventHandler) => {
        const eventHandlers = handlers.get(event) ?? new Set();
        eventHandlers.add(handler);
        handlers.set(event, eventHandlers);
        return mocks.autoUpdater;
      }),
      quitAndInstall: vi.fn(),
      requestHeaders: { authorization: "must-be-cleared" } as Record<string, string> | null,
      setFeedURL: vi.fn()
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...(args as [{ version?: string }]));
      }
    }
  };
});

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  app: {
    getVersion: () => mocks.autoUpdater.currentVersion.version,
    getPath: (name: string) => {
      if (name === "userData") return mocks.appPaths.userData;
      if (name === "home") return mocks.appPaths.home;
      return "";
    }
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

vi.mock("../update-install-attempt-store", () => ({
  createAppUpdateInstallAttemptStore: () => mocks.installAttemptStore
}));

vi.mock("../events", () => ({
  broadcastRendererEventToLocalWindows: vi.fn()
}));

vi.mock("../process-split/event-relay", () => ({
  relayRendererEventToPeer: vi.fn()
}));

const fetchMock = vi.fn();

function macUpdateAssets(version: string) {
  return [
    { name: "latest-mac.yml", state: "uploaded" },
    { name: `PwrSnap-${version}-universal-mac.zip`, state: "uploaded" }
  ];
}

function githubRelease(
  tagName: string,
  options: {
    assets?: Array<{ name?: string; state?: string }>;
    draft?: boolean;
    prerelease?: boolean;
  } = {}
) {
  const version = tagName.replace(/^v/i, "");
  return {
    tag_name: tagName,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: options.assets ?? macUpdateAssets(version)
  };
}

function mockGitHubReleases(releases: ReturnType<typeof githubRelease>[]): void {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => releases
  });
}

async function importAutoUpdater() {
  return await import("../auto-updater");
}

describe("compareSemver", () => {
  test("orders by major/minor/patch", async () => {
    const { compareSemver } = await importAutoUpdater();
    expect(compareSemver("v2.0.0", "v1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("v1.2.0", "v1.10.0")).toBeLessThan(0);
    expect(compareSemver("v1.2.3", "v1.2.3")).toBe(0);
  });

  test("treats stable as higher precedence than prerelease at the same core", async () => {
    const { compareSemver } = await importAutoUpdater();
    expect(compareSemver("v1.0.0", "v1.0.0-beta.8")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0-beta.8", "v1.0.0")).toBeLessThan(0);
  });

  test("orders numeric prerelease identifiers numerically, not lexically", async () => {
    const { compareSemver } = await importAutoUpdater();
    expect(compareSemver("v1.0.0-beta.9", "v1.0.0-beta.10")).toBeLessThan(0);
    expect(compareSemver("v1.0.0-beta.2", "v1.0.0-beta.1")).toBeGreaterThan(0);
  });

  test("sorts unparseable tags below valid versions", async () => {
    const { compareSemver } = await importAutoUpdater();
    expect(compareSemver("not-a-version", "v1.0.0-beta.1")).toBeLessThan(0);
    expect(compareSemver("v0.0.1", "garbage")).toBeGreaterThan(0);
  });
});

describe("selectChannelReleases", () => {
  test("classifies main-train alpha and beta without stealing stable latest", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.1.0-beta.2", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1-prerelease.1", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false }
    ]);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1-prerelease.1");
    expect(selected.betaLatest?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-beta.2");
    expect(selected.latest?.tag_name).toBe("v1.0.0");
    expect(selected.prerelease?.tag_name).toBe("v1.0.1-prerelease.1");
  });

  test("keeps legacy 1.0 beta prereleases on the stable prerelease track", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.0.0-beta.41", prerelease: true, draft: false },
      { tag_name: "v1.0.0-beta.8", prerelease: false, draft: false }
    ]);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.0-beta.8");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.0-beta.41");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  test("does not put shipped 1.0.0-beta tags on the Beta train after 1.0.1", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.0.1", prerelease: false, draft: false },
      { tag_name: "v1.0.1-prerelease.5", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.50", prerelease: false, draft: false },
      { tag_name: "v1.0.0-beta.48", prerelease: true, draft: false }
    ]);
    expect(selected.stableLatest?.tag_name).toBe("v1.0.1");
    expect(selected.stablePrerelease?.tag_name).toBe("v1.0.1");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  test("does not advertise leftover same-core betas after that train becomes Latest", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.1", prerelease: false, draft: false }
    ]);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease).toBeUndefined();
  });

  test("keeps a newer main-train alpha on Beta after Stable is promoted", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.1.0", prerelease: false, draft: false },
      { tag_name: "v1.1.0-beta.3", prerelease: true, draft: false },
      { tag_name: "v1.2.0-alpha.1", prerelease: true, draft: false }
    ]);
    expect(selected.stableLatest?.tag_name).toBe("v1.1.0");
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.2.0-alpha.1");
  });

  test("shows an alpha as beta prerelease before a beta exists", async () => {
    const { selectChannelReleases } = await importAutoUpdater();
    const selected = selectChannelReleases([
      { tag_name: "v1.1.0-alpha.7", prerelease: true, draft: false },
      { tag_name: "v1.0.0", prerelease: false, draft: false }
    ]);
    expect(selected.betaLatest).toBeUndefined();
    expect(selected.betaPrerelease?.tag_name).toBe("v1.1.0-alpha.7");
  });
});

describe("auto updater selection", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUpdateSmoke = process.env.PWRSNAP_UPDATE_SMOKE;
  const originalPlatform = process.platform;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin"
    });
    process.env.NODE_ENV = "production";
    delete process.env.PWRSNAP_UPDATE_SMOKE;
    mocks.handlers.clear();
    mocks.autoUpdater.checkForUpdates.mockReset();
    mocks.autoUpdater.quitAndInstall.mockReset();
    mocks.autoUpdater.setFeedURL.mockReset();
    mocks.autoUpdater.on.mockClear();
    mocks.autoUpdater.allowDowngrade = false;
    mocks.autoUpdater.allowPrerelease = false;
    mocks.autoUpdater.autoInstallOnAppQuit = false;
    mocks.autoUpdater.requestHeaders = { authorization: "must-be-cleared" };
    mocks.autoUpdater.currentVersion = { version: "1.0.0" };
    mocks.installAttemptStore.clear.mockReset();
    mocks.installAttemptStore.filePath.mockReset();
    mocks.installAttemptStore.filePath.mockReturnValue(
      "D:\\pwrsnap-smoke\\user-data\\pwrsnap-update-install-attempt.json"
    );
    mocks.installAttemptStore.read.mockReset();
    mocks.installAttemptStore.read.mockReturnValue(undefined);
    mocks.installAttemptStore.write.mockReset();
    mocks.installAttemptStore.write.mockImplementation(
      (attempt: Omit<AppUpdateInstallAttempt, "schemaVersion">): AppUpdateInstallAttempt => ({
        schemaVersion: 1,
        ...attempt
      })
    );
    mocks.resolveSelection.mockReset();
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalUpdateSmoke === undefined) {
      delete process.env.PWRSNAP_UPDATE_SMOKE;
    } else {
      process.env.PWRSNAP_UPDATE_SMOKE = originalUpdateSmoke;
    }
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform
    });
    globalThis.fetch = originalFetch;
    const { disposeAutoUpdater } = await import("../auto-updater");
    disposeAutoUpdater();
    await vi.resetModules();
  });

  test("pins electron-updater to the selected GitHub Release download feed", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "prerelease", train: "stable" });
    mockGitHubReleases([githubRelease("v1.0.1-prerelease.1", { prerelease: true })]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.1-prerelease.1" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.1-prerelease.1"
    });
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.0.1-prerelease.1/"
    });
    expect(mocks.autoUpdater.allowPrerelease).toBe(true);
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);
  });

  test("Windows smoke bypasses GitHub and pins GenericProvider to exact loopback latest.yml", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    mocks.autoUpdater.autoInstallOnAppQuit = true;
    mocks.autoUpdater.currentVersion = { version: "1.1.0-update-smoke.42.1" };
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.1.0-update-smoke.42.2" }
    });
    const updater = await importAutoUpdater();
    updater.setWindowsUpdateSmokeConfig({
      baselineVersion: "1.1.0-update-smoke.42.1",
      currentVersion: "1.1.0-update-smoke.42.1",
      targetVersion: "1.1.0-update-smoke.42.2",
      runId: "gha-42.1",
      feedUrl: "http://127.0.0.1:43123/",
      userDataDir: "D:\\pwrsnap-smoke\\user-data"
    });

    await expect(updater.checkForAppUpdatesNow("startup")).resolves.toEqual({
      status: "available",
      version: "1.1.0-update-smoke.42.2"
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mocks.autoUpdater.allowPrerelease).toBe(true);
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(mocks.autoUpdater.channel).toBe("latest");
    expect(mocks.autoUpdater.requestHeaders).toBeNull();
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "http://127.0.0.1:43123/"
    });
  });

  test("Windows smoke without validated marker/config fails before GitHub or updater access", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    const updater = await importAutoUpdater();

    await expect(updater.checkForAppUpdatesNow("startup")).rejects.toThrow(
      /build marker\/configuration was not validated/
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  test("Windows smoke invalid feed fails before any fetch, feed, or update check", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    mocks.autoUpdater.currentVersion = { version: "1.1.0-update-smoke.42.1" };
    const updater = await importAutoUpdater();
    updater.setWindowsUpdateSmokeConfig({
      baselineVersion: "1.1.0-update-smoke.42.1",
      currentVersion: "1.1.0-update-smoke.42.1",
      targetVersion: "1.1.0-update-smoke.42.2",
      runId: "gha-42.1",
      feedUrl: "https://github.com/pwrdrvr/PwrSnap/releases/",
      userDataDir: "D:\\pwrsnap-smoke\\user-data"
    });

    await expect(updater.checkForAppUpdatesNow("startup")).resolves.toMatchObject({
      status: "error",
      message: expect.stringMatching(/loopback-only runtime guard/)
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test("Windows smoke rejects a feed version mismatch without production fallback", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    mocks.autoUpdater.currentVersion = { version: "1.1.0-update-smoke.42.1" };
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.1.0-update-smoke.42.3" }
    });
    const updater = await importAutoUpdater();
    updater.setWindowsUpdateSmokeConfig({
      baselineVersion: "1.1.0-update-smoke.42.1",
      currentVersion: "1.1.0-update-smoke.42.1",
      targetVersion: "1.1.0-update-smoke.42.2",
      runId: "gha-42.1",
      feedUrl: "http://127.0.0.1:43123/",
      userDataDir: "D:\\pwrsnap-smoke\\user-data"
    });

    await expect(updater.checkForAppUpdatesNow("startup")).resolves.toMatchObject({
      status: "error",
      message: expect.stringMatching(/expected exact target/)
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  });

  test("Windows smoke refuses quitAndInstall when its durable attempt marker cannot be written", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    const baselineVersion = "1.1.0-update-smoke.42.1.1";
    const targetVersion = "1.1.0-update-smoke.42.1.2";
    mocks.autoUpdater.currentVersion = { version: baselineVersion };
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: targetVersion }
    });
    const updater = await importAutoUpdater();
    updater.setWindowsUpdateSmokeConfig({
      baselineVersion,
      currentVersion: baselineVersion,
      targetVersion,
      runId: "gha-42.1",
      feedUrl: "http://127.0.0.1:43123/",
      userDataDir: "D:\\pwrsnap-smoke\\user-data"
    });
    updater.initAppUpdater();
    await expect(updater.checkForAppUpdatesNow("startup")).resolves.toEqual({
      status: "available",
      version: targetVersion
    });
    mocks.emit("update-downloaded", { version: targetVersion });
    mocks.installAttemptStore.write.mockImplementationOnce(() => {
      throw new Error("simulated marker write failure");
    });

    await expect(updater.installDownloadedWindowsUpdateSmoke()).resolves.toEqual({
      status: "error",
      message:
        "Windows updater smoke could not persist its install-attempt marker; refusing to restart."
    });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  test("Windows smoke installs silently and leaves isolated relaunch to the harness", async () => {
    process.env.PWRSNAP_UPDATE_SMOKE = "1";
    const baselineVersion = "1.1.0-update-smoke.42.1.1";
    const targetVersion = "1.1.0-update-smoke.42.1.2";
    mocks.autoUpdater.currentVersion = { version: baselineVersion };
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: targetVersion }
    });
    const updater = await importAutoUpdater();
    updater.setWindowsUpdateSmokeConfig({
      baselineVersion,
      currentVersion: baselineVersion,
      targetVersion,
      runId: "gha-42.1",
      feedUrl: "http://127.0.0.1:43123/",
      userDataDir: "D:\\pwrsnap-smoke\\user-data"
    });
    updater.initAppUpdater();
    await expect(updater.checkForAppUpdatesNow("startup")).resolves.toEqual({
      status: "available",
      version: targetVersion
    });
    mocks.emit("update-downloaded", { version: targetVersion });

    await expect(updater.installDownloadedWindowsUpdateSmoke()).resolves.toEqual({
      status: "restarting"
    });
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, false);
  });

  test("pins the beta train to the smoke-checked main-train tag", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "beta" });
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.1.0-alpha.7", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.1.0-beta.2" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.1.0-beta.2"
    });
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.1.0-beta.2/"
    });
    expect(mocks.autoUpdater.allowPrerelease).toBe(true);
  });

  test("does not ask electron-updater to check a tag-only newer release", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "prerelease", train: "stable" });
    mockGitHubReleases([githubRelease("v1.0.0")]);
    mocks.autoUpdater.currentVersion = { version: "1.0.0" };
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.0"
    });
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test("does not offer a downloaded update after switching trains", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "beta" });
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.1.0-beta.2" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());
    updater.initAppUpdater();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });
    mocks.emit("update-downloaded", { version: "1.1.0-beta.2" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2"
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);

    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    updater.reconcileAppUpdateSelection();

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "no-update",
      version: "1.0.0"
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({
      status: "error",
      message: "The downloaded update is not for the selected channel."
    });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "beta" });
    updater.reconcileAppUpdateSelection();
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.1.0-beta.2"
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  test("still finds Stable Latest after a full first page of newer prereleases", async () => {
    mocks.autoUpdater.currentVersion = { version: "0.9.0" };
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.0" }
    });
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubRelease(`v1.1.0-alpha.${100 - index}`, { prerelease: true })
    );
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return { ok: true, json: async () => githubRelease("v1.0.0") };
      }
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return {
        ok: true,
        json: async () => (page === 1 ? firstPage : [githubRelease("v1.0.0")])
      };
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.0"
    });
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.0.0/"
    });
  });

  test("does not join an in-flight check for a different train or channel", async () => {
    let resolveFirstCheck: ((value: { updateInfo: { version: string } }) => void) | undefined;
    mocks.autoUpdater.checkForUpdates.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirstCheck = resolve;
        })
    );
    mockGitHubReleases([
      githubRelease("v1.1.0-beta.2", { prerelease: true }),
      githubRelease("v1.0.0")
    ]);
    mocks.autoUpdater.currentVersion = { version: "0.9.0" };
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    const first = updater.checkForAppUpdatesNow("startup", {
      train: "stable",
      channel: "latest"
    });
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.1.0-beta.2" }
    });
    const second = updater.checkForAppUpdatesNow("manual", {
      train: "beta",
      channel: "latest"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    resolveFirstCheck?.({ updateInfo: { version: "1.0.0" } });
    await expect(first).resolves.toEqual({ status: "available", version: "1.0.0" });
    await expect(second).resolves.toEqual({ status: "available", version: "1.1.0-beta.2" });
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenLastCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.1.0-beta.2/"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
  // A user pulled onto a newer train than the one they picked — the 1.1
  // alpha that reached 1.0.1 Prerelease installs — resolves Stable Latest
  // to a version BEHIND the running build. Forward-only checks answer
  // "you're up to date" forever and strand them there.
  test("offers the switch back when the selected release is behind the running build", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.1.0-alpha.2" };
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.1")
    ]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.1" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.1",
      downgrade: true
    });
    expect(mocks.autoUpdater.allowDowngrade).toBe(true);
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.0.1/"
    });
  });

  test("keeps background checks quiet about an available downgrade", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.1.0-alpha.2" };
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.1")
    ]);
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("periodic")).resolves.toEqual({
      status: "no-update",
      version: "1.1.0-alpha.2"
    });
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test("leaves the forward path forward-only", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.0.0" };
    mockGitHubReleases([githubRelease("v1.0.1")]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.1" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.1"
    });
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);
  });

  test("marks the downloaded switch so the renderer does not call it an update", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.1.0-alpha.2" };
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.1")
    ]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.1" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());
    updater.initAppUpdater();
    // The startup check is background: it must not have reached
    // electron-updater at all.
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus()).toEqual({
        status: "no-update",
        version: "1.1.0-alpha.2"
      });
    });
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();

    await updater.checkForAppUpdatesNow("manual");
    mocks.emit("update-available", { version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "available",
      version: "1.0.1",
      downgrade: true
    });

    mocks.emit("update-downloaded", { version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.1",
      downgrade: true
    });
    // Stepping backward waits for the explicit Restart. Dismissing the
    // banner hides the notice; it must not leave a silent downgrade armed
    // for the next quit.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  // The version keys come from the release tag; the events carry whatever
  // electron-updater read out of the channel file. If those drift, a
  // version-keyed lookup misses and the downgrade silently re-arms itself
  // for install on quit — it has to fail closed, not open.
  test("marks the switch even when the reported version differs from the tag", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.1.0-alpha.2" };
    mockGitHubReleases([
      githubRelease("v1.1.0-alpha.2", { prerelease: true }),
      githubRelease("v1.0.1")
    ]);
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      mocks.emit("update-available", { version: "1.0.1+win" });
      return { updateInfo: { version: "1.0.1+win" } };
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());
    updater.initAppUpdater();
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus().status).toBe("no-update");
    });

    await updater.checkForAppUpdatesNow("manual");
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "available",
      version: "1.0.1+win",
      downgrade: true
    });

    mocks.emit("update-downloaded", { version: "1.0.1+win" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.1+win",
      downgrade: true
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  test("still arms an ordinary downloaded update for install on quit", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.0.0" };
    mockGitHubReleases([githubRelease("v1.0.1")]);
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.1" }
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());
    updater.initAppUpdater();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    mocks.emit("update-downloaded", { version: "1.0.1" });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: "1.0.1"
    });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  test("ignores a release whose tag does not parse as semver", async () => {
    mocks.resolveSelection.mockReturnValue({ channel: "latest", train: "stable" });
    mocks.autoUpdater.currentVersion = { version: "1.0.1" };
    // Unparseable tags sort below every valid version, so a naive `< 0`
    // would read this as "the selected slot is behind us" and try to
    // install it.
    mockGitHubReleases([githubRelease("latest-build")]);
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "no-update",
      version: "1.0.1"
    });
    expect(mocks.autoUpdater.allowDowngrade).toBe(false);
    expect(mocks.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  test("pages past the first page until the GitHub Latest tag is reached", async () => {
    mocks.autoUpdater.currentVersion = { version: "1.0.0" };
    mocks.resolveSelection.mockReturnValue({ channel: "prerelease", train: "stable" });
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: "1.0.2-prerelease.1" }
    });
    // 100 alphas fill page 1; the Stable Prerelease we must find sits on
    // page 2, ahead of the Latest tag that terminates paging.
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubRelease(`v1.1.0-alpha.${100 - index}`, { prerelease: true })
    );
    const secondPage = [
      githubRelease("v1.0.2-prerelease.1", { prerelease: true }),
      githubRelease("v1.0.1")
    ];
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return { ok: true, json: async () => githubRelease("v1.0.1") };
      }
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return {
        ok: true,
        json: async () => (page === 1 ? firstPage : page === 2 ? secondPage : [])
      };
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => mocks.resolveSelection());

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available",
      version: "1.0.2-prerelease.1"
    });
    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://github.com/pwrdrvr/PwrSnap/releases/download/v1.0.2-prerelease.1/"
    });
  });
});
