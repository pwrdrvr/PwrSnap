// electron-updater integration. Ported from PwrAgnt's
// apps/desktop/src/main/auto-updater.ts, adapted to PwrSnap's
// command-bus + EVENT_CHANNELS conventions (PwrAgnt uses raw
// ipcMain.handle; PwrSnap routes app:update:* through the bus so
// future MCP / HTTP transports get them for free).
//
// Lifecycle:
//   - initAppUpdater() is called once at boot in production builds.
//   - configureAutoUpdaterChannel() is re-run on every check from the
//     current settings (`updates.train` + `updates.channel`) so flipping
//     either control in Settings takes effect without a restart.
//   - The updater pins electron-updater to a specific GitHub Release
//     tag via a generic feed URL.
//   - Status transitions broadcast over EVENT_CHANNELS.appUpdateStatus
//     to every BrowserWindow. The renderer banner subscribes via
//     preload.
//   - Periodic check fires every APP_UPDATE_CHECK_INTERVAL_MS. The
//     initial check fires shortly after boot (after the main window
//     has had a chance to mount the banner subscription).

import { app } from "electron";
import electronUpdater from "electron-updater";
import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
  UpdateChannel,
  UpdateTrain
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
import {
  isExactWindowsUpdateSmokeFeedUrl,
  isWindowsUpdateSmokeRequested,
  type WindowsUpdateSmokeConfig
} from "./windows-update-smoke";

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
const GITHUB_RELEASES_URL = "https://api.github.com/repos/pwrdrvr/PwrSnap/releases";
const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`;
const RELEASE_PAGE_SIZE = 100;
const RELEASE_MAX_PAGES = 10;
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
// The GitHub REST API allows 60 anonymous requests per hour per IP, shared by
// every process on the machine, and one release read here costs at least two
// of them (`/releases/latest` plus a page). Settings reads the release
// versions on every mount, so main caches the list and serves those reads
// from memory instead of spending requests each time.
export const APP_UPDATE_RELEASE_CACHE_TTL_MS = 15 * 60 * 1_000;
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 15 * 60 * 1_000;
const UPDATE_RETRY_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1_000;
const MAC_UPDATE_CHANNEL_FILE = "latest-mac.yml";
const WIN_UPDATE_CHANNEL_FILE = "latest.yml";

/** Obvious not-a-real-release version that the dev/QA fake update
 *  reports (see `simulateDevUpdateCheck`), so a previewed toast can
 *  never be mistaken for a genuine update. */
const DEV_FAKE_UPDATE_VERSION = "420.0.0";

type AppUpdateCheckTrigger = "startup" | "periodic" | "manual" | "menu";

/** A downgrade back to the selected slot is only ever OFFERED when the user
 *  asked — the Settings "Check for Updates" button or the app menu item.
 *  Background checks stay silent about it: someone who deliberately installed
 *  a newer build and left their channel alone should not be nagged to go
 *  back on every hourly poll. Switching channels in Settings does not itself
 *  fire a check, so the button is the deliberate step either way. */
function isUserInitiatedTrigger(trigger: AppUpdateCheckTrigger): boolean {
  return trigger === "manual" || trigger === "menu";
}
type UpdateSelection = { channel: UpdateChannel; train: UpdateTrain };
type UpdateSelectionKey = `${UpdateTrain}:${UpdateChannel}`;
type SelectionResolver = () => UpdateSelection;
const WINDOWS_UPDATE_SMOKE_SELECTION: UpdateSelection = {
  channel: "prerelease",
  train: "beta"
};

let resolveSelection: SelectionResolver = () => ({
  channel: "latest",
  train: "stable"
});
let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;
let updateCheckSelectionInFlight: UpdateSelectionKey | undefined;
let heldDownloadedUpdate:
  | { selection: UpdateSelectionKey; version: string; downgrade?: true }
  | undefined;
let heldInstallFailed:
  | Extract<AppUpdateStatus, { status: "install-failed" }>
  | undefined;
const pendingDownloadSelectionsByVersion = new Map<string, UpdateSelectionKey>();
/** Versions we deliberately asked electron-updater to move BACKWARD to, so
 *  the `update-available` / `update-downloaded` events can mark their status
 *  as a switch rather than an update. Keyed by version because that is all
 *  those events carry. */
const pendingDowngradeVersions = new Set<string>();
/** True while a check that decided "the selected slot is behind us" is still
 *  running. The version keys above come from the release TAG, while the
 *  events carry the version electron-updater read out of the channel file;
 *  if those ever drift, the lookup misses and a downgrade would be re-armed
 *  for silent install on quit. The in-flight flag is the authoritative
 *  answer for the window in which `update-available` fires, and seeds the
 *  set with the version the event actually reported. */
let downgradeCheckInFlight = false;
let installAttemptStore: AppUpdateInstallAttemptStore | undefined;
/** The one copy of the GitHub release list in main. `latest` is the
 *  `/releases/latest` body kept beside the pages so a 304 on that endpoint
 *  still yields the tag the pager terminates on. `etags` is keyed by request
 *  URL. */
type ReleaseCacheEntry = {
  etags: Record<string, string>;
  fetchedAt: number;
  latest: GitHubRelease | undefined;
  releases: GitHubRelease[];
};
let releaseCache: ReleaseCacheEntry | undefined;
let releaseFetchInFlight: Promise<GitHubRelease[]> | undefined;
/** Epoch ms at which GitHub said the anonymous quota refills. While set and
 *  unreached, no further request is issued. */
let rateLimitResetAt: number | undefined;
/** Validated once, before updater initialization, by the packaged bootstrap.
 * An opt-in env without this object is a hard error — never a reason to fall
 * through to GitHub discovery. */
let configuredWindowsUpdateSmoke: WindowsUpdateSmokeConfig | null = null;
const retryDownloadWaiters = new Set<{
  expectedVersion: string;
  resolve: (result: AppUpdateCheckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

type GitHubReleaseAsset = {
  name?: string;
  state?: string;
};

/** Inject the function the updater calls to read the current train/track.
 *  Kept as a callback rather than importing the settings service
 *  directly so this module stays testable + free of the singleton
 *  graph. Called by `initAutoUpdater` from main bootstrap. */
export function setUpdateSelectionResolver(fn: SelectionResolver): void {
  resolveSelection = fn;
}

export function setWindowsUpdateSmokeConfig(config: WindowsUpdateSmokeConfig | null): void {
  configuredWindowsUpdateSmoke = config;
}

function windowsUpdateSmokeConfig(): WindowsUpdateSmokeConfig | undefined {
  if (!isWindowsUpdateSmokeRequested()) return undefined;
  if (configuredWindowsUpdateSmoke === null) {
    throw new Error(
      "Windows updater smoke was requested but its build marker/configuration was not validated"
    );
  }
  return configuredWindowsUpdateSmoke;
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

function installRetrySelection(): UpdateSelection | undefined {
  return updateStatus.status === "install-failed"
    ? { channel: updateStatus.channel, train: updateStatus.train }
    : undefined;
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

function recordInstallAttempt(
  version: string,
  selection: UpdateSelection
): AppUpdateInstallAttempt | undefined {
  const attempt = {
    expectedVersion: version,
    fromVersion: currentAppVersion(),
    channel: selection.channel,
    train: selection.train,
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
  const failed: Extract<AppUpdateStatus, { status: "install-failed" }> = {
    status: "install-failed",
    version: attempt.expectedVersion,
    currentVersion,
    attemptedAt: attempt.attemptedAt,
    channel: attempt.channel,
    train: attempt.train
  };
  heldInstallFailed = failed;
  setUpdateStatus(failed);
  return true;
}

function currentUpdateSelection(): UpdateSelection {
  if (windowsUpdateSmokeConfig() !== undefined) {
    return WINDOWS_UPDATE_SMOKE_SELECTION;
  }
  try {
    return resolveSelection();
  } catch (err) {
    log.warn("failed to read update selection setting", {
      message: err instanceof Error ? err.message : String(err)
    });
    return { channel: "latest", train: "stable" };
  }
}

function updateSelectionKey(selection: UpdateSelection): UpdateSelectionKey {
  return `${selection.train}:${selection.channel}`;
}

function currentUpdateSelectionKey(): UpdateSelectionKey {
  return updateSelectionKey(currentUpdateSelection());
}

function configureAutoUpdaterChannel(selection: UpdateSelection = currentUpdateSelection()): void {
  const smoke = windowsUpdateSmokeConfig();
  autoUpdater().allowPrerelease =
    smoke !== undefined || selection.train === "beta" || selection.channel === "prerelease";
  // Every check starts from the forward-only posture. `allowDowngrade` is
  // opened for exactly one check, by `allowAutoUpdaterDowngrade`, once we
  // have decided the selected release is behind the running build.
  autoUpdater().allowDowngrade = false;
  log.info("configured auto-update channel", {
    allowDowngrade: autoUpdater().allowDowngrade,
    allowPrerelease: autoUpdater().allowPrerelease,
    updateChannel: selection.channel,
    updateTrain: selection.train,
    windowsUpdateSmoke: smoke !== undefined
  });
}

/** Open the one-way valve `configureAutoUpdaterChannel` just closed.
 *  Without this electron-updater refuses the install outright and the user
 *  has no path back to the train they picked. */
function allowAutoUpdaterDowngrade(selectedVersion: string): void {
  autoUpdater().allowDowngrade = true;
  downgradeCheckInFlight = true;
  pendingDowngradeVersions.add(selectedVersion);
}

function configureAutoUpdaterFeedForRelease(release: GitHubRelease): void {
  const tag = release.tag_name;
  if (!tag) return;
  autoUpdater().setFeedURL({
    provider: "generic",
    url: `https://github.com/pwrdrvr/PwrSnap/releases/download/${encodeURIComponent(tag)}/`
  });
  log.info("configured auto-update feed for GitHub release", { tag });
}

