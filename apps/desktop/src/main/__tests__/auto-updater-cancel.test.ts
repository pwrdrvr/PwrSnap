// Stopping an update download, and telling the user a check is running.
//
// Two behaviours that are easy to get subtly wrong and impossible to notice:
//   - A cancel and a network failure produce the SAME rejection. Only our own
//     flag separates them, so every path through it is pinned here.
//   - Cancel appears on screen at `available`, before a byte has moved. Main
//     must already be able to take one there, or the button does nothing and
//     the update installs anyway.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AppUpdateCheckResult, AppUpdateStatus } from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";

type UpdateEventHandler = (info?: {
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
}) => void;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<UpdateEventHandler>>();
  return {
    appPaths: { userData: "", home: "" },
    autoUpdaterConstructionError: undefined as Error | undefined,
    handlers,
    broadcast: vi.fn(),
    relay: vi.fn(),
    autoUpdater: {
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
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
    // A getter, like the real package's: it constructs the platform updater on
    // first access, and that constructor can throw.
    get autoUpdater() {
      if (mocks.autoUpdaterConstructionError !== undefined) {
        throw mocks.autoUpdaterConstructionError;
      }
      return mocks.autoUpdater;
    }
  }
}));

vi.mock("../events", () => ({
  broadcastRendererEventToLocalWindows: mocks.broadcast
}));

vi.mock("../process-split/event-relay", () => ({
  relayRendererEventToPeer: mocks.relay
}));

const FAKE_VERSION = "420.0.0";
/** `simulateDevUpdateCheck`'s default pace. The fake walks checking →
 *  available → seven percent ticks → downloaded, one delay each. */
const STEP_MS = 300;

async function importAutoUpdater() {
  return await import("../auto-updater");
}

function broadcastStatuses(): AppUpdateStatus[] {
  return mocks.broadcast.mock.calls
    .filter(([channel]) => channel === EVENT_CHANNELS.appUpdateStatus)
    .map(([, payload]) => payload as AppUpdateStatus);
}

function broadcastCheckResults(): AppUpdateCheckResult[] {
  return mocks.broadcast.mock.calls
    .filter(([channel]) => channel === EVENT_CHANNELS.appUpdateCheckResult)
    .map(([, payload]) => payload as AppUpdateCheckResult);
}

