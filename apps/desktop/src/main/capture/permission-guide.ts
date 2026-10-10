// The macOS Screen Recording permission guide.
//
// macOS gives an app no way to add itself to Screen & System Audio Recording
// once the first prompt has been answered. The old recovery opened System
// Settings and told the user to find PwrSnap, which fails in two ways: the
// app may not be listed at all, and with two copies on disk the list shows
// two identical "PwrSnap" rows. So instead PwrSnap opens the pane itself and
// puts a panel beside it that holds the RUNNING bundle as a file drag. The
// user drops it into the list; macOS confirms with Touch ID or a password.
//
// Lifecycle, all main-side:
//   • show  → open the pane, create the panel hidden, start a 500 ms poll.
//   • poll  → find the System Settings window with the window-list helper
//             (bounds are readable without Screen Recording) and keep the
//             panel beside it; read the preflight status.
//   • first show waits for the renderer's first height report (bounded),
//             so the panel never paints at its constructor size and jumps.
//   • granted → tell the renderer, close after GRANTED_CLOSE_MS.
//   • Settings closed after being seen → `settings-closed`, panel stays put.
//
// Dev runs never need this: `pnpm dev` launches Electron from a terminal and
// macOS attributes the capture to the terminal (the responsible process).
// The guide still works there for trying the UI, and says so.

import { app, BrowserWindow, nativeImage, screen, type NativeImage, type WebContents } from "electron";
import { EVENT_CHANNELS, type PermissionGuideState } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { createPermissionGuideWindow } from "../window";
import { listWindowsSnapshot } from "./window-list";
import {
  findSettingsWindow,
  GUIDE_NOTCH_MARGIN_PX,
  planGuidePlacement,
  sameRect,
  type GuideRect
} from "./permission-guide-geometry";
import {
  abbreviateHome,
  appBundlePathFromExe,
  appNameFromBundlePath,
  findOtherCopies
} from "./permission-guide-bundle";
import { openSystemSettingsFor, readScreenStatus } from "../recording/recording-permissions";

const log = getMainLogger("pwrsnap:permission-guide");

/** electron-builder `appId`. Only used to find OTHER copies when packaged. */
const PACKAGED_BUNDLE_ID = "com.pwrdrvr.pwrsnap";
const CARD_WIDTH_PX = 300;
const WINDOW_WIDTH_PX = CARD_WIDTH_PX + 2 * GUIDE_NOTCH_MARGIN_PX;
const INITIAL_HEIGHT_PX = 380;
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_PX = 720;
const POLL_MS = 500;
/** Once Settings has gone away the panel stops moving, so only a reopened
 *  Settings window and the grant are left to notice — no need for 2 Hz. */
const SETTINGS_CLOSED_POLL_MS = 2_000;
/** Settings must be missing this many polls in a row to count as closed —
 *  one empty snapshot is usually a Space switch or a helper hiccup. */
const SETTINGS_MISSING_POLLS = 3;
const FIRST_MEASURE_WAIT_MS = 1_200;
const GRANTED_CLOSE_MS = 2_500;

let guideWindow: BrowserWindow | null = null;
let state: PermissionGuideState | null = null;
let bundlePath: string | null = null;
let dragIcon: NativeImage | null = null;
let contentHeight = INITIAL_HEIGHT_PX;
let settingsRect: GuideRect | null = null;
let settingsSeen = false;
let settingsMissing = 0;
let pollTimer: NodeJS.Timeout | null = null;
let closeTimer: NodeJS.Timeout | null = null;
let measureTimer: NodeJS.Timeout | null = null;
/** The show in progress. Two overlapping calls (a double click, two denied
 *  captures back to back) must not both get past the awaits and build two
 *  windows. */
let showInFlight: Promise<void> | null = null;
let shown = false;
let measured = false;
let polledOnce = false;

export function isPermissionGuideSupported(): boolean {
  return process.platform === "darwin";
}

export function getPermissionGuideState(): PermissionGuideState | null {
  return state;
}