function configureAutoUpdaterFeedForWindowsUpdateSmoke(config: WindowsUpdateSmokeConfig): void {
  if (!isExactWindowsUpdateSmokeFeedUrl(config.feedUrl)) {
    throw new Error(
      "Windows updater smoke feed failed the exact loopback-only runtime guard"
    );
  }
  // readWindowsUpdateSmokeConfig already validated the exact loopback URL
  // grammar. Keep the value opaque here so electron-updater cannot derive or
  // fall back to the production GitHub provider.
  autoUpdater().channel = "latest";
  // electron-updater's channel setter silently opens allowDowngrade. This
  // smoke is forward-only, so close it again after forcing latest.yml.
  autoUpdater().allowDowngrade = false;
  autoUpdater().requestHeaders = null;
  autoUpdater().setFeedURL({ provider: "generic", url: config.feedUrl });
  log.info("configured isolated Windows updater smoke feed", {
    feedUrl: config.feedUrl,
    runId: config.runId,
    targetVersion: config.targetVersion
  });
}

function acceptWindowsUpdateSmokeEventVersion(
  event: string,
  version: string | undefined
): boolean {
  const smoke = windowsUpdateSmokeConfig();
  if (smoke === undefined || version === smoke.targetVersion) return true;
  const message =
    `Windows updater smoke ${event} reported ${version ?? "no version"}; ` +
    `expected exact target ${smoke.targetVersion}`;
  log.error(message, { event, runId: smoke.runId, version });
  setUpdateStatus({ status: "error", message });
  return false;
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
  if (downloadedOrFailedMatchesSelection(currentUpdateSelectionKey()) === undefined) {
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

function downloadedUpdateMatchesSelection(
  updateSelection: UpdateSelectionKey
): Extract<AppUpdateCheckResult, { status: "downloaded" }> | undefined {
  if (heldDownloadedUpdate?.selection !== updateSelection) {
    return undefined;
  }
  return {
    status: "downloaded",
    version: heldDownloadedUpdate.version,
    ...(heldDownloadedUpdate.downgrade === true ? ({ downgrade: true } as const) : {})
  };
}

function downloadedOrFailedMatchesSelection(
  updateSelection: UpdateSelectionKey
):
  | Extract<AppUpdateCheckResult, { status: "downloaded" }>
  | Extract<AppUpdateStatus, { status: "install-failed" }>
  | undefined {
  const downloaded = downloadedUpdateMatchesSelection(updateSelection);
  if (downloaded) return downloaded;
  if (heldInstallFailed === undefined) return undefined;
  const failedKey = updateSelectionKey({
    channel: heldInstallFailed.channel,
    train: heldInstallFailed.train
  });
  return failedKey === updateSelection ? heldInstallFailed : undefined;
}

function syncAutoInstallOnAppQuit(updateSelection: UpdateSelectionKey): void {
  if (windowsUpdateSmokeConfig() !== undefined) {
    // The smoke installs only through the exact-target guarded
    // installDownloadedAppUpdate call. A failure exit must never make
    // electron-updater silently apply whatever happens to be cached.
    autoUpdater().autoInstallOnAppQuit = false;
    return;
  }
  const matching = downloadedUpdateMatchesSelection(updateSelection);
  // Stepping the installed build BACKWARD is heavier than a forward update
  // and the user only ever asked to see what was available. Hold it for the
  // explicit Restart in the banner rather than applying it on the next quit
  // — dismissing that banner hides the notice, it does not decline the move.
  autoUpdater().autoInstallOnAppQuit =
    (matching !== undefined && matching.downgrade !== true) ||
    heldDownloadedUpdate === undefined;
}

export function reconcileAppUpdateSelection(
  updateSelection: UpdateSelectionKey = currentUpdateSelectionKey()
): void {
  const eligible = downloadedOrFailedMatchesSelection(updateSelection);
  syncAutoInstallOnAppQuit(updateSelection);
  if (eligible) {
    if (
      updateStatus.status !== eligible.status ||
      updateStatus.version !== eligible.version
    ) {
      setUpdateStatus(eligible);
    }
    return;
  }
  if (updateStatus.status === "downloaded" || updateStatus.status === "install-failed") {
    const currentVersion = autoUpdater().currentVersion?.version ?? currentAppVersion();
    log.info("hiding downloaded update from the unselected train", {
      currentVersion,
      heldSelection: heldDownloadedUpdate?.selection,
      heldVersion: heldDownloadedUpdate?.version,
      heldFailedVersion: heldInstallFailed?.version,
      updateSelection
    });
    setUpdateStatus({ status: "no-update", version: currentVersion });
  }
}

function recordPendingDownloadSelection(
  version: string | undefined,
  updateSelection: UpdateSelectionKey | undefined
): void {
  if (!version || !updateSelection) return;
  pendingDownloadSelectionsByVersion.set(version, updateSelection);
}

export async function checkForAppUpdatesNow(
  trigger: AppUpdateCheckTrigger = "manual",
  selection: UpdateSelection = currentUpdateSelection()
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    return simulateDevUpdateCheck(trigger);
  }

  const requestedSelection = updateSelectionKey(selection);
  if (updateCheckInFlight && updateCheckSelectionInFlight === requestedSelection) {
    log.info("joining in-flight update check", {
      trigger,
      updateChannel: selection.channel,
      updateTrain: selection.train
    });
    return updateCheckInFlight;
  }
  if (updateCheckInFlight) {
    log.info("waiting for in-flight update check before switching selection", {
      trigger,
      inFlightSelection: updateCheckSelectionInFlight,
      updateChannel: selection.channel,
      updateTrain: selection.train
    });
    await updateCheckInFlight.catch(() => undefined);
    return checkForAppUpdatesNow(trigger, selection);
  }

  updateCheckSelectionInFlight = requestedSelection;
  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    try {
      const updateSelection = requestedSelection;
      reconcileAppUpdateSelection(updateSelection);
      const downloadedResult = downloadedUpdateMatchesSelection(updateSelection);
      if (downloadedResult) {
        log.info("skipping app update check; update already downloaded", {
          trigger,
          updateChannel: selection.channel,
          updateTrain: selection.train,
          version: downloadedResult.version
        });
        return downloadedResult;
      }
      log.info("checking for app updates", {
        trigger,
        updateChannel: selection.channel,
        updateTrain: selection.train
      });
      configureAutoUpdaterChannel(selection);
      const smoke = windowsUpdateSmokeConfig();
      if (smoke !== undefined) {
        const currentVersion = autoUpdater().currentVersion?.version ?? currentAppVersion();
        configureAutoUpdaterFeedForWindowsUpdateSmoke(smoke);
        if (currentVersion === smoke.targetVersion) {
          const result = { status: "no-update", version: currentVersion } as const;
          setUpdateStatusUnlessActionable(result);
          log.info("Windows updater smoke target is already installed", {
            currentVersion,
            runId: smoke.runId
          });
          return result;
        }
        if (currentVersion !== smoke.baselineVersion) {
          throw new Error(
            `Windows updater smoke running version ${currentVersion} is not exact baseline ${smoke.baselineVersion}`
          );
        }
        const result = await autoUpdater().checkForUpdates();
        const selectedVersion = result?.updateInfo?.version;
        if (selectedVersion !== smoke.targetVersion) {
          throw new Error(
            `Windows updater smoke feed selected ${selectedVersion ?? "no version"}; expected exact target ${smoke.targetVersion}`
          );
        }
        recordPendingDownloadSelection(selectedVersion, updateSelection);
        const matchingDownloadedResult = downloadedUpdateMatchesSelection(updateSelection);
        if (matchingDownloadedResult) return matchingDownloadedResult;
        return { status: "available", version: selectedVersion };
      }
      const release = await readAppUpdateReleaseForSelection(
        selection,
        // A user-initiated check should not answer from a 15-minute-old
        // cache. Revalidation rides the stored etag, so the usual answer is
        // a 304, which GitHub does not charge against the rate limit.
        isUserInitiatedTrigger(trigger) ? 0 : undefined
      );
      const currentVersion = autoUpdater().currentVersion?.version ?? "unknown";
      if (!release?.tag_name) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessActionable(result);
        log.info("skipping app update check; no valid GitHub release found", {
          trigger,
          updateChannel: selection.channel,
          updateTrain: selection.train
        });
        return result;
      }
      const selectedVersion = release.tag_name.replace(/^v/i, "");
      const selectedVersusCurrent = compareSemver(selectedVersion, currentVersion);
      // `compareSemver` sorts an unparseable tag below every valid version,
      // which would otherwise read as "the selected slot is behind us" and
      // pin the feed to a tag we could not even parse.
      const comparable =
        parseSemver(selectedVersion) !== undefined && parseSemver(currentVersion) !== undefined;
      if (selectedVersusCurrent === 0 || (selectedVersusCurrent < 0 && !comparable)) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessActionable(result);
        log.info("skipping app update check; selected release is not newer", {
          currentVersion,
          selectedRelease: release.tag_name,
          trigger,
          updateChannel: selection.channel,
          updateTrain: selection.train
        });
        return result;
      }
      // The selected slot is BEHIND the running build. That is what a user
      // looks like after a newer train pulled them off the one they picked:
      // Stable Latest resolves to v1.0.1 while they are sitting on a 1.1
      // alpha, and forward-only checks answer "you're up to date" forever.
      // Offer the way back, but only when they asked for a check.
      const isDowngrade = selectedVersusCurrent < 0;
      if (isDowngrade && !isUserInitiatedTrigger(trigger)) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessActionable(result);
        log.info("holding downgrade to the selected release for a user-initiated check", {
          currentVersion,
          selectedRelease: release.tag_name,
          trigger,
          updateChannel: selection.channel,
          updateTrain: selection.train
        });
        return result;
      }
      if (isDowngrade) {
        allowAutoUpdaterDowngrade(selectedVersion);
        log.info("offering downgrade back to the selected release", {
          currentVersion,
          selectedRelease: release.tag_name,
          trigger,
          updateChannel: selection.channel,
          updateTrain: selection.train
        });
      }
      configureAutoUpdaterFeedForRelease(release);
      const result = await autoUpdater().checkForUpdates();
      if (result?.updateInfo?.version !== currentVersion) {
        recordPendingDownloadSelection(result?.updateInfo?.version, updateSelection);
      }
      const matchingDownloadedResult = downloadedUpdateMatchesSelection(updateSelection);
      if (matchingDownloadedResult) {
        return matchingDownloadedResult;
      }
      if (!result || !result.updateInfo) {
        return {
          status: "no-update",
          version: result?.updateInfo?.version ?? "unknown"
        };
      }
      if (result.updateInfo.version === currentVersion) {
        return { status: "no-update", version: currentVersion };
      }
      return {
        status: "available",
        version: result.updateInfo.version,
        ...(isDowngrade ? ({ downgrade: true } as const) : {})
      };
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
      downgradeCheckInFlight = false;
      updateCheckSelectionInFlight = undefined;
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
    heldDownloadedUpdate = {
      selection: currentUpdateSelectionKey(),
      version
    };
    reconcileAppUpdateSelection();
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

