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
  AppUpdateCancelResult,
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

let warnedAboutUnavailableAutoUpdater = false;

/**
 * The same lazy access, for the paths that must survive not getting one.
 *
 * That constructor parses `app.getVersion()` and THROWS
 * `ERR_UPDATER_INVALID_VERSION` for anything that is not semver — and an
 * unpackaged Electron on Linux reports `"0.0"`. Nothing in such a build can
 * auto-update anyway, so a status read (or the dev/QA fake, which reconciles
 * its held download the same way a real one does) must not blow up on it.
 * Reads that only make sense against a real updater keep using
 * `autoUpdater()` directly.
 */
function optionalAutoUpdater(): typeof electronUpdater.autoUpdater | undefined {
  try {
    return autoUpdater();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Expected in a build that could not auto-update anyway, and noisy on
    // every status read — so say it once. A PACKAGED build failing here is a
    // real fault (a downloaded update will not install on quit, because
    // `syncAutoInstallOnAppQuit` has nothing to set), and muffling that to a
    // single warn for the life of the process would hide it: log every time,
    // at error.
    if (!devFakeUpdateCheckEnabled()) {
      log.error("electron-updater is unavailable in this build", { message });
      return undefined;
    }
    if (!warnedAboutUnavailableAutoUpdater) {
      warnedAboutUnavailableAutoUpdater = true;
      log.warn("electron-updater is unavailable in this build", { message });
    }
    return undefined;
  }
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
/** Long enough to watch each transition land, short enough not to feel hung. */
const DEV_FAKE_UPDATE_DEFAULT_STEP_MS = 300;
/** Percent ticks the fake download reports. Enough of them that the meter is
 *  visibly a meter and the Cancel button has a window to be pressed in. */
const DEV_FAKE_UPDATE_PERCENT_STEPS = [0, 15, 34, 58, 79, 93, 100];
/** A plausible universal-mac zip, so the byte line is exercised too. */
const DEV_FAKE_UPDATE_TOTAL_BYTES = 186_000_000;

/** e2e seam, alongside `PWRSNAP_E2E_SETTINGS_READ_DELAY_MS`. The Cancel
 *  button only exists while a download is mid-flight, and at the dev pace
 *  that window is a couple of seconds — comfortable by hand, a race on a
 *  loaded CI runner. The spec widens it rather than asserting something
 *  weaker. Only ever read on a fake check. */
function devFakeUpdateStepMs(): number {
  const raw = Number(process.env.PWRSNAP_E2E_UPDATE_STEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEV_FAKE_UPDATE_DEFAULT_STEP_MS;
}

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
/**
 * The download the user can still stop.
 *
 * Held rather than derived because `cancel` has to reach electron-updater's
 * own cancellation token, and because the rejection that token produces is
 * indistinguishable from a network failure unless we remember that we were
 * the ones who asked.
 *
 * Registered as soon as a download is OFFERED — not when the bytes start
 * moving. The live update card offers Cancel from `available` onwards, so
 * anything later leaves a window in which the button is on screen and does
 * nothing: the click marks the card `canceling`, finds no download here, and
 * the update installs anyway. `cancel` is therefore a mutable slot, filled in
 * once electron-updater hands over its token.
 */
type ActiveDownload = {
  version: string;
  downgrade?: true;
  cancel: () => void;
  /** Set by `cancelAppUpdateDownload`, read wherever the download can stop. */
  canceled: boolean;
};

let activeDownload: ActiveDownload | undefined;
/** How many user-initiated checks are in flight. See
 *  `isUserUpdateCheckRunning`. A COUNT, not a flag: the menu item has no
 *  disabled state, so two clicks give two `runMenuUpdateCheck` frames, and a
 *  boolean would be cleared by whichever finished first while the other was
 *  still holding the live card open. Only `runMenuUpdateCheck` moves it. */
let userCheckDepth = 0;

/** Take a cancel the user asked for before there was anything to ask. Called
 *  wherever a download becomes stoppable, so a click that landed early is
 *  honoured instead of dropped. */
function applyPendingCancel(download: ActiveDownload): void {
  if (!download.canceled) return;
  try {
    download.cancel();
  } catch (err) {
    log.warn("failed to apply a cancel requested before the download started", {
      message: err instanceof Error ? err.message : String(err)
    });
  }
}

/** The `canceled` status for a download, carrying its switch-back flag so the
 *  renderer words a stopped downgrade as a switch rather than an update. */
function canceledStatusFor(
  download: Pick<ActiveDownload, "version" | "downgrade">
): Extract<AppUpdateStatus, { status: "canceled" }> {
  return {
    status: "canceled",
    version: download.version,
    ...(download.downgrade === true ? ({ downgrade: true } as const) : {})
  };
}

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
 *  Kept as a callback rather than importing the settings store
 *  directly so this module stays testable + free of the singleton
 *  graph. Installed synchronously by `initAppUpdater` before its first check. */
export function setUpdateSelectionResolver(fn: SelectionResolver): void {
  resolveSelection = fn;
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
      waiter.resolve({
        status: "downloaded",
        version: nextStatus.version,
        ...(nextStatus.downgrade === true ? ({ downgrade: true } as const) : {})
      });
    } else if (
      nextStatus.status === "canceled" &&
      nextStatus.version === waiter.expectedVersion
    ) {
      // A stopped download is an outcome like any other: the waiter is what
      // holds the live card open, and leaving it armed would keep a progress
      // card on screen for bytes that stopped moving when the user said so.
      //
      // Matched on version for the same reason `downloaded` is: a late abort
      // of some OTHER version (a downgrade the user stopped earlier) must not
      // answer this waiter, or the live card comes down mid-download and the
      // notice names a release nobody was fetching.
      clearTimeout(waiter.timer);
      retryDownloadWaiters.delete(waiter);
      waiter.resolve({
        status: "canceled",
        version: nextStatus.version,
        ...(nextStatus.downgrade === true ? ({ downgrade: true } as const) : {})
      });
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

/** Park until the download of `expectedVersion` settles — downloaded, error,
 *  canceled, or a check that decided there was nothing after all. Shared by
 *  the failed-install retry path and by `runMenuUpdateCheck`, which must not
 *  report an outcome while the bytes the user is watching are still moving. */
function waitForDownloadOutcome(expectedVersion: string): Promise<AppUpdateCheckResult> {
  // Already settled before the caller got here — a fast cancel can beat the
  // check's own resolution by a microtask, and parking on that would hold the
  // live card open for the full five-minute timeout before reporting a
  // failure that never happened.
  if (
    (updateStatus.status === "downloaded" || updateStatus.status === "canceled") &&
    updateStatus.version === expectedVersion
  ) {
    return Promise.resolve({
      status: updateStatus.status,
      version: expectedVersion,
      ...(updateStatus.downgrade === true ? ({ downgrade: true } as const) : {})
    });
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
  autoUpdater().allowPrerelease = selection.train === "beta" || selection.channel === "prerelease";
  // Every check starts from the forward-only posture. `allowDowngrade` is
  // opened for exactly one check, by `allowAutoUpdaterDowngrade`, once we
  // have decided the selected release is behind the running build.
  autoUpdater().allowDowngrade = false;
  log.info("configured auto-update channel", {
    allowDowngrade: autoUpdater().allowDowngrade,
    allowPrerelease: autoUpdater().allowPrerelease,
    updateChannel: selection.channel,
    updateTrain: selection.train
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

function productionUpdatesEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The e2e harness launches with `NODE_ENV=production` (so the renderer runs
 *  the shipped bundle), which would otherwise put a spec on the real
 *  electron-updater path — and `initAppUpdater` is skipped there, so nothing
 *  would ever move. This opt-in knob puts the fake back, per launch, the same
 *  way the other fault-injection env vars work. Gated on `PWRSNAP_E2E` so it
 *  can never be reached from a packaged build. */
function devFakeUpdateForced(): boolean {
  return process.env.PWRSNAP_E2E === "1" && process.env.PWRSNAP_E2E_UPDATE_FAKE === "1";
}

/** Whether a check should walk the fake status machine rather than reach
 *  electron-updater. Real auto-update runs in packaged builds only. */
function devFakeUpdateCheckEnabled(): boolean {
  return !productionUpdatesEnabled() || devFakeUpdateForced();
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
    nextStatus.status === "canceled" ||
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
  const matching = downloadedUpdateMatchesSelection(updateSelection);
  // Stepping the installed build BACKWARD is heavier than a forward update
  // and the user only ever asked to see what was available. Hold it for the
  // explicit Restart in the banner rather than applying it on the next quit
  // — dismissing that banner hides the notice, it does not decline the move.
  const updater = optionalAutoUpdater();
  if (updater === undefined) return;
  updater.autoInstallOnAppQuit =
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
    const currentVersion = optionalAutoUpdater()?.currentVersion?.version ?? currentAppVersion();
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

/** What `autoUpdater.checkForUpdates()` hands back, narrowed to the fields
 *  that make a download stoppable and name it. Typed structurally so the
 *  shape survives an electron-updater bump that widens the result. */
type UpdateCheckDownloadHandle = {
  cancellationToken?: { cancel: () => void };
  downloadPromise?: Promise<unknown> | null;
  updateInfo?: { version?: string };
};

/**
 * Hand the just-started download its cancellation token, and watch it settle.
 *
 * Unlike PwrGit's updater, `checkForAppUpdatesNow` does NOT await the
 * download — it answers `available` and lets `autoDownload` run on. So the
 * rejection this attaches is also the only thing observing `downloadPromise`
 * at all: without it, every failed or cancelled download is an unhandled
 * rejection.
 */
function adoptDownloadCancellation(
  download: ActiveDownload,
  result: UpdateCheckDownloadHandle | null | undefined
): void {
  const promise = result?.downloadPromise;
  if (!promise) {
    // Nothing started, so there is nothing to stop. Leaving the registration
    // behind would let a later Cancel click claim it stopped a download that
    // never existed.
    if (activeDownload === download) activeDownload = undefined;
    return;
  }
  // The registration was seeded from the release TAG; the event stream uses
  // the version electron-updater read out of the channel file. Those are
  // normally the same and this file already documents that they can drift —
  // so adopt the one the download will actually report itself as.
  download.version = result?.updateInfo?.version ?? download.version;
  const token = result?.cancellationToken;
  download.cancel = () => token?.cancel();
  // A cancel that arrived while the token did not yet exist: honour it now
  // rather than letting the download it asked to stop run to completion.
  applyPendingCancel(download);
  const release = (): void => {
    if (activeDownload === download) activeDownload = undefined;
  };
  void promise.then(release, (err: unknown) => {
    release();
    // A cancel rejects this promise exactly like a failed request would, and
    // electron-updater deliberately does NOT dispatch its `error` event for
    // one (it emits `update-cancelled` instead). Only our own flag separates
    // "the user stopped it" from "the download broke", and dressing the first
    // as a failure would put a danger banner in front of someone who got
    // exactly what they asked for.
    if (download.canceled) {
      // `update-cancelled` normally beats this rejection and has already
      // settled the status; re-setting it would broadcast and relay the same
      // event to every window a second time. This arm is the fallback for a
      // build where that handler was never registered (`initAppUpdater` is
      // skipped outside production and under the e2e harness).
      if (
        updateStatus.status !== "canceled" ||
        updateStatus.version !== download.version
      ) {
        setUpdateStatusUnlessActionable(canceledStatusFor(download));
      }
      log.info("update download canceled", { version: download.version });
      return;
    }
    // A genuine failure already reached the `error` handler through
    // electron-updater's own dispatch; this arm only keeps the rejection from
    // going unhandled.
    log.warn("update download failed", {
      message: err instanceof Error ? err.message : String(err),
      version: download.version
    });
  });
}

export async function checkForAppUpdatesNow(
  trigger: AppUpdateCheckTrigger = "manual",
  selection: UpdateSelection = currentUpdateSelection()
): Promise<AppUpdateCheckResult> {
  if (devFakeUpdateCheckEnabled()) {
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
  // Publish the promise before running any check logic. The downloaded-update
  // fast path (or a synchronous error) can reach finally without an await;
  // an immediately invoked async function would clear the slot before the
  // assignment, then leave its settled promise installed forever.
  updateCheckInFlight = Promise.resolve().then(async (): Promise<AppUpdateCheckResult> => {
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
      // Registered BEFORE the call, not after it: `checkForUpdates` emits
      // `update-available` — the status that puts Cancel on screen — from
      // inside itself, and with `autoDownload` on it has already started
      // fetching by the time it resolves.
      const download: ActiveDownload = {
        version: selectedVersion,
        cancel: () => {},
        canceled: false,
        ...(isDowngrade ? ({ downgrade: true } as const) : {})
      };
      activeDownload = download;
      let result;
      try {
        result = await autoUpdater().checkForUpdates();
      } catch (err) {
        // The check itself blew up, so no download was ever offered — drop
        // the registration rather than leaving a Cancel target behind.
        if (activeDownload === download) activeDownload = undefined;
        throw err;
      }
      adoptDownloadCancellation(download, result);
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
  });

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
    const stepMs = devFakeUpdateStepMs();
    setUpdateStatus({ status: "checking" });
    await delay(stepMs);
    // The fake has no request to abort, so its cancel is the flag alone — but
    // it must be registered at the same point, and read at the same cadence,
    // a real download's is, or the Cancel button is only ever exercised
    // against production code nobody can run in `pnpm dev`. Registered before
    // `available`, which is the status that puts the button on screen.
    const download: ActiveDownload = { version, cancel: () => {}, canceled: false };
    activeDownload = download;
    const canceled = canceledStatusFor(download);
    try {
      setUpdateStatus({ status: "available", version });
      await delay(stepMs);
      for (const percent of DEV_FAKE_UPDATE_PERCENT_STEPS) {
        if (download.canceled) {
          setUpdateStatusUnlessActionable(canceled);
          return canceled;
        }
        setUpdateStatus({
          status: "downloading",
          version,
          percent,
          transferred: Math.round((DEV_FAKE_UPDATE_TOTAL_BYTES * percent) / 100),
          total: DEV_FAKE_UPDATE_TOTAL_BYTES
        });
        await delay(stepMs);
      }
      // Once more after the loop: a cancel during the last step would
      // otherwise be dropped, and the preview would offer a Restart for an
      // update the user had just declined.
      if (download.canceled) {
        setUpdateStatusUnlessActionable(canceled);
        return canceled;
      }
    } finally {
      if (activeDownload === download) activeDownload = undefined;
    }
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
      if (!asset.name || (asset.state !== undefined && asset.state !== "uploaded")) return false;
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
  // Universal is the compatibility fallback for Intel and historical clients.
  // An ARM64-only or unrelated ZIP must not make a release eligible.
  const hasZip = hasUploadedReleaseAsset(release, (name) => name.endsWith("-universal-mac.zip"));
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
  return process.env.PWRSNAP_E2E === "1";
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

/** Broadcast on the user-initiated channel. See `EVENT_CHANNELS
 *  .appUpdateCheckResult`: this fires for Help -> Check for Updates and
 *  nothing else, which is what keeps the live progress card silent for the
 *  hourly background checks that move the same statuses. */
function emitUpdateCheckResult(result: AppUpdateCheckResult): void {
  broadcastRendererEventToLocalWindows(EVENT_CHANNELS.appUpdateCheckResult, result);
  relayRendererEventToPeer(EVENT_CHANNELS.appUpdateCheckResult, result);
}

/**
 * Help -> Check for Updates.
 *
 * Wraps `checkForAppUpdatesNow("menu")` with the one thing the status channel
 * cannot say: somebody is waiting for this answer. `checking` goes out first
 * so the live card is on screen for the whole release read, and the outcome
 * goes out last.
 *
 * `available` is NOT an outcome here. This app's check settles the moment
 * electron-updater accepts the release, and `autoDownload` is on — so at
 * `available` the download the user is watching has only just started. Report
 * it as finished and the card comes down with the whole download still to
 * run, which is the defect this channel exists to fix.
 */
export async function runMenuUpdateCheck(): Promise<AppUpdateCheckResult> {
  userCheckDepth += 1;
  emitUpdateCheckResult({ status: "checking" });
  try {
    let result: AppUpdateCheckResult;
    try {
      result = await checkForAppUpdatesNow("menu");
    } catch (err) {
      result = {
        status: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
    const settled =
      result.status === "available" ? await waitForDownloadOutcome(result.version) : result;
    emitUpdateCheckResult(settled);
    return settled;
  } finally {
    userCheckDepth = Math.max(0, userCheckDepth - 1);
  }
}

/**
 * Whether a check the user asked for is still running.
 *
 * The `checking` tick above is edge-triggered and never replayed, so a window
 * that subscribes a moment late misses the entire check — and React flushes
 * passive effects AFTER paint, which makes that gap reachable even for a
 * window that was already on screen when the menu item was picked. This is
 * the mount-time snapshot, the same shape of answer `readAppUpdateStatus`
 * gives a renderer that mounts mid-download.
 */
export function isUserUpdateCheckRunning(): boolean {
  return userCheckDepth > 0;
}

/**
 * Stop the download the live update card is reporting.
 *
 * `canceled: false` is the ordinary race, not a fault: the download finished
 * (or never started) while the click was in flight. The caller has a check
 * result coming either way, so there is nothing for it to do about that.
 */
export function cancelAppUpdateDownload(): AppUpdateCancelResult {
  const download = activeDownload;
  if (!download || download.canceled) return { canceled: false };
  download.canceled = true;
  log.info("canceling update download", { version: download.version });
  // The flag is set first and unconditionally: `cancel` may still be the empty
  // slot an offered-but-not-yet-started download carries, and it may throw
  // (the token is electron-updater's). Either way the download's own
  // rejection must still read as a cancel rather than as a network failure.
  applyPendingCancel(download);
  return { canceled: true };
}

export async function installDownloadedAppUpdate(): Promise<AppUpdateInstallResult> {
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
  if (devFakeUpdateCheckEnabled()) {
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
          ? await waitForDownloadOutcome(retryResult.version)
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
    recordInstallAttempt(version, retrySelection ?? currentSelection);
    autoUpdater().quitAndInstall();
    return { status: "restarting" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err)
    };
  }
}

export function initAppUpdater(selectionResolver: SelectionResolver): void {
  if (initialized) return;
  // Bootstrap must provide the live settings reader before any channel
  // configuration or automatic check; asynchronous hotkey wiring is too late.
  setUpdateSelectionResolver(selectionResolver);
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
  reconcileAppUpdateSelection();

  autoUpdater().on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatusUnlessActionable({ status: "checking" });
  });
  autoUpdater().on("update-available", (info) => {
    log.info("update-available", { version: info.version });
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
    // `update-available`'s version first: it is what the event stream itself
    // reported. The registration is only a fallback for a progress tick that
    // arrives before the status has moved.
    const version = inProgress?.version ?? activeDownload?.version ?? "unknown";
    const downgrade = inProgress?.downgrade === true || activeDownload?.downgrade === true;
    // The bytes come along for the meter's label: a percent alone cannot tell
    // a 4 MB delta apart from a 200 MB full download, and on a slow link that
    // difference is the whole question of whether waiting is worth it.
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      ...(downgrade ? ({ downgrade: true } as const) : {})
    });
  });
  // electron-updater reports its own aborts here and, deliberately, not
  // through `error`. Settling on `canceled` rather than back on `available`
  // keeps Settings from promising a download that is no longer running.
  autoUpdater().on("update-cancelled", (info) => {
    const version = info?.version ?? activeDownload?.version ?? "unknown";
    log.info("update-cancelled", { version });
    const downgrade =
      (info?.version !== undefined && pendingDowngradeVersions.has(info.version)) ||
      activeDownload?.downgrade === true;
    if (info?.version) {
      pendingDownloadSelectionsByVersion.delete(info.version);
      pendingDowngradeVersions.delete(info.version);
    }
    activeDownload = undefined;
    setUpdateStatusUnlessActionable(
      canceledStatusFor({ version, ...(downgrade ? ({ downgrade: true } as const) : {}) })
    );
  });
  autoUpdater().on("update-downloaded", (info) => {
    log.info("update-downloaded", { version: info.version });
    activeDownload = undefined;
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
  warnedAboutUnavailableAutoUpdater = false;
  userCheckDepth = 0;
  activeDownload = undefined;
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