function liveWindow(): BrowserWindow | null {
  return guideWindow !== null && !guideWindow.isDestroyed() ? guideWindow : null;
}

function publish(next: PermissionGuideState): void {
  state = next;
  const win = liveWindow();
  if (win !== null) win.webContents.send(EVENT_CHANNELS.permissionGuideState, next);
}

function update(patch: Partial<PermissionGuideState>): void {
  if (state === null) return;
  publish({ ...state, ...patch });
}

async function readIcon(path: string): Promise<NativeImage | null> {
  try {
    const thumb = await nativeImage.createThumbnailFromPath(path, { width: 128, height: 128 });
    if (!thumb.isEmpty()) return thumb;
  } catch (cause) {
    log.debug("thumbnail icon unavailable", { message: String(cause) });
  }
  try {
    const icon = await app.getFileIcon(path, { size: "large" });
    if (!icon.isEmpty()) return icon;
  } catch (cause) {
    log.debug("file icon unavailable", { message: String(cause) });
  }
  return null;
}

/** Open System Settings at the list and show (or refresh) the guide. */
export function showPermissionGuide(): Promise<void> {
  if (!isPermissionGuideSupported()) {
    return Promise.reject(new Error("The permission guide is macOS-only."));
  }
  if (showInFlight === null) {
    showInFlight = showOrRefresh().finally(() => {
      showInFlight = null;
    });
  }
  return showInFlight;
}

async function showOrRefresh(): Promise<void> {
  await openSystemSettingsFor("screen");

  const existing = liveWindow();
  if (existing !== null && state !== null) {
    // Asked again while open: re-arm, and treat Settings as freshly opened.
    clearCloseTimer();
    settingsSeen = false;
    settingsMissing = 0;
    update({ phase: "waiting" });
    void tick();
    return;
  }

  const exe = app.getPath("exe");
  bundlePath = appBundlePathFromExe(exe) ?? exe;
  const icon = await readIcon(bundlePath);
  dragIcon = icon?.resize({ width: 64, height: 64 }) ?? null;
  state = {
    phase: "waiting",
    appName: appNameFromBundlePath(bundlePath),
    appPath: abbreviateHome(bundlePath),
    appIconDataUrl: icon?.toDataURL() ?? null,
    otherCopies: [],
    packaged: app.isPackaged,
    notch: null
  };
  log.info("showing permission guide", { bundlePath, packaged: app.isPackaged });

  contentHeight = INITIAL_HEIGHT_PX;
  settingsRect = null;
  settingsSeen = false;
  settingsMissing = 0;
  shown = false;
  measured = false;
  polledOnce = false;

  const win = createPermissionGuideWindow({ width: WINDOW_WIDTH_PX, height: contentHeight });
  guideWindow = win;
  win.on("closed", () => {
    if (guideWindow === win) teardown();
  });
  // A crashed renderer leaves a transparent window with nothing painted to
  // click, still taking clicks over its rect. Close it rather than poll on.
  win.webContents.on("render-process-gone", (_event, details) => {
    log.warn("permission guide renderer gone", { reason: details.reason });
    if (guideWindow === win) closePermissionGuide();
  });
  measureTimer = setTimeout(() => {
    measureTimer = null;
    measured = true;
    maybeShow();
  }, FIRST_MEASURE_WAIT_MS);

  schedulePoll(0);

  if (app.isPackaged) {
    const own = bundlePath;
    void findOtherCopies(PACKAGED_BUNDLE_ID, own).then((copies) => {
      if (copies.length === 0 || bundlePath !== own) return;
      log.info("other copies of PwrSnap found", { count: copies.length });
      update({ otherCopies: copies.map((p) => abbreviateHome(p)) });
    });
  }
}

function maybeShow(): void {
  const win = liveWindow();
  if (win === null || shown || !measured || !polledOnce) return;
  shown = true;
  win.showInactive();
}