type ParsedSemver = {
  core: [number, number, number];
  pre: Array<string | number>;
};

function parseSemver(tag: string | undefined): ParsedSemver | undefined {
  if (!tag) return undefined;
  const trimmed = tag.trim().replace(/^v/i, "");
  const match = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return undefined;
  const [, maj, min, patch, pre] = match;
  return {
    core: [Number(maj), Number(min), Number(patch)],
    pre: pre
      ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : []
  };
}

// Semver 2.0.0 precedence. Returns positive if a > b, negative if a < b.
// Unparseable tags sort below any valid version so they cannot win a "highest"
// selection over a real release.
export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  // A version without prerelease identifiers has higher precedence than one
  // with them (SemVer rule 11).
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (typeof ai === "number" && typeof bi === "number") {
      if (ai !== bi) return ai - bi;
    } else if (typeof ai === "number") {
      return -1;
    } else if (typeof bi === "number") {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

function compareSemverCore(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function firstPrereleaseId(tag: string | undefined): string | undefined {
  const parsed = parseSemver(tag);
  if (!parsed || parsed.pre.length === 0) return undefined;
  return typeof parsed.pre[0] === "string" ? parsed.pre[0] : undefined;
}

function isBetaTrainIdentifier(tag: string | undefined): boolean {
  const id = firstPrereleaseId(tag);
  return id === "alpha" || id === "beta";
}

// Beta slots must never advertise a downgrade from Stable Latest. Historical
// `v1.0.0-beta.N` tags, leftover `v1.1.0-beta.N` after `v1.1.0` is promoted,
// and same-core alphas all lose to the current Latest and stay off the Beta
// train. If there is not yet a GitHub Latest, only an alpha (or a beta that
// has a same-core alpha) counts — a lone `-beta.N` line is the old 1.0 train.
function isBetaTrainRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[]
): boolean {
  if (release.prerelease !== true || !isBetaTrainIdentifier(release.tag_name)) {
    return false;
  }
  if (stableLatest) {
    const releaseParsed = parseSemver(release.tag_name);
    const stableParsed = parseSemver(stableLatest.tag_name);
    return (
      releaseParsed !== undefined &&
      stableParsed !== undefined &&
      compareSemverCore(releaseParsed.core, stableParsed.core) > 0
    );
  }
  if (firstPrereleaseId(release.tag_name) === "alpha") {
    return true;
  }
  const parsed = parseSemver(release.tag_name);
  if (!parsed) return false;
  return releases.some((candidate) => {
    if (candidate.draft === true || candidate.prerelease !== true) return false;
    const other = parseSemver(candidate.tag_name);
    return (
      other !== undefined &&
      compareSemverCore(other.core, parsed.core) === 0 &&
      other.pre[0] === "alpha"
    );
  });
}

function isBetaLatestRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[]
): boolean {
  return (
    firstPrereleaseId(release.tag_name) === "beta" &&
    isBetaTrainRelease(release, stableLatest, releases)
  );
}

