// electron-updater integration. Ported from PwrAgnt's
// apps/desktop/src/main/auto-updater.ts, adapted to PwrSnap's
// command-bus + EVENT_CHANNELS conventions (PwrAgnt uses raw
// ipcMain.handle; PwrSnap routes app:update:* through the bus so
// future MCP / HTTP transports get them for free).
//
// Lifecycle:
//   - initAppUpdater() is called once at boot in production builds.
//   - configureAutoUpdaterChannel() is re-run on every check from the
//     current settings (`updates.channel`) so flipping the toggle in
//     Settings takes effect without a restart.
//   - Status transitions broadcast over EVENT_CHANNELS.appUpdateStatus
//     to every BrowserWindow. The renderer banner subscribes via
//     preload.
//   - Periodic check fires every APP_UPDATE_CHECK_INTERVAL_MS. The
//     initial check fires shortly after boot (after the main window
//     has had a chance to mount the banner subscription).

import { app, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
  UpdateChannel
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { broadcastRendererEventToLocalWindows } from "./events";
import { relayRendererEventToPeer } from "./process-split/event-relay";
import { getMainLogger } from "./log";
import { readMacShipItDiagnostics, type MacShipItDiagnostics } from "./mac-shipit-diagnostics";
import {
  createAppUpdateInstallAttemptStore,
  type AppUpdateInstallAttempt,
  type AppUpdateInstallAttemptStore
} from "./update-install-attempt-store";

// Access `autoUpdater` lazily. electron-updater exposes it as a
// property getter that constructs `MacUpdater` on first access,
// and MacUpdater's constructor reads `app.getVersion()`. A
// module-level `const { autoUpdater } = electronUpdater` would
// trigger that during test imports of handlers/app-handlers.ts
// (which transitively pulls this module) even when the test
// only partial-mocks `electron`. Looking it up per-call instead
// keeps the import side-effect-free.
function autoUpdater(): typeof electronUpdater.autoUpdater {
  return electronUpdater.autoUpdater;
}

const log = getMainLogger("pwrsnap:updater");
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/pwrdrvr/PwrSnap/releases?per_page=30";
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const UPDATE_RETRY_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;

/** Obvious not-a-real-release version that the dev/QA fake update
 *  reports (see `simulateDevUpdateCheck`), so a previewed toast can
 *  never be mistaken for a genuine update. */
const DEV_FAKE_UPDATE_VERSION = "420.0.0";

type AppUpdateCheckTrigger = "startup" | "periodic" | "manual" | "menu";
type ChannelResolver = () => UpdateChannel;

let resolveChannel: ChannelResolver = () => "latest";
let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;
let installAttemptStore: AppUpdateInstallAttemptStore | undefined;
const retryDownloadWaiters = new Set<{
  expectedVersion: string;
  resolve: (result: AppUpdateCheckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

type GitHubRelease = {
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

/** Inject the function the updater calls to read the current channel.
 *  Kept as a callback rather than importing the settings service
 *  directly so this module stays testable + free of the singleton
 *  graph. Called by `initAutoUpdater` from main bootstrap. */
export function setUpdateChannelResolver(fn: ChannelResolver): void {
  resolveChannel = fn;
}

function setUpdateStatus(nextStatus: AppUpdateStatus): void {
  notifyRetryDownloadWaiters(nextStatus);
  updateStatus = nextStatus;
  // Local windows + the peer process (split mode): the updater runs in
  // the agent, but Settings → Updates (a library-process window) shows
  // the live check/download/restart status.
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.appUpdateStatus, nextStatus);
  relayRendererEventToPeer(EVENT_CHANNELS.appUpdateStatus, nextStatus);
}

function notifyRetryDownloadWaiters(nextStatus: AppUpdateStatus): void {
  for (const waiter of retryDownloadWaiters) {
    if (nextStatus.status === "downloaded" && nextStatus.version === waiter.expectedVersion) {
      clearTimeout(waiter.timer);
      retryDownloadWaiters.delete(waiter);
      waiter.resolve({ status: "downloaded", version: nextStatus.version });
    } else if (nextStatus.status === "error") {
      clearTimeout(waiter.timer);
      retryDownloadWaiters.delete(waiter);
      waiter.resolve({ status: "error", message: nextStatus.message });
    } else if (nextStatus.status === "no-update") {
      clearTimeout(waiter.timer);
      retryDownloadWaiters.delete(waiter);
      waiter.resolve({ status: "no-update", version: nextStatus.version });
    }
  }
}

function waitForRetryDownload(expectedVersion: string): Promise<AppUpdateCheckResult> {
  if (updateStatus.status === "downloaded" && updateStatus.version === expectedVersion) {
    return Promise.resolve({ status: "downloaded", version: expectedVersion });
  }
  return new Promise((resolve) => {
    const waiter = {
      expectedVersion,
      resolve,
      timer: setTimeout(() => {
        retryDownloadWaiters.delete(waiter);
        resolve({
          status: "error",
          message: `Timed out waiting for update v${expectedVersion} to finish downloading.`
        });
      }, UPDATE_RETRY_DOWNLOAD_TIMEOUT_MS)
    };
    waiter.timer.unref?.();
    retryDownloadWaiters.add(waiter);
  });
}

function installableUpdateVersion(): string | undefined {
  return updateStatus.status === "downloaded" || updateStatus.status === "install-failed"
    ? updateStatus.version
    : undefined;
}

function installRetryChannel(): UpdateChannel | undefined {
  return updateStatus.status === "install-failed" ? updateStatus.channel : undefined;
}

function getInstallAttemptStore(): AppUpdateInstallAttemptStore {
  installAttemptStore ??= createAppUpdateInstallAttemptStore(app.getPath("userData"));
  return installAttemptStore;
}

function currentAppVersion(): string {
  return app.getVersion();
}

function readShipItDiagnostics(): MacShipItDiagnostics | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return readMacShipItDiagnostics({
      homeDir: app.getPath("home"),
      platform: process.platform,
      resourcesPath: process.resourcesPath
    });
  } catch (err) {
    log.warn("failed to read Squirrel.Mac diagnostics", {
      message: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
}

function recordInstallAttempt(version: string, channel: UpdateChannel): AppUpdateInstallAttempt | undefined {
  const attempt = {
    expectedVersion: version,
    fromVersion: currentAppVersion(),
    channel,
    attemptedAt: new Date().toISOString()
  };
  const shipIt = readShipItDiagnostics();
  try {
    const written = getInstallAttemptStore().write(attempt);
    log.info("recorded app update install attempt", {
      attemptFile: getInstallAttemptStore().filePath(),
      attempt: written,
      shipIt
    });
    return written;
  } catch (err) {
    log.warn("failed to record app update install attempt", {
      attempt,
      message: err instanceof Error ? err.message : String(err),
      shipIt
    });
    return undefined;
  }
}

function clearInstallAttempt(reason: string, attempt?: AppUpdateInstallAttempt): void {
  try {
    getInstallAttemptStore().clear();
    log.info("cleared app update install attempt", { reason, attempt });
  } catch (err) {
    log.warn("failed to clear app update install attempt", {
      reason,
      message: err instanceof Error ? err.message : String(err)
    });
  }
}

function reconcilePendingInstallAttemptOnBoot(): boolean {
  let attempt: AppUpdateInstallAttempt | undefined;
  try {
    attempt = getInstallAttemptStore().read();
  } catch (err) {
    log.warn("failed to read app update install attempt", {
      attemptFile: getInstallAttemptStore().filePath(),
      message: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
  if (attempt === undefined) return false;

  const currentVersion = currentAppVersion();
  const shipIt = readShipItDiagnostics();
  if (currentVersion === attempt.expectedVersion) {
    log.info("app update install attempt completed", {
      attempt,
      currentVersion,
      shipIt
    });
    clearInstallAttempt("installed", attempt);
    return false;
  }

  log.warn("app update install attempt did not apply expected version", {
    attempt,
    currentVersion,
    shipIt
  });
  setUpdateStatus({
    status: "install-failed",
    version: attempt.expectedVersion,
    currentVersion,
    attemptedAt: attempt.attemptedAt,
    channel: attempt.channel
  });
  return true;
}

function currentUpdateChannel(): UpdateChannel {
  try {
    return resolveChannel();
  } catch (err) {
    log.warn("failed to read update channel setting", {
      message: err instanceof Error ? err.message : String(err)
    });
    return "latest";
  }
}

function configureAutoUpdaterChannel(updateChannel: UpdateChannel = currentUpdateChannel()): void {
  autoUpdater().allowPrerelease = updateChannel === "prerelease";
  log.info("configured auto-update channel", {
    allowPrerelease: autoUpdater().allowPrerelease,
    updateChannel
  });
}

function productionUpdatesEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

function developmentUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "auto-update disabled in development"
  };
}

function preserveActionableUpdateStatus(nextStatus: AppUpdateStatus): boolean {
  if (updateStatus.status !== "downloaded" && updateStatus.status !== "install-failed") {
    return false;
  }
  return (
    nextStatus.status === "checking" ||
    nextStatus.status === "no-update" ||
    nextStatus.status === "error"
  );
}

function setUpdateStatusUnlessActionable(nextStatus: AppUpdateStatus): void {
  if (preserveActionableUpdateStatus(nextStatus)) {
    notifyRetryDownloadWaiters(nextStatus);
    log.info("keeping actionable update status during follow-up check", {
      currentStatus: updateStatus.status,
      currentVersion: (updateStatus as { version: string }).version,
      nextStatus: nextStatus.status
    });
    return;
  }
  setUpdateStatus(nextStatus);
}

export async function checkForAppUpdatesNow(
  trigger: AppUpdateCheckTrigger = "manual",
  updateChannel: UpdateChannel = currentUpdateChannel()
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    return simulateDevUpdateCheck(trigger);
  }

  if (updateCheckInFlight) {
    log.info("joining in-flight update check", { trigger });
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    try {
      log.info("checking for app updates", { trigger, updateChannel });
      configureAutoUpdaterChannel(updateChannel);
      const result = await autoUpdater().checkForUpdates();
      if (updateStatus.status === "downloaded") {
        return { status: "downloaded", version: updateStatus.version };
      }
      if (!result || !result.updateInfo) {
        return {
          status: "no-update",
          version: result?.updateInfo?.version ?? "unknown"
        };
      }
      const currentVersion = autoUpdater().currentVersion?.version ?? "unknown";
      if (result.updateInfo.version === currentVersion) {
        return { status: "no-update", version: currentVersion };
      }
      return { status: "available", version: result.updateInfo.version };
    } catch (err) {
      const errResult: AppUpdateCheckResult = {
        status: "error",
        message: err instanceof Error ? err.message : String(err)
      };
      setUpdateStatusUnlessActionable(errResult);
      log.warn("checkForUpdates failed", {
        message: errResult.message,
        trigger
      });
      return errResult;
    } finally {
      updateCheckInFlight = undefined;
    }
  })();

  return updateCheckInFlight;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Dev/QA stand-in for a real update check.
 *
 *  Real auto-update only runs in production — the dev binary is
 *  unsigned and has no release feed, so `initAppUpdater` skips the
 *  whole electron-updater wiring outside production. That means the
 *  update toast can't otherwise be seen without cutting a release. So
 *  a *user-initiated* check (Help → Check for Updates, or the Updates
 *  settings page) instead walks the status machine to a fake
 *  `downloaded@420.0.0`, broadcasting each transition so the entire
 *  flow — checking → available → downloading → downloaded → toast —
 *  can be exercised end-to-end in `pnpm dev`.
 *
 *  Startup/periodic triggers stay silent (status `skipped`) so a dev
 *  launch never pops a toast on its own. Clicking Restart on the fake
 *  update is a no-op — see `installDownloadedAppUpdate`.
 */
async function simulateDevUpdateCheck(
  trigger: AppUpdateCheckTrigger
): Promise<AppUpdateCheckResult> {
  if (trigger !== "manual" && trigger !== "menu") {
    const skipped = developmentUpdateCheckResult();
    setUpdateStatus(skipped);
    return skipped;
  }
  // Join an in-flight simulation so mashing the menu doesn't stack
  // overlapping animations racing on setUpdateStatus.
  if (updateCheckInFlight) return updateCheckInFlight;
  const version = DEV_FAKE_UPDATE_VERSION;
  log.info("simulating dev update check", { trigger, version });
  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    setUpdateStatus({ status: "checking" });
    await delay(300);
    setUpdateStatus({ status: "available", version });
    await delay(300);
    setUpdateStatus({ status: "downloading", version, percent: 60 });
    await delay(300);
    setUpdateStatus({ status: "downloaded", version });
    return { status: "downloaded", version };
  })();
  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = undefined;
  }
}

function startPeriodicUpdateChecks(): void {
  if (periodicUpdateCheckTimer) return;
  periodicUpdateCheckTimer = setInterval(() => {
    void checkForAppUpdatesNow("periodic");
  }, APP_UPDATE_CHECK_INTERVAL_MS);
  periodicUpdateCheckTimer.unref?.();
}

function releaseInfoFromGitHubRelease(
  release: GitHubRelease | undefined,
  unavailableReason: string
): AppUpdateReleaseInfo {
  if (!release?.tag_name) return { unavailableReason };
  return {
    version: release.tag_name,
    ...(release.name ? { name: release.name } : {}),
    ...(release.html_url ? { url: release.html_url } : {}),
    ...(release.published_at ? { publishedAt: release.published_at } : {})
  };
}

function githubReleaseHeaders(): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrSnap",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: githubReleaseHeaders(),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed with ${response.status}`);
    }
    const payload = await response.json();
    const releases = Array.isArray(payload)
      ? payload.filter((r): r is GitHubRelease => typeof r === "object" && r !== null)
      : [];
    const publicReleases = releases.filter((release) => release.draft !== true);
    const latest = publicReleases.find((release) => release.prerelease !== true);
    const prerelease = publicReleases.find((release) => release.prerelease === true);
    return {
      fetchedAt: Date.now(),
      latest: releaseInfoFromGitHubRelease(latest, "No stable release found."),
      prerelease: releaseInfoFromGitHubRelease(prerelease, "No prerelease found.")
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      fetchedAt: Date.now(),
      latest: { unavailableReason: message },
      prerelease: { unavailableReason: message }
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function readAppUpdateStatus(): AppUpdateStatus {
  return updateStatus;
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateInstallResult> {
  const retryChannel = installRetryChannel();
  let version = installableUpdateVersion();
  if (!version) {
    return {
      status: "error",
      message: "No downloaded update is ready to install."
    };
  }
  if (!productionUpdatesEnabled()) {
    // The only way to reach `downloaded` outside production is the
    // dev/QA fake (see `simulateDevUpdateCheck`): there's no real
    // payload and the dev binary is unsigned, so don't bounce the app
    // through quitAndInstall — surface a clear no-op in the toast.
    log.info("dev fake update — Restart is a no-op outside production", {
      version
    });
    return {
      status: "error",
      message: `Dev preview (v${version}): Restart only works in production builds.`
    };
  }
  try {
    if (retryChannel !== undefined) {
      log.info("retrying failed app update install by refreshing update payload", {
        version,
        updateChannel: retryChannel
      });
      const retryResult = await checkForAppUpdatesNow("manual", retryChannel);
      const refreshedResult =
        retryResult.status === "available"
          ? await waitForRetryDownload(retryResult.version)
          : retryResult;
      if (refreshedResult.status !== "downloaded") {
        return {
          status: "error",
          message:
            refreshedResult.status === "error"
              ? refreshedResult.message
              : `Update retry did not finish downloading v${version}.`
        };
      }
      version = refreshedResult.version;
    }
    log.info("installing downloaded update", { version });
    recordInstallAttempt(version, retryChannel ?? currentUpdateChannel());
    autoUpdater().quitAndInstall();
    return { status: "restarting" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export function initAppUpdater(): void {
  if (initialized) return;
  initialized = true;

  // Skip in development. The dev binary isn't signed and Squirrel.Mac
  // would refuse to apply any update anyway. Skipping cleanly avoids
  // spurious 404s when running `pnpm dev` without a release feed.
  if (!productionUpdatesEnabled()) {
    log.info("auto-update disabled in non-production");
    setUpdateStatus(developmentUpdateCheckResult());
    return;
  }

  autoUpdater().logger = log as unknown as Console;
  autoUpdater().autoDownload = true;
  autoUpdater().autoInstallOnAppQuit = true;
  configureAutoUpdaterChannel();
  const pendingInstallFailed = reconcilePendingInstallAttemptOnBoot();

  autoUpdater().on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatusUnlessActionable({ status: "checking" });
  });
  autoUpdater().on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    setUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater().on("update-not-available", (info) => {
    log.info("update-not-available", { version: info.version });
    setUpdateStatusUnlessActionable({ status: "no-update", version: info.version });
  });
  autoUpdater().on("download-progress", (progress) => {
    log.info("download-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total
    });
    const version =
      updateStatus.status === "available" || updateStatus.status === "downloading"
        ? updateStatus.version
        : "unknown";
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent)
    });
  });
  autoUpdater().on("update-downloaded", (info) => {
    log.info("update-downloaded", { version: info.version });
    setUpdateStatus({ status: "downloaded", version: info.version });
  });
  autoUpdater().on("error", (err: Error) => {
    log.warn("auto-update error", { message: err.message });
    setUpdateStatusUnlessActionable({ status: "error", message: err.message });
  });

  startPeriodicUpdateChecks();
  if (!pendingInstallFailed) {
    void checkForAppUpdatesNow("startup");
  }
}

export function disposeAutoUpdater(): void {
  if (periodicUpdateCheckTimer) {
    clearInterval(periodicUpdateCheckTimer);
    periodicUpdateCheckTimer = undefined;
  }
  initialized = false;
  for (const waiter of retryDownloadWaiters) {
    clearTimeout(waiter.timer);
  }
  retryDownloadWaiters.clear();
}
