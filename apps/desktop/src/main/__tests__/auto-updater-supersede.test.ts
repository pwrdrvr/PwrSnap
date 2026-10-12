// A newer release published while an older update sits downloaded.
//
// Before this, a downloaded update ended every later check, so the user had
// to restart into the older build only to be offered the newer one straight
// away. These pin that the newer release replaces it, and what each platform
// can still install while that happens (see `supersedingDownload` in
// auto-updater.ts).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
  function emitter() {
    const handlers = new Map<string, Set<Handler>>();
    const add = (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    };
    return {
      handlers,
      on: (event: string, handler: Handler) => add(event, handler),
      once: (event: string, handler: Handler) => {
        const wrapped: Handler = (...args) => {
          handlers.get(event)?.delete(wrapped);
          handler(...args);
        };
        (wrapped as { original?: Handler }).original = handler;
        add(event, wrapped);
      },
      removeListener: (event: string, handler: Handler) => {
        for (const h of handlers.get(event) ?? []) {
          if (h === handler || (h as { original?: Handler }).original === handler) {
            handlers.get(event)?.delete(h);
          }
        }
      },
      emit: (event: string, ...args: unknown[]) => {
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      },
      count: (event: string) => handlers.get(event)?.size ?? 0
    };
  }
  const updaterEvents = emitter();
  return {
    updaterEvents,
    native: emitter(),
    broadcast: vi.fn(),
    installAttempt: undefined as undefined | Record<string, unknown>,
    autoUpdater: {
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(),
      currentVersion: { version: "1.0.0" },
      logger: undefined as unknown,
      on: (event: string, handler: Handler) => {
        updaterEvents.on(event, handler);
        return mocks.autoUpdater;
      },
      quitAndInstall: vi.fn(),
      setFeedURL: vi.fn()
    }
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => mocks.autoUpdater.currentVersion.version,
    getPath: () => ""
  },
  autoUpdater: mocks.native
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: mocks.autoUpdater } }));
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
vi.mock("../update-install-attempt-store", () => ({
  createAppUpdateInstallAttemptStore: () => ({
    clear: () => undefined,
    filePath: () => "",
    read: () => mocks.installAttempt,
    write: (attempt: object) => ({ schemaVersion: 1, ...attempt })
  })
}));
vi.mock("../mac-shipit-diagnostics", () => ({ readMacShipItDiagnostics: () => undefined }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));
vi.mock("../events", () => ({ broadcastRendererEventToLocalWindows: mocks.broadcast }));
vi.mock("../process-split/event-relay", () => ({ relayRendererEventToPeer: vi.fn() }));

const fetchMock = vi.fn();
const originalPlatform = process.platform;
const originalNodeEnv = process.env.NODE_ENV;
const originalFetch = globalThis.fetch;

function feed(version: string): void {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => [{
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: [
        { name: "latest-mac.yml", state: "uploaded" },
        { name: `PwrSnap-${version}-universal-mac.zip`, state: "uploaded" },
        { name: "latest.yml", state: "uploaded" },
        { name: `PwrSnap-${version}-windows-x64-setup.exe`, state: "uploaded" }
      ]
    }]
  });
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // The updater attaches its own handlers; this one only keeps a rejection
  // the test causes from being reported before they run.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** electron-updater accepting `version` and starting its download. */
function offerDownload(version: string) {
  const download = deferred();
  const token = { cancel: vi.fn() };
  mocks.autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
    mocks.updaterEvents.emit("checking-for-update");
    mocks.updaterEvents.emit("update-available", { version });
    return {
      updateInfo: { version },
      cancellationToken: token,
      downloadPromise: download.promise
    };
  });
  return { download, token };
}

/** Boot with v1.0.1 already downloaded over a running v1.0.0. */
async function bootWithDownloaded() {
  feed("1.0.1");
  const first = offerDownload("1.0.1");
  const updater = await import("../auto-updater");
  updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
  await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1));
  mocks.updaterEvents.emit("update-downloaded", { version: "1.0.1" });
  first.download.resolve([]);
  await vi.waitFor(() => expect(updater.readAppUpdateStatus()).toEqual({
    status: "downloaded", version: "1.0.1"
  }));
  return updater;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
  vi.resetModules();
  process.env.NODE_ENV = "production";
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  mocks.updaterEvents.handlers.clear();
  mocks.native.handlers.clear();
  mocks.broadcast.mockReset();
  mocks.autoUpdater.checkForUpdates.mockReset();
  mocks.autoUpdater.quitAndInstall.mockReset();
  mocks.autoUpdater.autoInstallOnAppQuit = false;
  mocks.autoUpdater.currentVersion = { version: "1.0.0" };
  mocks.installAttempt = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  (await import("../auto-updater")).disposeAutoUpdater();
  setPlatform(originalPlatform);
  process.env.NODE_ENV = originalNodeEnv;
  globalThis.fetch = originalFetch;
});