export type SelectedUpdateReleases = {
  latest: GitHubRelease | undefined;
  prerelease: GitHubRelease | undefined;
  stableLatest: GitHubRelease | undefined;
  stablePrerelease: GitHubRelease | undefined;
  betaLatest: GitHubRelease | undefined;
  betaPrerelease: GitHubRelease | undefined;
};

// Resolve slots by semver identifier and GitHub Latest, not publish order:
//   - stable latest      → highest GitHub non-prerelease (the 1.0 / normie feed)
//   - stable prerelease  → max(stable latest, 1.0 `-prerelease` / legacy `-beta`)
//   - beta latest        → highest `-beta` whose core is ahead of Stable Latest
//   - beta prerelease    → max(beta latest, highest `-alpha` on a newer core)
// Empty Beta slots stay empty. The Settings Beta control remains selectable
// so an operator can follow the next `main` tag after a Stable promotion.
export function selectChannelReleases(releases: GitHubRelease[]): SelectedUpdateReleases {
  const publicReleases = releases.filter((release) => release.draft !== true);
  const byPrecedenceDesc = [...publicReleases].sort((a, b) =>
    compareSemver(b.tag_name, a.tag_name)
  );
  const stableLatest = byPrecedenceDesc.find((release) => release.prerelease !== true);
  const betaLatest = byPrecedenceDesc.find((release) =>
    isBetaLatestRelease(release, stableLatest, publicReleases)
  );
  const stablePrerelease = byPrecedenceDesc.find((release) => {
    if (release === stableLatest) return true;
    if (release.prerelease !== true) return false;
    if (firstPrereleaseId(release.tag_name) === "alpha") return false;
    return !isBetaLatestRelease(release, stableLatest, publicReleases);
  });
  const betaPrerelease = byPrecedenceDesc.find((release) =>
    isBetaTrainRelease(release, stableLatest, publicReleases)
  );
  return {
    latest: stableLatest,
    prerelease: stablePrerelease,
    stableLatest,
    stablePrerelease,
    betaLatest,
    betaPrerelease
  };
}