function schedulePoll(delay: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void tick().finally(() => {
      if (liveWindow() === null) return;
      schedulePoll(state?.phase === "settings-closed" ? SETTINGS_CLOSED_POLL_MS : POLL_MS);
    });
  }, delay);
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking || liveWindow() === null || state === null) return;
  ticking = true;
  try {
    const snapshot = await listWindowsSnapshot();
    if (liveWindow() === null || state === null) return;
    const found = findSettingsWindow(snapshot.windows);
    if (found !== null) {
      settingsSeen = true;
      settingsMissing = 0;
      settingsRect = found;
      if (state.phase === "settings-closed") update({ phase: "waiting" });
    } else {
      settingsMissing += 1;
      if (settingsSeen && settingsMissing >= SETTINGS_MISSING_POLLS && state.phase === "waiting") {
        log.info("System Settings closed while the guide was open");
        settingsRect = null;
        update({ phase: "settings-closed", notch: null });
      }
    }
    place();
    checkGranted();
  } catch (cause) {
    log.warn("permission guide poll failed", { message: String(cause) });
  } finally {
    ticking = false;
    polledOnce = true;
    maybeShow();
  }
}

function place(): void {
  const win = liveWindow();
  if (win === null || state === null) return;
  // Once Settings is gone, stay where the user last saw the panel; only the
  // height follows the content.
  if (state.phase === "settings-closed" && shown) {
    const b = win.getBounds();
    if (b.height !== contentHeight) win.setBounds({ ...b, height: contentHeight });
    return;
  }
  const visible = settingsSeen && settingsMissing === 0 ? settingsRect : null;
  const display = visible !== null
    ? screen.getDisplayMatching(visible)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const plan = planGuidePlacement({
    settings: visible,
    workArea: display.workArea,
    size: { width: WINDOW_WIDTH_PX, height: contentHeight }
  });
  if (!sameRect(win.getBounds(), plan.bounds)) win.setBounds(plan.bounds);
  const notch = plan.notch;
  const prev = state.notch;
  if (notch?.side !== prev?.side || notch?.y !== prev?.y) update({ notch });
}

function checkGranted(): void {
  if (state === null || state.phase === "granted") return;
  if (readScreenStatus() !== "granted") return;
  log.info("Screen Recording granted while the guide was open");
  update({ phase: "granted" });
  clearCloseTimer();
  closeTimer = setTimeout(closePermissionGuide, GRANTED_CLOSE_MS);
}

function clearCloseTimer(): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
}

export function resizePermissionGuide(height: number): void {
  if (!Number.isFinite(height)) return;
  contentHeight = Math.round(Math.min(Math.max(height, MIN_HEIGHT_PX), MAX_HEIGHT_PX));
  place();
  measured = true;
  maybeShow();
}

export async function reopenPermissionGuideSettings(): Promise<void> {
  settingsSeen = false;
  settingsMissing = 0;
  update({ phase: "waiting" });
  await openSystemSettingsFor("screen");
}

export function relaunchFromPermissionGuide(): void {
  log.info("relaunching from the permission guide");
  closePermissionGuide();
  app.relaunch();
  app.quit();
}

export function closePermissionGuide(): void {
  const win = liveWindow();
  teardown();
  if (win !== null) win.destroy();
}

function teardown(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  if (measureTimer !== null) clearTimeout(measureTimer);
  measureTimer = null;
  clearCloseTimer();
  guideWindow = null;
  state = null;
  dragIcon = null;
  bundlePath = null;
}

/**
 * Start the native drag of the running bundle. Only the guide's own
 * WebContents may ask, and it supplies nothing: the path is the one main
 * resolved from the process.
 */
export function startPermissionGuideDrag(sender: WebContents): void {
  const win = liveWindow();
  if (win === null || sender.id !== win.webContents.id || bundlePath === null) {
    log.warn("permission guide drag refused: not the guide window");
    return;
  }
  const icon = dragIcon ?? nativeImage.createEmpty();
  if (icon.isEmpty()) {
    log.warn("permission guide drag refused: no drag icon");
    return;
  }
  sender.startDrag({ file: bundlePath, icon });
}