function downloadPercents(): (number | undefined)[] {
  return broadcastStatuses()
    .filter((entry) => entry.status === "downloading")
    .map((entry) => (entry.status === "downloading" ? entry.percent : undefined));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attached up front: a rejection asserted only at the end of the test would
  // otherwise be an unhandled rejection between now and then.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const originalNodeEnv = process.env.NODE_ENV;
const roots: string[] = [];

beforeEach(() => {
  mocks.handlers.clear();
  mocks.broadcast.mockReset();
  mocks.relay.mockReset();
  mocks.autoUpdater.checkForUpdates.mockReset();
  mocks.autoUpdater.quitAndInstall.mockReset();
  mocks.autoUpdater.setFeedURL.mockReset();
  mocks.autoUpdater.on.mockClear();
  mocks.autoUpdater.currentVersion = { version: "1.0.0" };
  mocks.autoUpdaterConstructionError = undefined;
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-updater-cancel-"));
  roots.push(root);
  mocks.appPaths.userData = root;
  mocks.appPaths.home = root;
});

afterEach(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  delete process.env.PWRSNAP_E2E_UPDATE_STEP_MS;
  const { disposeAutoUpdater } = await import("../auto-updater");
  disposeAutoUpdater();
  vi.useRealTimers();
  await vi.resetModules();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("dev/QA fake update check", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "development";
    vi.useFakeTimers();
  });

  test("ramps the download rather than reporting one frozen sample", async () => {
    const updater = await importAutoUpdater();

    const pending = updater.checkForAppUpdatesNow("menu");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "downloaded", version: FAKE_VERSION });
    expect([...new Set(broadcastStatuses().map((entry) => entry.status))]).toEqual([
      "checking",
      "available",
      "downloading",
      "downloaded"
    ]);
    // A meter cannot be judged against a single frozen percent, so the fake
    // has to move — this is the only way to see the card in `pnpm dev`.
    const percents = downloadPercents();
    expect(percents.length).toBeGreaterThan(3);
    expect(percents.at(0)).toBe(0);
    expect(percents.at(-1)).toBe(100);
    expect([...percents].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(percents);
    // And it carries bytes, not just a percent: the byte line is half of what
    // the card is for.
    const midway = broadcastStatuses().find(
      (entry) => entry.status === "downloading" && entry.percent === 58
    );
    expect(midway).toMatchObject({ total: 186_000_000, transferred: 107_880_000 });
  });

  test("honours PWRSNAP_E2E_UPDATE_STEP_MS so a spec can act mid-download", async () => {
    process.env.PWRSNAP_E2E_UPDATE_STEP_MS = "800";
    const updater = await importAutoUpdater();

    const pending = updater.checkForAppUpdatesNow("menu");
    // Past where the default pace would have finished the whole walk.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(updater.readAppUpdateStatus().status).toBe("downloading");

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ status: "downloaded", version: FAKE_VERSION });
  });

  test("stops the fake download when the user cancels it", async () => {
    const updater = await importAutoUpdater();
    const pending = updater.checkForAppUpdatesNow("menu");
    // Far enough in to be downloading, not far enough to have finished.
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(updater.readAppUpdateStatus().status).toBe("downloading");

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "canceled", version: FAKE_VERSION });
    // Nothing is held, so no Restart is offered for an update that never
    // finished arriving.
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "canceled",
      version: FAKE_VERSION
    });
    expect(broadcastStatuses().some((entry) => entry.status === "downloaded")).toBe(false);
  });

  test("takes a cancel pressed before the bytes start moving", async () => {
    // The live card offers Cancel from `available` onward. Main must already
    // be able to take one there, or the button sits on screen doing nothing
    // and the update installs anyway.
    const updater = await importAutoUpdater();
    const pending = updater.checkForAppUpdatesNow("menu");
    await vi.advanceTimersByTimeAsync(STEP_MS + 50);
    expect(updater.readAppUpdateStatus().status).toBe("available");

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "canceled", version: FAKE_VERSION });
    expect(downloadPercents()).toEqual([]);
    expect(broadcastStatuses().some((entry) => entry.status === "downloaded")).toBe(false);
  });

  test("takes a cancel pressed on the last step of the download", async () => {
    const updater = await importAutoUpdater();
    const pending = updater.checkForAppUpdatesNow("menu");
    // Two phase steps plus every percent tick, stopping inside the final
    // delay — the window a loop-top-only read would drop a cancel in.
    await vi.advanceTimersByTimeAsync(STEP_MS * 8 + 150);
    expect(downloadPercents().at(-1)).toBe(100);

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "canceled", version: FAKE_VERSION });
    expect(updater.readAppUpdateStatus().status).toBe("canceled");
  });

  test("answers a cancel with nothing to stop without inventing one", async () => {
    const updater = await importAutoUpdater();

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });

    const pending = updater.checkForAppUpdatesNow("menu");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    // The download is over; a click that lost the race must not rewrite the
    // offer the user now has.
    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: FAKE_VERSION
    });
  });

  test("finishes even where electron-updater refuses to construct", async () => {
    // electron-updater parses `app.getVersion()` in its platform updater's
    // constructor and throws ERR_UPDATER_INVALID_VERSION for anything that is
    // not semver — an unpackaged Electron on Linux reports "0.0". Nothing in
    // such a build can auto-update anyway, so reconciling the fake's held
    // download (and every status read) has to survive it. It did not: the
    // throw escaped as an "Update check failed" card on the Linux e2e lane.
    mocks.autoUpdaterConstructionError = new Error(
      'App version is not a valid semver version: "0.0"'
    );
    const updater = await importAutoUpdater();

    const pending = updater.runMenuUpdateCheck();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toEqual({ status: "downloaded", version: FAKE_VERSION });
    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloaded",
      version: FAKE_VERSION
    });
  });

  test("announces a menu check on the user-initiated channel and nothing else", async () => {
    const updater = await importAutoUpdater();

    const pending = updater.runMenuUpdateCheck();
    // The `checking` tick goes out before any work starts — that is what puts
    // the live card on screen for the whole release read.
    expect(broadcastCheckResults()).toEqual([{ status: "checking" }]);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ status: "downloaded", version: FAKE_VERSION });

    expect(broadcastCheckResults()).toEqual([
      { status: "checking" },
      { status: "downloaded", version: FAKE_VERSION }
    ]);
    // Relayed to the peer process too, so split-mode Library sees it.
    expect(mocks.relay).toHaveBeenCalledWith(EVENT_CHANNELS.appUpdateCheckResult, {
      status: "checking"
    });
  });

  test("answers the mount-time snapshot only while a menu check is running", async () => {
    // The `checking` tick is never replayed, so this is what a window that
    // subscribed a beat late reads instead.
    const updater = await importAutoUpdater();
    expect(updater.isUserUpdateCheckRunning()).toBe(false);

    const pending = updater.runMenuUpdateCheck();
    expect(updater.isUserUpdateCheckRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(updater.isUserUpdateCheckRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(updater.isUserUpdateCheckRunning()).toBe(false);
  });

  test("leaves the snapshot alone for a check nobody asked for", async () => {
    const updater = await importAutoUpdater();

    const pending = updater.checkForAppUpdatesNow("manual");
    expect(updater.isUserUpdateCheckRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  test("keeps background checks off the user-initiated channel entirely", async () => {
    const updater = await importAutoUpdater();

    await updater.checkForAppUpdatesNow("startup");
    await updater.checkForAppUpdatesNow("periodic");

    // Nobody asked, so nothing may raise a card — not even a "checking" tick.
    expect(broadcastCheckResults()).toEqual([]);
  });

  test("reports a canceled menu check as its own outcome, not an error", async () => {
    const updater = await importAutoUpdater();

    const pending = updater.runMenuUpdateCheck();
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    updater.cancelAppUpdateDownload();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(broadcastCheckResults().at(-1)).toEqual({
      status: "canceled",
      version: FAKE_VERSION
    });
  });
});

describe("cancelling a real electron-updater download", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          tag_name: "v1.0.1",
          draft: false,
          prerelease: false,
          assets: [
            { name: "latest-mac.yml", state: "uploaded" },
            { name: "PwrSnap-1.0.1-universal-mac.zip", state: "uploaded" },
            { name: "latest.yml", state: "uploaded" },
            { name: "PwrSnap Setup 1.0.1.exe", state: "uploaded" }
          ]
        }
      ]
    }) as unknown as typeof fetch;
  });

  test("does not dress a cancel the user asked for as a failure", async () => {
    const download = createDeferred<string[]>();
    const cancel = vi.fn(() => {
      download.reject(new Error("Cancelled"));
    });
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.1" },
      cancellationToken: { cancel },
      downloadPromise: download.promise
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));

    await expect(updater.checkForAppUpdatesNow("menu")).resolves.toEqual({
      status: "available",
      version: "1.0.1"
    });

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    expect(cancel).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus()).toEqual({ status: "canceled", version: "1.0.1" });
    });
  });

  test("aborts a download that had not handed over its token yet", async () => {
    // `update-available` — the status that puts Cancel on screen — is emitted
    // from inside `checkForUpdates`, which does not resolve (and so does not
    // yield its cancellationToken) until the download is already under way.
    const download = createDeferred<string[]>();
    const cancel = vi.fn(() => {
      download.reject(new Error("Cancelled"));
    });
    const checkStarted = createDeferred<void>();
    const releaseCheck = createDeferred<void>();
    mocks.autoUpdater.checkForUpdates.mockImplementation(async () => {
      checkStarted.resolve();
      await releaseCheck.promise;
      return {
        isUpdateAvailable: true,
        updateInfo: { version: "1.0.1" },
        cancellationToken: { cancel },
        downloadPromise: download.promise
      };
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));

    const pending = updater.checkForAppUpdatesNow("menu");
    await checkStarted.promise;

    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: true });
    // Nothing to cancel yet — the flag is all there is.
    expect(cancel).not.toHaveBeenCalled();

    releaseCheck.resolve();
    await pending;

    // The token arrives after the click; the cancel must be applied to it
    // rather than discarded.
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(updater.readAppUpdateStatus()).toEqual({ status: "canceled", version: "1.0.1" });
    });
  });

  test("leaves a download that broke on its own to the error handler", async () => {
    // The rejection is byte-identical to a cancel's; only our own flag tells
    // them apart, so a genuine failure must not be swallowed as "canceled".
    // electron-updater has already dispatched `error` for it by this point.
    const download = createDeferred<string[]>();
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.1" },
      cancellationToken: { cancel: vi.fn() },
      downloadPromise: download.promise
    });
    const updater = await importAutoUpdater();
    updater.setUpdateSelectionResolver(() => ({ channel: "latest", train: "stable" }));
    await updater.checkForAppUpdatesNow("menu");

    download.reject(new Error("socket hang up"));
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updater.readAppUpdateStatus().status).not.toBe("canceled");
    // And a later click finds nothing: the download is over either way.
    expect(updater.cancelAppUpdateDownload()).toEqual({ canceled: false });
  });

  test("carries the download's byte counts, not just a percent", async () => {
    const updater = await importAutoUpdater();
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    await vi.waitFor(() => {
      expect(mocks.handlers.has("download-progress")).toBe(true);
    });

    mocks.emit("update-available", { version: "1.0.1" });
    mocks.emit("download-progress", {
      percent: 42.4,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });

    expect(updater.readAppUpdateStatus()).toEqual({
      status: "downloading",
      version: "1.0.1",
      percent: 42,
      transferred: 50_000_000,
      total: 118_000_000,
      bytesPerSecond: 3_300_000
    });
  });

  test("settles on canceled when electron-updater reports its own abort", async () => {
    const updater = await importAutoUpdater();
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    await vi.waitFor(() => {
      expect(mocks.handlers.has("update-cancelled")).toBe(true);
    });

    mocks.emit("update-available", { version: "1.0.1" });
    mocks.emit("update-cancelled", { version: "1.0.1" });

    // Not `available`, which promises a download is under way, and not
    // `error`, which claims something broke.
    expect(updater.readAppUpdateStatus()).toEqual({ status: "canceled", version: "1.0.1" });
  });

  test("keeps a held download when a cancel arrives for something else", async () => {
    const updater = await importAutoUpdater();
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));
    await vi.waitFor(() => {
      expect(mocks.handlers.has("update-downloaded")).toBe(true);
    });
    mocks.emit("update-downloaded", { version: "1.1.0" });
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.1.0" });

    mocks.emit("update-cancelled", { version: "1.0.1" });

    // The Restart the user has already been offered is still good.
    expect(updater.readAppUpdateStatus()).toEqual({ status: "downloaded", version: "1.1.0" });
  });

  test("holds the menu outcome until the download it started settles", async () => {
    // The check itself answers `available` the moment electron-updater accepts
    // the release — with the whole download still to run. Reporting that as
    // the outcome takes the live card down mid-download, which is the defect.
    const download = createDeferred<string[]>();
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.1" },
      cancellationToken: { cancel: vi.fn() },
      downloadPromise: download.promise
    });
    const updater = await importAutoUpdater();
    updater.initAppUpdater(() => ({ channel: "latest", train: "stable" }));

    const pending = updater.runMenuUpdateCheck();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcastCheckResults()).toEqual([{ status: "checking" }]);

    mocks.emit("update-downloaded", { version: "1.0.1" });
    download.resolve([]);

    await expect(pending).resolves.toEqual({ status: "downloaded", version: "1.0.1" });
    expect(broadcastCheckResults().at(-1)).toEqual({
      status: "downloaded",
      version: "1.0.1"
    });
  });
});