function hasUploadedReleaseAsset(
  release: GitHubRelease,
  predicate: (assetName: string) => boolean
): boolean {
  return (
    release.assets?.some((asset) => {
      if (!asset.name || asset.state === "deleted") return false;
      return predicate(asset.name);
    }) ?? false
  );
}

function hasPlatformUpdateAssets(release: GitHubRelease): boolean {
  if (process.platform === "win32") {
    const hasChannelFile = hasUploadedReleaseAsset(
      release,
      (name) => name === WIN_UPDATE_CHANNEL_FILE
    );
    const hasInstaller = hasUploadedReleaseAsset(
      release,
      (name) => name.endsWith(".exe") || name.endsWith(".nsis")
    );
    return hasChannelFile && hasInstaller;
  }
  const hasChannelFile = hasUploadedReleaseAsset(
    release,
    (name) => name === MAC_UPDATE_CHANNEL_FILE
  );
  const hasZip = hasUploadedReleaseAsset(release, (name) => name.endsWith(".zip"));
  return hasChannelFile && hasZip;
}

export function selectAppUpdateReleases(releases: GitHubRelease[]): SelectedUpdateReleases {
  return selectChannelReleases(releases.filter(hasPlatformUpdateAssets));
}

function releaseForSelection(
  selected: SelectedUpdateReleases,
  selection: UpdateSelection
): GitHubRelease | undefined {
  if (selection.train === "beta") {
    return selection.channel === "prerelease" ? selected.betaPrerelease : selected.betaLatest;
  }
  return selection.channel === "prerelease" ? selected.stablePrerelease : selected.stableLatest;
}