describe("a newer release replaces a downloaded update", () => {
  test("keeps the downloaded update when the feed has nothing newer", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "1.0.1"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
  });

  test("macOS offers the newer build only once Squirrel.Mac has staged it", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available", version: "1.0.2"
    });
    mocks.updaterEvents.emit("download-progress", { percent: 40, transferred: 40, total: 100 });
    // A Settings mount reads (and reconciles) the status mid-download. It
    // must not put the older offer back over the newer download's progress.
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    // Squirrel still has v1.0.1 staged, so install-on-quit stays armed: it is
    // also what makes MacUpdater ask Squirrel to stage v1.0.2.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);

    // electron-updater has the zip; Squirrel has not fetched it yet, so a
    // Restart here would still install v1.0.1.
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    expect(updater.readAppUpdateStatus()).toMatchObject({ status: "downloading", version: "1.0.2" });
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available", version: "1.0.2"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    mocks.native.emit("update-downloaded");
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
    expect(mocks.native.count("error")).toBe(0);

    await expect(updater.installDownloadedAppUpdate()).resolves.toEqual({ status: "restarting" });
    expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  test("macOS puts the older Restart offer back when the newer download is canceled", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");
    await updater.checkForAppUpdatesNow("manual");
    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    expect(second.token.cancel).toHaveBeenCalledTimes(1);
    mocks.updaterEvents.emit("update-cancelled", { version: "1.0.2" });
    second.download.reject(new Error("cancelled"));

    await vi.waitFor(() => expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded", version: "1.0.1"
    }));
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  test("macOS falls back to the older staged build when Squirrel.Mac fails to stage the newer one", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");
    await updater.checkForAppUpdatesNow("manual");
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);

    mocks.native.emit("error", new Error("signature check failed"));
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
  });

  test("macOS falls back to the older staged build when Squirrel.Mac never confirms the newer one", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");
    await updater.checkForAppUpdatesNow("manual");
    vi.useFakeTimers();
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "available", version: "1.0.2" });
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.1" });
    expect(mocks.native.count("update-downloaded")).toBe(0);
  });

  test("an unreadable held version is kept rather than downloaded again every check", async () => {
    setPlatform("darwin");
    feed("1.0.1");
    const first = offerDownload("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1));
    mocks.updaterEvents.emit("update-downloaded", { version: "build-1.0.1" });
    first.download.resolve([]);

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "build-1.0.1"
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  test("the menu check reports the newer build, not the one it replaced", async () => {
    setPlatform("darwin");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");

    const menu = updater.runMenuUpdateCheck();
    await vi.waitFor(() => expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2));
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    mocks.native.emit("update-downloaded");

    await expect(menu).resolves.toEqual({ status: "downloaded", version: "1.0.2" });
  });

  test("Windows withdraws the older offer once its installer is replaced, and holds install-on-quit", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    feed("1.0.2");
    const second = offerDownload("1.0.2");

    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "available", version: "1.0.2"
    });
    // electron-updater has emptied the pending cache dir, older installer
    // included, while its own `_file` still names it.
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false);
    await expect(updater.installDownloadedAppUpdate()).resolves.toMatchObject({ status: "error" });
    expect(mocks.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.2" });
    second.download.resolve([]);
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.0.2" });
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  test("Windows does not resurrect the deleted older installer when the newer download fails", async () => {
    setPlatform("win32");
    const updater = await bootWithDownloaded();
    feed("1.0.2");
    const second = offerDownload("1.0.2");
    await updater.checkForAppUpdatesNow("manual");
    mocks.updaterEvents.emit("error", new Error("network failed"));
    second.download.reject(new Error("network failed"));

    await vi.waitFor(() => expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true));
    expect(updater.readAppUpdateStatus()).toEqual({ status: "error", message: "network failed" });
    await expect(updater.installDownloadedAppUpdate()).resolves.toMatchObject({ status: "error" });
  });

  test("a downloaded switch-back is not quietly replaced", async () => {
    setPlatform("darwin");
    mocks.autoUpdater.currentVersion = { version: "1.1.0" };
    feed("1.0.1");
    const first = offerDownload("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    // The startup check holds a switch-back for a check the user asks for.
    await vi.waitFor(() => expect(updater.readAppUpdateStatus().status).toBe("no-update"));
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toMatchObject({
      status: "available", version: "1.0.1", downgrade: true
    });
    mocks.updaterEvents.emit("update-downloaded", { version: "1.0.1" });
    first.download.resolve([]);

    feed("1.0.2");
    await expect(updater.checkForAppUpdatesNow("manual")).resolves.toEqual({
      status: "downloaded", version: "1.0.1", downgrade: true
    });
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});

describe("an install that lands past the recorded version", () => {
  function attempt(expectedVersion: string) {
    return {
      schemaVersion: 1, expectedVersion, fromVersion: "1.0.0",
      channel: "latest", train: "stable", attemptedAt: "2026-10-11T00:00:00.000Z"
    };
  }

  // Squirrel.Mac can finish staging the newer build after the older Restart
  // offer was taken. Landing on it is a success, not a failed install whose
  // "retry" would move the user back down.
  test("is not reported as a failed install", async () => {
    setPlatform("darwin");
    feed("1.0.2");
    mocks.autoUpdater.currentVersion = { version: "1.0.2" };
    mocks.installAttempt = attempt("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    await vi.waitFor(() => expect(updater.readAppUpdateStatus().status).toBe("no-update"));
  });

  test("still reports the install that never happened", async () => {
    setPlatform("darwin");
    mocks.installAttempt = attempt("1.0.1");
    const updater = await import("../auto-updater");
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    expect(updater.readAppUpdateStatus()).toMatchObject({
      status: "install-failed", version: "1.0.1", currentVersion: "1.0.0"
    });
  });
});
