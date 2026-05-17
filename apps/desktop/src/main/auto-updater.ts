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

import { BrowserWindow } from "electron";
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
import { getMainLogger } from "./log";

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

type ChannelResolver = () => UpdateChannel;

let resolveChannel: ChannelResolver = () => "latest";
let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;

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
  updateStatus = nextStatus;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(EVENT_CHANNELS.appUpdateStatus, nextStatus);
  }
}

function downloadedVersion(): string | undefined {
  return updateStatus.status === "downloaded" ? updateStatus.version : undefined;
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

function configureAutoUpdaterChannel(): void {
  const updateChannel = currentUpdateChannel();
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

function preserveDownloadedStatus(nextStatus: AppUpdateStatus): boolean {
  if (updateStatus.status !== "downloaded") return false;
  return (
    nextStatus.status === "checking" ||
    nextStatus.status === "no-update" ||
    nextStatus.status === "error"
  );
}

function setUpdateStatusUnlessDownloaded(nextStatus: AppUpdateStatus): void {
  if (updateStatus.status === "downloaded" && preserveDownloadedStatus(nextStatus)) {
    log.info("keeping downloaded update status during follow-up check", {
      currentVersion: (updateStatus as { version: string }).version,
      nextStatus: nextStatus.status
    });
    return;
  }
  setUpdateStatus(nextStatus);
}

export async function checkForAppUpdatesNow(
  trigger: "startup" | "periodic" | "manual" | "menu" = "manual"
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    const result = developmentUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (updateCheckInFlight) {
    log.info("joining in-flight update check", { trigger });
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    try {
      log.info("checking for app updates", { trigger });
      configureAutoUpdaterChannel();
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
      setUpdateStatusUnlessDownloaded(errResult);
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

export function installDownloadedAppUpdate(): AppUpdateInstallResult {
  const version = downloadedVersion();
  if (!version) {
    return {
      status: "error",
      message: "No downloaded update is ready to install."
    };
  }
  try {
    log.info("installing downloaded update", { version });
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

  autoUpdater().on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatusUnlessDownloaded({ status: "checking" });
  });
  autoUpdater().on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    setUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater().on("update-not-available", (info) => {
    log.info("update-not-available", { version: info.version });
    setUpdateStatusUnlessDownloaded({ status: "no-update", version: info.version });
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
    setUpdateStatusUnlessDownloaded({ status: "error", message: err.message });
  });

  startPeriodicUpdateChecks();
  void checkForAppUpdatesNow("startup");
}

export function disposeAutoUpdater(): void {
  if (periodicUpdateCheckTimer) {
    clearInterval(periodicUpdateCheckTimer);
    periodicUpdateCheckTimer = undefined;
  }
  initialized = false;
}