function githubReleaseHeaders(etag?: string): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrSnap",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    // A conditional request that answers 304 is not charged against the
    // GitHub rate limit, so revalidating a cached list stays free while
    // nothing new has shipped.
    ...(etag ? { "If-None-Match": etag } : {})
  };
}

function readResponseHeader(response: Response, name: string): string | undefined {
  return response.headers?.get?.(name) ?? undefined;
}

function rateLimitedError(resetAt: number): Error {
  const resumesAt = new Date(resetAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });
  return new Error(`GitHub rate limit reached. Update checks resume at ${resumesAt}.`);
}

/** A bare 403 reads like an auth failure, but anonymously we are far more
 *  likely to have spent the hourly quota. Record the reset time so later
 *  reads back off instead of digging the hole deeper. */
function releaseRequestError(response: Response): Error {
  const status = response.status;
  const rateLimited =
    (status === 403 || status === 429) &&
    readResponseHeader(response, "x-ratelimit-remaining") === "0";
  if (!rateLimited) {
    return new Error(`GitHub releases request failed with ${status}`);
  }
  const resetSeconds = Number(readResponseHeader(response, "x-ratelimit-reset"));
  rateLimitResetAt =
    Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1_000
      : Date.now() + RATE_LIMIT_FALLBACK_BACKOFF_MS;
  log.warn("GitHub release rate limit reached", {
    resetAt: new Date(rateLimitResetAt).toISOString(),
    status
  });
  return rateLimitedError(rateLimitResetAt);
}

type GitHubJsonResult =
  | { notModified: true }
  | { etag: string | undefined; notModified: false; payload: unknown };

async function fetchGitHubJson(
  url: string,
  signal?: AbortSignal,
  etag?: string
): Promise<GitHubJsonResult> {
  const response = await fetch(url, {
    headers: githubReleaseHeaders(etag),
    ...(signal ? { signal } : {})
  });
  if (response.status === 304) {
    return { notModified: true };
  }
  if (!response.ok) {
    throw releaseRequestError(response);
  }
  return {
    etag: readResponseHeader(response, "etag"),
    notModified: false,
    payload: await response.json()
  };
}

function asGitHubRelease(value: unknown): GitHubRelease | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const release = value as GitHubRelease;
  return release.tag_name ? release : undefined;
}

function asGitHubReleaseList(value: unknown): GitHubRelease[] {
  return Array.isArray(value)
    ? value.filter(
        (release): release is GitHubRelease => typeof release === "object" && release !== null
      )
    : [];
}

type LatestReleaseResult =
  | { notModified: true }
  | { etag: string | undefined; notModified: false; release: GitHubRelease | undefined };

// GitHub Latest is a separate endpoint because `/releases` is newest-first
// and a long run of alpha/beta tags can push Stable Latest off the first
// page. We also page until that Latest tag appears so Stable Prerelease
// and Beta slots still see everything newer than it.
async function fetchLatestGitHubRelease(
  signal?: AbortSignal,
  etag?: string
): Promise<LatestReleaseResult | undefined> {
  try {
    const result = await fetchGitHubJson(GITHUB_LATEST_RELEASE_URL, signal, etag);
    return result.notModified
      ? result
      : { etag: result.etag, notModified: false, release: asGitHubRelease(result.payload) };
  } catch {
    return undefined;
  }
}

function releasesPageUrl(page: number): string {
  return `${GITHUB_RELEASES_URL}?per_page=${RELEASE_PAGE_SIZE}&page=${page}`;
}

type ReleaseListFetch =
  | { notModified: true }
  | {
      etags: Record<string, string>;
      latest: GitHubRelease | undefined;
      notModified: false;
      releases: GitHubRelease[];
    };

async function fetchGitHubReleases(signal?: AbortSignal): Promise<ReleaseListFetch> {
  const cachedEtags = releaseCache?.etags ?? {};
  const etags: Record<string, string> = { ...cachedEtags };
  const latestPromise = fetchLatestGitHubRelease(signal, cachedEtags[GITHUB_LATEST_RELEASE_URL]);
  const collected: GitHubRelease[] = [];
  const seen = new Set<string>();
  const add = (release: GitHubRelease | undefined): void => {
    if (!release?.tag_name || seen.has(release.tag_name)) return;
    seen.add(release.tag_name);
    collected.push(release);
  };
  let latestRelease: GitHubRelease | undefined;

  for (let page = 1; page <= RELEASE_MAX_PAGES; page++) {
    const url = releasesPageUrl(page);
    // Only page 1 is revalidated conditionally. Pages past it are only ever
    // requested when the newest page moved, so a conditional request there
    // would answer 200 anyway.
    const pagePromise = fetchGitHubJson(url, signal, page === 1 ? cachedEtags[url] : undefined);
    let pageResult: GitHubJsonResult;
    if (page === 1) {
      const [latest, firstPage] = await Promise.all([latestPromise, pagePromise]);
      pageResult = firstPage;
      if (latest !== undefined && !latest.notModified) {
        latestRelease = latest.release;
        if (latest.etag !== undefined) etags[GITHUB_LATEST_RELEASE_URL] = latest.etag;
      }
      // Falls back to the cached tag on a 304, on a failed request, and on an
      // unparseable body alike. Without a terminator the loop walks all
      // RELEASE_MAX_PAGES pages — 10 requests from the very budget this cache
      // exists to protect. The cached tag is a conservative stand-in: it is no
      // newer than the true latest, so stopping there still collects
      // everything newer than it.
      latestRelease ??= releaseCache?.latest;
    } else {
      pageResult = await pagePromise;
    }

    if (pageResult.notModified) {
      // The newest page is unchanged, so every older page is too — the whole
      // cached list still stands. (Only reachable with a cache to stand on,
      // since the etag that earns the 304 comes from one.)
      if (releaseCache) return { notModified: true };
      break;
    }
    if (pageResult.etag !== undefined) etags[url] = pageResult.etag;

    const pageReleases = asGitHubReleaseList(pageResult.payload);
    for (const release of pageReleases) add(release);
    // Test BEFORE folding `latest` in, or `add` seeds `seen` with the very
    // tag we are looking for and the loop always breaks on page 1.
    const reachedLatest = latestRelease?.tag_name !== undefined && seen.has(latestRelease.tag_name);
    add(latestRelease);
    if (reachedLatest) break;
    if (pageReleases.length < RELEASE_PAGE_SIZE) break;
  }

  add(latestRelease);
  return { etags, latest: latestRelease, notModified: false, releases: collected };
}

async function refreshGitHubReleases(): Promise<GitHubRelease[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const result = await fetchGitHubReleases(controller.signal);
    if (result.notModified) {
      const cached = releaseCache;
      if (cached) {
        releaseCache = { ...cached, fetchedAt: Date.now() };
        rateLimitResetAt = undefined;
        return cached.releases;
      }
      return [];
    }
    releaseCache = {
      etags: result.etags,
      fetchedAt: Date.now(),
      latest: result.latest,
      releases: result.releases
    };
    rateLimitResetAt = undefined;
    return result.releases;
  } finally {
    clearTimeout(timeout);
  }
}

/** E2E launches set `NODE_ENV=production` so the app boots its production
 *  paths, which leaves the GitHub release reads live. The bootstrap already
 *  skips `initAppUpdater` under `PWRSNAP_E2E=1`, but the `app:update:*` bus
 *  verbs stay registered, and `settings:open` with no page mounts
 *  Settings -> General, which reads the release list on mount. Every spinup
 *  would spend from the 60-requests-per-hour anonymous GitHub budget that
 *  the whole runner shares — and make the four channel slots depend on live
 *  network state. The block sits at the one function every read funnels
 *  through so no caller has to remember it. */
function releaseReadsDisabled(): boolean {
  return process.env.PWRSNAP_E2E === "1" || isWindowsUpdateSmokeRequested();
}

/**
 * Single owner of the GitHub release list. Every caller in main goes through
 * this cache, and the renderer only ever reads it over the command bus, so
 * opening Settings costs no network request.
 */
async function readGitHubReleases(
  maxAgeMs = APP_UPDATE_RELEASE_CACHE_TTL_MS
): Promise<GitHubRelease[]> {
  if (releaseReadsDisabled()) {
    return [];
  }
  const now = Date.now();
  if (releaseCache && now - releaseCache.fetchedAt < maxAgeMs) {
    return releaseCache.releases;
  }
  if (rateLimitResetAt !== undefined && now < rateLimitResetAt) {
    // Spending a request GitHub will only reject deepens the hole. Serve the
    // last good list when we have one.
    if (releaseCache) {
      return releaseCache.releases;
    }
    throw rateLimitedError(rateLimitResetAt);
  }
  if (!releaseFetchInFlight) {
    releaseFetchInFlight = refreshGitHubReleases().finally(() => {
      releaseFetchInFlight = undefined;
    });
  }
  return await releaseFetchInFlight;
}

async function readAppUpdateReleaseForSelection(
  selection: UpdateSelection,
  maxAgeMs?: number
): Promise<GitHubRelease | undefined> {
  const releases = await readGitHubReleases(maxAgeMs);
  return releaseForSelection(selectAppUpdateReleases(releases), selection);
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  try {
    const releases = await readGitHubReleases();
    const selected = selectAppUpdateReleases(releases);
    return {
      fetchedAt: releaseCache?.fetchedAt ?? Date.now(),
      stable: {
        latest: releaseInfoFromGitHubRelease(
          selected.stableLatest,
          "No stable release found."
        ),
        prerelease: releaseInfoFromGitHubRelease(
          selected.stablePrerelease,
          "No stable prerelease found."
        )
      },
      beta: {
        latest: releaseInfoFromGitHubRelease(selected.betaLatest, "No beta release found."),
        prerelease: releaseInfoFromGitHubRelease(
          selected.betaPrerelease,
          "No beta prerelease found."
        )
      }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = { unavailableReason: message };
    return {
      fetchedAt: Date.now(),
      stable: { latest: unavailable, prerelease: unavailable },
      beta: { latest: unavailable, prerelease: unavailable }
    };
  }
}

export function readAppUpdateStatus(): AppUpdateStatus {
  reconcileAppUpdateSelection();
  return updateStatus;
}

type DownloadedUpdateInstallMode = "user" | "windows-update-smoke";

async function installDownloadedAppUpdateForMode(
  mode: DownloadedUpdateInstallMode
): Promise<AppUpdateInstallResult> {
  const retrySelection = installRetrySelection();
  const currentSelection = currentUpdateSelection();
  const eligibleDownload = downloadedUpdateMatchesSelection(currentUpdateSelectionKey());
  let version = eligibleDownload?.version ?? (retrySelection ? installableUpdateVersion() : undefined);
  if (!version) {
    return {
      status: "error",
      message: heldDownloadedUpdate
        ? "The downloaded update is not for the selected channel."
        : "No downloaded update is ready to install."
    };
  }
  const smoke = windowsUpdateSmokeConfig();
  if (mode === "windows-update-smoke" && smoke === undefined) {
    return {
      status: "error",
      message: "Windows updater smoke install requires validated smoke configuration."
    };
  }
  if (mode === "user" && smoke !== undefined) {
    return {
      status: "error",
      message: "Windows updater smoke must use its dedicated silent install path."
    };
  }
  if (smoke !== undefined && version !== smoke.targetVersion) {
    return {
      status: "error",
      message: `Windows updater smoke refuses to install ${version}; expected ${smoke.targetVersion}.`
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
    if (retrySelection !== undefined) {
      log.info("retrying failed app update install by refreshing update payload", {
        version,
        updateChannel: retrySelection.channel,
        updateTrain: retrySelection.train
      });
      const retryResult = await checkForAppUpdatesNow("manual", retrySelection);
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
    log.info("installing downloaded update", { version, mode });
    const recordedAttempt = recordInstallAttempt(
      version,
      retrySelection ?? currentSelection
    );
    if (smoke !== undefined && recordedAttempt === undefined) {
      return {
        status: "error",
        message:
          "Windows updater smoke could not persist its install-attempt marker; refusing to restart."
      };
    }
    if (mode === "windows-update-smoke") {
      // PwrSnap ships assisted NSIS (`oneClick: false`). The default
      // quitAndInstall() call displays that installer and waits for user input,
      // which a credential-free hosted smoke runner cannot provide. Keep the
      // user-facing path interactive, but make this marker-gated headless path
      // silent. The outer harness owns the target relaunch so it can preserve
      // the exact isolated environment; NSIS uses ExecShellAsUser for its
      // force-run path, which does not reliably retain caller-only variables
      // such as PWRSNAP_USER_DATA on hosted Windows runners.
      autoUpdater().quitAndInstall(true, false);
    } else {
      autoUpdater().quitAndInstall();
    }
    return { status: "restarting" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateInstallResult> {
  return await installDownloadedAppUpdateForMode("user");
}

export async function installDownloadedWindowsUpdateSmoke(): Promise<AppUpdateInstallResult> {
  return await installDownloadedAppUpdateForMode("windows-update-smoke");
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
  autoUpdater().autoInstallOnAppQuit = windowsUpdateSmokeConfig() === undefined;
  configureAutoUpdaterChannel();
  const pendingInstallFailed = reconcilePendingInstallAttemptOnBoot();
  reconcileAppUpdateSelection();

  autoUpdater().on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatusUnlessActionable({ status: "checking" });
  });
  autoUpdater().on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    if (!acceptWindowsUpdateSmokeEventVersion("update-available", info.version)) return;
    recordPendingDownloadSelection(info.version, updateCheckSelectionInFlight);
    const isDowngrade = downgradeCheckInFlight || pendingDowngradeVersions.has(info.version);
    // Re-key on what the event actually reported so `update-downloaded`,
    // which lands well after the check has finished, still sees it.
    if (isDowngrade && info.version) pendingDowngradeVersions.add(info.version);
    setUpdateStatus({
      status: "available",
      version: info.version,
      ...(isDowngrade ? ({ downgrade: true } as const) : {})
    });
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
    const inProgress =
      updateStatus.status === "available" || updateStatus.status === "downloading"
        ? updateStatus
        : undefined;
    const version = inProgress?.version ?? "unknown";
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent),
      ...(inProgress?.downgrade === true ? ({ downgrade: true } as const) : {})
    });
  });
  autoUpdater().on("update-downloaded", (info) => {
    log.info("update-downloaded", { version: info.version });
    if (!acceptWindowsUpdateSmokeEventVersion("update-downloaded", info.version)) return;
    const selection = info.version
      ? (pendingDownloadSelectionsByVersion.get(info.version) ?? currentUpdateSelectionKey())
      : undefined;
    const isDowngrade = info.version ? pendingDowngradeVersions.has(info.version) : false;
    if (info.version) {
      pendingDownloadSelectionsByVersion.delete(info.version);
      pendingDowngradeVersions.delete(info.version);
    }
    if (info.version && selection) {
      heldDownloadedUpdate = {
        selection,
        version: info.version,
        ...(isDowngrade ? ({ downgrade: true } as const) : {})
      };
    }
    reconcileAppUpdateSelection();
  });
  autoUpdater().on("error", (err: Error) => {
    log.warn("auto-update error", { message: err.message });
    setUpdateStatusUnlessActionable({ status: "error", message: err.message });
  });

  if (windowsUpdateSmokeConfig() === undefined) {
    startPeriodicUpdateChecks();
  }
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
  heldDownloadedUpdate = undefined;
  heldInstallFailed = undefined;
  pendingDownloadSelectionsByVersion.clear();
  pendingDowngradeVersions.clear();
  downgradeCheckInFlight = false;
  for (const waiter of retryDownloadWaiters) {
    clearTimeout(waiter.timer);
  }
  retryDownloadWaiters.clear();
  releaseCache = undefined;
  releaseFetchInFlight = undefined;
  rateLimitResetAt = undefined;
}
