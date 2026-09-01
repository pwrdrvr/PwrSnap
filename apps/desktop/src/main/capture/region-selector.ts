// Pre-warmed per-display region-selector windows. Cold BrowserWindow
// creation is 150–400ms; the ⌘⇧P → first-paint budget is 120ms. So
// we create one window per display at boot (`show: false`), rebuild
// on display-config change, and `show()` only the window for the
// display containing the cursor when the shortcut fires. After
// capture, `hide()` rather than destroy.
//
// Per-display windows give selectors that already fit each display's
// coordinate space — no virtual-coord remap needed when the user drags.
// The renderer reports rect coordinates in window-local pixels along
// with the displayId; main converts to global virtual coords on commit.
//
// The windows themselves are frameless, transparent, alwaysOnTop at
// level 'screen-saver', hasShadow:false (window shadow would be
// captured), CSS-only — pure positioning + a 1.5px accent border. NO
// `backdrop-filter` — single biggest cause of jank over Splashtop.

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  MessageChannelMain,
  screen,
  type Display,
  type IpcMainEvent,
  type MessagePortMain,
  type WebContents
} from "electron";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getMainLogger } from "../log";
import { getPreloadPath } from "../window";
import { boundsApproxEqual, listWindowsSnapshot, selfPidSet, type WindowInfo } from "./window-list";
import { captureAndRegister, releaseSnapshot, type ScreenSnapshot } from "./screen-snapshot";
import {
  isRendererOwnedSelectorCaptureEnabled,
  selectorDisplayMediaBroker,
  selectorDisplayMediaStrategy,
  type SelectorDisplayMediaStrategy
} from "./selector-display-media";
import { hideTrayPopoverIfVisible } from "../tray";
import { setFloatOverState, ensureFloatOverTopmost } from "../float-over";
import { hotkeyRecorderSuspension } from "../hotkeys/hotkey-recorder-suspension-instance";
import { SelectorCropReceiver } from "./selector-crop-receiver";
import type { SelectorCropStreamReply } from "@pwrsnap/shared/selector-crop-stream";

const MIN_AREA_PX = 400; // 20×20 — anything smaller isn't a meaningful snap target.
const SELECTOR_WINDOW_TITLE = "PwrSnap Region Selector";

const log = getMainLogger("pwrsnap:region-selector");

const selectorWindows = new Map<number, BrowserWindow>();
const standbySelectorWindows = new Map<number, BrowserWindow>();
const selectorWindowLoads = new WeakMap<BrowserWindow, Promise<boolean>>();
const selectorFrameInvocationIds = new WeakMap<BrowserWindow, number>();
const standbyWarmScheduled = new Set<number>();
const selectorDisplaysNeedingFreshPanel = new Set<number>();
let pendingResolver: ((result: SelectorResult) => void) | null = null;
let pendingInvocationId: number | null = null;
let pendingSelectorMode: SelectorMode | null = null;
let nextInvocationId = 1;
let pickerInvocationActive = false;
let resultListenerAttached = false;
let displayListenersAttached = false;

export type PreviousAppOrigin = "unknown" | "pwrsnap" | "external";

export type PreviousAppContext = {
  previousAppOrigin: PreviousAppOrigin;
  /** Non-null only when `previousAppOrigin === "external"`. */
  previousAppPid: number | null;
};

export type SelectorPresentedEvent = {
  invocationId: number;
  surface: "frozen-frame" | "window-loading" | "error";
};

type ActiveSelectorLifecycle = {
  invocationId: number;
  mode: SelectorMode;
  intent: "snap" | "video";
  targetWindow: BrowserWindow | null;
  targetDisplayId: number | null;
  previousApp: PreviousAppContext;
  windowCandidatesReady: boolean;
  allowedWindowCandidates: Map<
    number,
    {
      rect: { x: number; y: number; w: number; h: number };
      rawRect: { x: number; y: number; w: number; h: number };
    }
  >;
  snapshotDecodeFailed: boolean;
  frameReady: boolean;
  frameAuthorizationRequested: boolean;
  framePort: MessagePortMain | null;
  framePortClosed: boolean;
  cropPort: MessagePortMain | null;
  cropPortClosed: boolean;
  cropPortOpened: boolean;
  cropReceiver: SelectorCropReceiver | null;
  committedCropPath: string | null;
  onSelectorPresented: ((event: SelectorPresentedEvent) => void) | null;
  presentationGeneration: number | null;
  presentationSurface: SelectorPresentedEvent["surface"] | null;
  presentationAcknowledged: boolean;
  presentationTimeout: ReturnType<typeof setTimeout> | null;
  onPresentationAcknowledged: (() => void) | null;
  captureStrategy: SelectorDisplayMediaStrategy;
  settled: boolean;
  terminationResult: Extract<SelectorResult, { ok: false }> | null;
  terminationPromise: Promise<Extract<SelectorResult, { ok: false }>>;
  resolveTermination: ((result: Extract<SelectorResult, { ok: false }>) => void) | null;
  stopAsyncWork: (() => void) | null;
};

let activeSelectorLifecycle: ActiveSelectorLifecycle | null = null;
let nextPresentationGeneration = 1;
let pendingProtectedWindowActivationRestore: BrowserWindow | null = null;

const SELECTOR_FRAME_PORT_CHANNEL = "region-selector:frame-port";
const SELECTOR_FRAME_RELEASE_CHANNEL = "region-selector:frame-release";

/** The capture currently waiting for its snapshot to paint before the
 *  selector is shown. Resolved by the SELECTOR_PAINTED_CHANNEL ack
 *  (matching screenUrl) or by its own timeout. */
type SnapshotPaintOutcome = "painted" | "error" | "timeout" | "superseded";
let pendingPaintWait: {
  screenUrl: string;
  invocationId: number;
  resolve: (outcome: SnapshotPaintOutcome) => void;
} | null = null;

/**
 * Resolve once the renderer acks that the snapshot for `screenUrl` has
 * painted, or after `timeoutMs` — whichever comes first. Never rejects.
 * A new wait supersedes any previous one (the older capture is moot).
 */
function waitForSnapshotPainted(
  screenUrl: string,
  invocationId: number,
  timeoutMs: number
): Promise<SnapshotPaintOutcome> {
  if (pendingPaintWait !== null) {
    const stale = pendingPaintWait;
    pendingPaintWait = null;
    stale.resolve("superseded");
  }
  return new Promise<SnapshotPaintOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SnapshotPaintOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingPaintWait?.resolve === settleResolve) pendingPaintWait = null;
      resolve(outcome);
    };
    const settleResolve = finish;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    pendingPaintWait = { screenUrl, invocationId, resolve: settleResolve };
  });
}

/**
 * Toggle content protection (NSWindow.sharingType=.none on macOS) on a
 * set of windows so they're excluded from the screencapture snapshot
 * without being hidden. Best-effort per window — a destroyed/missing id
 * is skipped. Always cleared (`on=false`) on every snapshot exit path.
 */
function setSnapshotContentProtection(windowIds: readonly number[], on: boolean): void {
  for (const id of windowIds) {
    try {
      const win = BrowserWindow.fromId(id);
      if (win !== null && !win.isDestroyed()) {
        win.setContentProtection(on);
      }
    } catch (err) {
      log.warn("capture window content-protection toggle failed", {
        windowId: id,
        on,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

type SelectorPrewarmReason =
  | "startup"
  | "display-change"
  | "lazy"
  | "rebuild"
  | "standby"
  | "swap-fallback";

type SelectorPrewarmTiming = {
  reason: SelectorPrewarmReason;
  startedAt: number;
  loadedAt: number | null;
};

const selectorPrewarmTimings = new Map<number, SelectorPrewarmTiming>();

// Window list snapshot taken at the moment pickRegion fires. Snap-to-
// window in the renderer hit-tests against this same snapshot; the
// capture handler reuses it after commit to backfill source_app_*.
let lastSnapshot: WindowInfo[] = [];

// Active screen snapshot for the in-flight pickRegion. The selector
// shows this PNG as a full-window background image; the user drags
// against the snapshot, and commit crops the snapshot rather than
// re-shooting the live screen. Released on hide.
let activeScreenSnapshot: ScreenSnapshot | null = null;

type SelectorWindowListBasePayload = {
  windows: {
    windowId: number;
    pid: number;
    bundleId: string | null;
    appName: string | null;
    title: string | null;
    ownedByUs: boolean;
    zIndex: number;
    rect: { x: number; y: number; w: number; h: number };
    rawRect: { x: number; y: number; w: number; h: number };
  }[];
  displayBounds: { width: number; height: number };
  cursor: { x: number; y: number };
};

type SelectorWindowListPayload = SelectorWindowListBasePayload & {
  invocationId: number;
  status: "ready" | "error";
};

export type SelectorResult =
  | {
      ok: true;
      rect: { x: number; y: number; w: number; h: number };
      displayId: number;
      /** Registry id for a frozen-at-show snapshot. Present for auto/
       *  region selection and for protected pure-window invocations.
       *  Unprotected pure window mode deliberately shows its lightweight
       *  live shell without acquiring screen pixels. The
       *  handler crops this snapshot for rect captures and MUST call
       *  `releaseSnapshot(id)` from screen-snapshot.ts after
       *  cropping — ownership transfers from the selector module to
       *  the consumer when this result is produced, so
       *  `hideAllSelectors` skips the cleanup on this code path. */
      screenSnapshotId?: string;
      /** Renderer-owned primary path: PNG containing only the committed
       * selection. Ownership transfers to the image capture handler. */
      committedCropPath?: string;
      /** Pid of the app that was frontmost when the selector opened.
       *  The capture handler activates this app via NSRunningApplication
       *  AFTER the float-over has been populated, so the toast wins
       *  the z-order race against the previous app's frontmost
       *  window. Non-null only when `previousAppOrigin` is
       *  `"external"`. */
      previousAppPid: number | null;
      /** Distinguishes an unresolved/failed enumeration from a known
       *  PwrSnap foreground and a known external foreground. */
      previousAppOrigin: PreviousAppOrigin;
      /** Set when the user committed straight from a window snap (no
       *  drag, no resize). Used for source-app metadata even when
       *  not in full-window mode. */
      snappedWindowId?: number;
      /** True when the user held ⇧ at commit time to opt into the
       *  full-window capture path (`screencapture -l`). Without this
       *  flag main crops the screen snapshot at the rect, which
       *  captures whatever's visible — overlapping windows included,
       *  just like the user sees on screen. */
      fullWindow?: boolean;
      /** Video-only: whether the recording should bake in the mouse
       *  cursor. Set from the selector's `C` toggle (seeded from
       *  `settings.recording.videoCaptureCursor`). Undefined for image
       *  captures, which don't consume it yet (Phase 3). */
      captureCursor?: boolean;
    }
  | {
      ok: false;
      reason: "cancelled" | "destroyed" | "busy";
      /** Same semantics as the OK branch. Non-null only for external. */
      previousAppPid: number | null;
      /** Explicit even on cancellation/lifecycle failure so callers never
       *  infer "PwrSnap" from an ambiguous null pid. */
      previousAppOrigin: PreviousAppOrigin;
    };

const SELECTOR_RESULT_CHANNEL = "region-selector:result";
const SELECTOR_WINDOW_LIST_CHANNEL = "region-selector:window-list";
const SELECTOR_DIAGNOSTICS_CHANNEL = "region-selector:diagnostics";
// Main → renderer: forwarded keystrokes from globalShortcut. The
// renderer's window keydown listener handles them as if the user
// had pressed the key directly — covers the case where macOS
// withholds keyboard events from a newly-shown window.
const SELECTOR_KEY_CHANNEL = "region-selector:key";
// Main → renderer: per-show mode signal. The selector windows are
// pre-warmed at boot (one per display, all loaded with mode=auto in
// the URL hash); we can't reload them on every show without
// destroying the warm-up. Instead we send the desired mode just
// before show() and the renderer flips its UI accordingly. Possible
// values: 'auto' | 'region' | 'window'.
const SELECTOR_MODE_CHANNEL = "region-selector:mode";
// Renderer → main: the renderer fires this once the frozen-snapshot
// <img> for a given screenUrl has loaded/decoded. Main waits for it
// before `win.show()` so the window never appears as an empty
// transparent overlay (which would flash the live screen / desktop
// behind it for a frame before the snapshot paints). Carries the
// screenUrl so a late ack from a previous capture can't satisfy the
// current wait.
const SELECTOR_PAINTED_CHANNEL = "region-selector:painted";
const SELECTOR_PERFORMANCE_CHANNEL = "region-selector:performance";
const SELECTOR_PRESENTATION_ARM_CHANNEL = "region-selector:presentation-arm";
const SELECTOR_PRESENTED_CHANNEL = "region-selector:presented";
const SELECTOR_CROP_PORT_CHANNEL = "region-selector:crop-port";

/** Failure deadlines for the renderer's hidden "snapshot painted" ack.
 *  These do not delay the happy path. A timeout terminates rather than
 *  revealing unverified pixels; the explicit legacy fallback gets the same
 *  generous budget as renderer-owned acquisition so a slow Linux PNG decode
 *  does not become a new 250ms hard failure. */
const LEGACY_SNAPSHOT_PAINT_TIMEOUT_MS = 12_000;
const RENDERER_FRAME_PAINT_TIMEOUT_MS = 12_000;
const SELECTOR_PRESENTATION_ACK_TIMEOUT_MS = 2_000;

export type SelectorMode = "auto" | "region" | "window";

function unknownPreviousApp(): PreviousAppContext {
  return { previousAppOrigin: "unknown", previousAppPid: null };
}

function selectorFailure(
  reason: Extract<SelectorResult, { ok: false }>["reason"],
  previousApp: PreviousAppContext = unknownPreviousApp()
): Extract<SelectorResult, { ok: false }> {
  return { ok: false, reason, ...previousApp };
}

async function raceSelectorTermination<T>(
  lifecycle: ActiveSelectorLifecycle,
  work: Promise<T>
): Promise<
  | { kind: "completed"; value: T }
  | { kind: "terminated"; result: Extract<SelectorResult, { ok: false }> }
> {
  return Promise.race([
    work.then((value) => ({ kind: "completed" as const, value })),
    lifecycle.terminationPromise.then((result) => ({
      kind: "terminated" as const,
      result
    }))
  ]);
}

function isActiveSelectorSender(sender: WebContents, invocationId: number): boolean {
  const lifecycle = activeSelectorLifecycle;
  return (
    lifecycle !== null &&
    lifecycle.invocationId === invocationId &&
    !lifecycle.settled &&
    lifecycle.targetWindow !== null &&
    !lifecycle.targetWindow.isDestroyed() &&
    lifecycle.targetWindow.webContents === sender
  );
}

function takePreviousApp(lifecycle: ActiveSelectorLifecycle): PreviousAppContext {
  const previousApp = lifecycle.previousApp;
  lifecycle.previousApp = unknownPreviousApp();
  return previousApp;
}

function supersedeSelectorWaiters(invocationId?: number): void {
  if (
    pendingPaintWait !== null &&
    (invocationId === undefined || pendingPaintWait.invocationId === invocationId)
  ) {
    const waiter = pendingPaintWait;
    pendingPaintWait = null;
    waiter.resolve("superseded");
  }
}

function releaseActiveScreenSnapshot(): void {
  if (activeScreenSnapshot === null) return;
  const snapshot = activeScreenSnapshot;
  activeScreenSnapshot = null;
  void releaseSnapshot(snapshot.id);
}

function closeRendererFrameSession(
  lifecycle: ActiveSelectorLifecycle,
  removeCommittedCrop: boolean
): void {
  if (lifecycle.presentationTimeout !== null) {
    clearTimeout(lifecycle.presentationTimeout);
    lifecycle.presentationTimeout = null;
  }
  lifecycle.onSelectorPresented = null;
  lifecycle.presentationGeneration = null;
  lifecycle.presentationSurface = null;
  lifecycle.onPresentationAcknowledged = null;
  if (lifecycle.targetWindow !== null && !lifecycle.targetWindow.isDestroyed()) {
    selectorDisplayMediaBroker.revoke(
      lifecycle.targetWindow.webContents.session,
      lifecycle.invocationId
    );
  }
  if (!lifecycle.framePortClosed) {
    lifecycle.framePortClosed = true;
    lifecycle.framePort?.close();
    lifecycle.framePort = null;
  }
  if (!lifecycle.cropPortClosed) {
    lifecycle.cropPortClosed = true;
    lifecycle.cropPort?.close();
    lifecycle.cropPort = null;
  }
  if (lifecycle.cropReceiver !== null) {
    const receiver = lifecycle.cropReceiver;
    lifecycle.cropReceiver = null;
    void receiver.dispose();
  }
  if (removeCommittedCrop && lifecycle.committedCropPath !== null) {
    const path = lifecycle.committedCropPath;
    lifecycle.committedCropPath = null;
    void rm(join(path, ".."), { recursive: true, force: true });
  }
}

function rejectedCrop(invocationId: number): SelectorCropStreamReply {
  return { type: "crop-rejected", invocationId, code: "invalid_crop" };
}

function rejectCropPorts(ports: readonly MessagePortMain[], invocationId: number): void {
  for (const port of ports) {
    port.postMessage(rejectedCrop(invocationId));
    port.close();
  }
}

/**
 * Accept one fresh, invocation-authenticated committed-crop MessagePort.
 *
 * The renderer's long-lived MessagePort remains the narrow capability used to
 * authorize and freeze display media, but Electron 41 on macOS was measured
 * dropping a later crop-start request after the frame had been displayed.
 * The renderer therefore opens this second port only at commit time. Its
 * ArrayBuffer chunks are transferable (unlike ipcRenderer.invoke), bounded to
 * 256 KiB, serialized by renderer backpressure, and accepted only once from
 * the active selector webContents and invocation.
 */
function installRendererCropPort(event: IpcMainEvent, payload: unknown): void {
  const invocationId =
    payload !== null &&
    typeof payload === "object" &&
    "invocationId" in payload &&
    typeof payload.invocationId === "number" &&
    Number.isSafeInteger(payload.invocationId)
      ? payload.invocationId
      : 0;
  const lifecycle = activeSelectorLifecycle;
  const port = event.ports.length === 1 ? event.ports[0] : null;
  if (
    invocationId <= 0 ||
    port === null ||
    lifecycle === null ||
    lifecycle.invocationId !== invocationId ||
    lifecycle.settled ||
    lifecycle.cropPortOpened ||
    !isActiveSelectorSender(event.sender, invocationId) ||
    event.senderFrame !== lifecycle.targetWindow?.webContents.mainFrame
  ) {
    rejectCropPorts(event.ports, invocationId);
    return;
  }
  const receiver = lifecycle.cropReceiver;
  if (
    lifecycle.intent !== "snap" ||
    !lifecycle.frameReady ||
    lifecycle.committedCropPath !== null ||
    receiver === null
  ) {
    rejectCropPorts([port], invocationId);
    return;
  }
  lifecycle.cropPortOpened = true;
  lifecycle.cropPort = port;
  lifecycle.cropPortClosed = false;
  log.info("picker committed crop port connected", {
    invocationId,
    transport: "fresh-message-port"
  });

  port.on("message", (portEvent) => {
    const message = portEvent.data;
    const messageType =
      message !== null && typeof message === "object" && "type" in message
        ? String((message as { type?: unknown }).type)
        : "invalid";
    if (messageType !== "crop-chunk") {
      log.info("picker committed crop message received", {
        invocationId,
        messageType,
        ...(messageType === "crop-start" && message !== null && typeof message === "object"
          ? {
              width: (message as { width?: unknown }).width,
              height: (message as { height?: unknown }).height,
              totalBytes: (message as { totalBytes?: unknown }).totalBytes
            }
          : {})
      });
    }
    void receiver
      .accept(message)
      .then(async (result) => {
        if (
          lifecycle.settled ||
          activeSelectorLifecycle !== lifecycle ||
          lifecycle.committedCropPath !== null ||
          lifecycle.cropReceiver !== receiver
        ) {
          await receiver.dispose();
          if (!lifecycle.cropPortClosed) port.postMessage(rejectedCrop(invocationId));
          return;
        }
        if (result.completedPath !== undefined) {
          const path = receiver.takeCompletedPath();
          if (path === null) {
            await receiver.dispose();
            if (!lifecycle.cropPortClosed) port.postMessage(rejectedCrop(invocationId));
            return;
          }
          lifecycle.committedCropPath = path;
          lifecycle.cropReceiver = null;
          await receiver.dispose();
        }
        if (!lifecycle.cropPortClosed) port.postMessage(result.reply);
      })
      .catch(async (cause: unknown) => {
        log.error("committed renderer crop write failed", {
          invocationId,
          messageType,
          message: cause instanceof Error ? cause.message : String(cause)
        });
        if (lifecycle.cropReceiver === receiver) lifecycle.cropReceiver = null;
        await receiver.dispose();
        if (!lifecycle.cropPortClosed) port.postMessage(rejectedCrop(invocationId));
      });
  });
  port.on("close", () => {
    lifecycle.cropPortClosed = true;
    lifecycle.cropPort = null;
    if (lifecycle.cropReceiver === receiver && lifecycle.committedCropPath === null) {
      lifecycle.cropReceiver = null;
      void receiver.dispose();
    }
  });
  port.start();
  port.postMessage({ type: "crop-port-ready", invocationId });
}

function installRendererFramePort(
  lifecycle: ActiveSelectorLifecycle,
  win: BrowserWindow,
  targetDisplay: Display
): void {
  selectorDisplayMediaBroker.install(win.webContents.session);
  const { port1, port2 } = new MessageChannelMain();
  const cropReceiver = new SelectorCropReceiver(lifecycle.invocationId);
  lifecycle.framePort = port2;
  lifecycle.framePortClosed = false;
  lifecycle.cropReceiver = cropReceiver;
  selectorFrameInvocationIds.set(win, lifecycle.invocationId);

  port2.on("message", (event) => {
    const message = event.data as Record<string, unknown> | null;
    if (
      message === null ||
      typeof message !== "object" ||
      message.invocationId !== lifecycle.invocationId ||
      lifecycle.settled ||
      activeSelectorLifecycle !== lifecycle
    ) {
      return;
    }
    if (message.type === "authorize") {
      if (lifecycle.frameAuthorizationRequested) {
        port2.postMessage({
          type: "authorization-denied",
          invocationId: lifecycle.invocationId
        });
        return;
      }
      lifecycle.frameAuthorizationRequested = true;
      const frame = win.webContents.mainFrame;
      const armed = selectorDisplayMediaBroker.arm(win.webContents.session, {
        invocationId: lifecycle.invocationId,
        displayId: targetDisplay.id,
        displayCount: screen.getAllDisplays().length,
        frame,
        frameUrl: frame.url,
        isStillActive: () =>
          activeSelectorLifecycle === lifecycle && !lifecycle.settled && !win.isDestroyed()
      });
      port2.postMessage({
        type: armed ? "authorized" : "authorization-denied",
        invocationId: lifecycle.invocationId
      });
      return;
    }
    if (message.type === "frame-ready") {
      const width = message.width;
      const height = message.height;
      if (
        typeof width !== "number" ||
        !Number.isInteger(width) ||
        width <= 0 ||
        typeof height !== "number" ||
        !Number.isInteger(height) ||
        height <= 0
      ) {
        return;
      }
      lifecycle.frameReady = true;
      log.info("picker latency stage", {
        invocationId: lifecycle.invocationId,
        mode: lifecycle.mode,
        stage: "renderer_frame_frozen",
        displayId: targetDisplay.id,
        width,
        height,
        transferMode: message.transferMode
      });
      return;
    }
  });
  port2.on("close", () => {
    lifecycle.framePortClosed = true;
    lifecycle.framePort = null;
    if (!lifecycle.settled && activeSelectorLifecycle === lifecycle) {
      teardownActiveSelectorLifecycle("render_process_gone", { window: win });
    }
  });
  port2.start();
  win.webContents.postMessage(
    SELECTOR_FRAME_PORT_CHANNEL,
    { invocationId: lifecycle.invocationId },
    [port1]
  );
}

/**
 * Idempotent lifecycle teardown for the one active selector invocation.
 * Window closure, renderer loss, display removal, and app disposal all route
 * here so resolver settlement and snapshot ownership cannot diverge.
 */
function teardownActiveSelectorLifecycle(
  source:
    | "window_closed"
    | "render_process_gone"
    | "display_metrics_changed"
    | "display_removed"
    | "snapshot_paint_timeout"
    | "presentation_timeout"
    | "dispose",
  match: { window?: BrowserWindow; displayId?: number } = {}
): boolean {
  const lifecycle = activeSelectorLifecycle;
  if (lifecycle === null || lifecycle.settled) return false;
  if (match.window !== undefined && lifecycle.targetWindow !== match.window) return false;
  if (match.displayId !== undefined && lifecycle.targetDisplayId !== match.displayId) return false;

  lifecycle.settled = true;
  lifecycle.stopAsyncWork?.();
  lifecycle.stopAsyncWork = null;
  const result = selectorFailure("destroyed", takePreviousApp(lifecycle));
  lifecycle.terminationResult = result;
  const resolveTermination = lifecycle.resolveTermination;
  lifecycle.resolveTermination = null;
  resolveTermination?.(result);

  supersedeSelectorWaiters(lifecycle.invocationId);
  uninstallSelectorGlobalShortcuts();
  releaseActiveScreenSnapshot();
  closeRendererFrameSession(lifecycle, true);
  lastSnapshot = [];
  if (
    process.platform === "win32" &&
    lifecycle.targetWindow !== null &&
    !lifecycle.targetWindow.isDestroyed()
  ) {
    lifecycle.targetWindow.setFocusable(true);
  }

  let resolver: ((result: SelectorResult) => void) | null = null;
  if (pendingInvocationId === lifecycle.invocationId) {
    resolver = pendingResolver;
    pendingResolver = null;
    pendingInvocationId = null;
    pendingSelectorMode = null;
  }
  log.warn("active capture selector torn down", {
    invocationId: lifecycle.invocationId,
    mode: lifecycle.mode,
    source,
    previousAppOrigin: result.previousAppOrigin
  });
  resolver?.(result);
  return true;
}

function removeSelectorWindowReference(displayId: number, win: BrowserWindow): void {
  if (selectorWindows.get(displayId) === win) {
    selectorWindows.delete(displayId);
    selectorDisplaysNeedingFreshPanel.delete(displayId);
  }
  if (standbySelectorWindows.get(displayId) === win) {
    standbySelectorWindows.delete(displayId);
    standbyWarmScheduled.delete(displayId);
  }
}

function handleSelectorWindowClosed(displayId: number, win: BrowserWindow): void {
  removeSelectorWindowReference(displayId, win);
  teardownActiveSelectorLifecycle("window_closed", { window: win });
}

function handleSelectorRenderProcessGone(
  displayId: number,
  win: BrowserWindow,
  reason: string
): void {
  log.warn("capture selector renderer process gone", { displayId, reason });
  teardownActiveSelectorLifecycle("render_process_gone", { window: win });
  removeSelectorWindowReference(displayId, win);
  if (!win.isDestroyed()) win.destroy();
}

function handleDisplayMetricsChanged(
  _event: unknown,
  display: Display,
  changedMetrics: string[]
): void {
  // A frozen snapshot, HWND candidates, and result-coordinate translation
  // must all use one display geometry. Work-area-only changes (notably the
  // macOS menu bar moving during simple fullscreen) do not alter that space,
  // but bounds/DPI/rotation changes do. Terminate the active target-display
  // invocation before resizing so it cannot commit mixed-generation pixels.
  if (
    changedMetrics.some(
      (metric) => metric === "bounds" || metric === "scaleFactor" || metric === "rotation"
    )
  ) {
    teardownActiveSelectorLifecycle("display_metrics_changed", {
      displayId: display.id
    });
  }
  resizeSelectorToDisplay(display);
}

function handleDisplayAdded(): void {
  preWarmRegionSelector("display-change");
}

function handleDisplayRemoved(_event: unknown, display: Display): void {
  teardownActiveSelectorLifecycle("display_removed", { displayId: display.id });
  preWarmRegionSelector("display-change");
}

/**
 * Create the pre-warmed windows — one per display. Idempotent. Call
 * once at boot; safe to call again to refresh after display changes.
 */
export function preWarmRegionSelector(reason: SelectorPrewarmReason = "startup"): void {
  // Build one window per display we don't already have.
  const displays = screen.getAllDisplays();
  const liveIds = new Set<number>();
  for (const display of displays) {
    liveIds.add(display.id);
    const existing = selectorWindows.get(display.id);
    if (existing !== undefined && !existing.isDestroyed()) continue;
    const win = createSelectorWindow(display, reason);
    selectorWindows.set(display.id, win);
  }
  // Tear down windows for displays that have been removed.
  for (const [id, win] of selectorWindows) {
    if (!liveIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      selectorWindows.delete(id);
      selectorDisplaysNeedingFreshPanel.delete(id);
    }
  }
  for (const [id, win] of standbySelectorWindows) {
    if (!liveIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      standbySelectorWindows.delete(id);
      standbyWarmScheduled.delete(id);
    }
  }

  if (!resultListenerAttached) {
    ipcMain.on(SELECTOR_CROP_PORT_CHANNEL, installRendererCropPort);
    // Diagnostic listener: renderer pushes its viewport dims on every
    // window-list snapshot. Compacted to one line + deduped per
    // selector-window so we don't repeat the same dims into the dev
    // terminal on every snapshot delivery.
    const lastViewportByWebContents = new Map<number, string>();
    ipcMain.on(SELECTOR_DIAGNOSTICS_CHANNEL, (event, payload: unknown) => {
      if (payload === null || typeof payload !== "object") return;
      const p = payload as {
        innerWidth?: number;
        innerHeight?: number;
        devicePixelRatio?: number;
      };
      const summary = `${p.innerWidth}×${p.innerHeight} dpr=${p.devicePixelRatio}`;
      const wcId = event.sender.id;
      if (lastViewportByWebContents.get(wcId) === summary) return;
      lastViewportByWebContents.set(wcId, summary);
      log.info(`renderer viewport wc=${wcId} ${summary}`);
    });
    ipcMain.on(SELECTOR_PERFORMANCE_CHANNEL, (event, payload: unknown) => {
      if (payload === null || typeof payload !== "object") return;
      const mark = payload as { invocationId?: unknown; mark?: unknown };
      if (typeof mark.invocationId !== "number" || typeof mark.mark !== "string") return;
      if (!isActiveSelectorSender(event.sender, mark.invocationId)) return;
      log.info("picker renderer performance mark", {
        invocationId: mark.invocationId,
        mark: mark.mark
      });
    });
    ipcMain.on(SELECTOR_PRESENTED_CHANNEL, (event, payload: unknown) => {
      const presented =
        payload !== null && typeof payload === "object"
          ? (payload as {
              invocationId?: unknown;
              generation?: unknown;
              surface?: unknown;
            })
          : null;
      if (
        presented === null ||
        typeof presented.invocationId !== "number" ||
        typeof presented.generation !== "number" ||
        (presented.surface !== "frozen-frame" &&
          presented.surface !== "window-loading" &&
          presented.surface !== "error") ||
        !isActiveSelectorSender(event.sender, presented.invocationId)
      ) {
        return;
      }
      const lifecycle = activeSelectorLifecycle;
      if (
        lifecycle === null ||
        lifecycle.presentationAcknowledged ||
        lifecycle.presentationGeneration !== presented.generation ||
        lifecycle.presentationSurface !== presented.surface
      ) {
        return;
      }
      lifecycle.presentationAcknowledged = true;
      if (lifecycle.presentationTimeout !== null) {
        clearTimeout(lifecycle.presentationTimeout);
        lifecycle.presentationTimeout = null;
      }
      const callback = lifecycle.onSelectorPresented;
      lifecycle.onSelectorPresented = null;
      if (callback !== null) {
        try {
          callback({
            invocationId: lifecycle.invocationId,
            surface: presented.surface
          });
        } catch (cause) {
          log.error("selector presented callback failed", {
            invocationId: lifecycle.invocationId,
            surface: presented.surface,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        }
      }
      const onAcknowledged = lifecycle.onPresentationAcknowledged;
      lifecycle.onPresentationAcknowledged = null;
      onAcknowledged?.();
    });
    ipcMain.on(SELECTOR_PAINTED_CHANNEL, (event, payload: unknown) => {
      // Renderer acked that the frozen snapshot finished painting.
      // Only satisfy the current wait if the URL matches (a stale ack
      // from a superseded capture must not reveal the selector early).
      const paint =
        typeof payload === "object" && payload !== null
          ? (payload as {
              snapshotKey?: unknown;
              screenUrl?: unknown;
              invocationId?: unknown;
              status?: unknown;
            })
          : null;
      if (
        paint === null ||
        typeof (paint.snapshotKey ?? paint.screenUrl) !== "string" ||
        typeof paint.invocationId !== "number" ||
        (paint.status !== "painted" && paint.status !== "error")
      ) {
        return;
      }
      if (!isActiveSelectorSender(event.sender, paint.invocationId)) return;
      if (
        paint.status === "error" &&
        activeSelectorLifecycle?.invocationId === paint.invocationId
      ) {
        activeSelectorLifecycle.snapshotDecodeFailed = true;
      }
      if (pendingPaintWait === null) return;
      if (
        (paint.snapshotKey ?? paint.screenUrl) !== pendingPaintWait.screenUrl ||
        paint.invocationId !== pendingPaintWait.invocationId
      ) {
        return;
      }
      const waiter = pendingPaintWait;
      pendingPaintWait = null;
      waiter.resolve(paint.status === "error" ? "error" : "painted");
    });
    ipcMain.on(SELECTOR_RESULT_CHANNEL, (event, payload: unknown) => {
      // IMPORTANT: this handler does NOT hide the selector windows.
      // The caller (capture-handlers) hides via `hideSelector()` AFTER
      // it has set the float-over to LOADED, so the selector hide
      // reveals an already-painted toast — no post-hoc show race.
      // See docs/plans/2026-05-04-001 §"Solution 3" for context.
      if (pendingResolver === null || pendingInvocationId === null) return;
      const payloadInvocationId =
        typeof payload === "object" && payload !== null && "invocationId" in payload
          ? (payload as { invocationId?: unknown }).invocationId
          : null;
      if (payloadInvocationId !== pendingInvocationId) return;
      if (!isActiveSelectorSender(event.sender, pendingInvocationId)) return;
      const lifecycle = activeSelectorLifecycle;
      if (
        lifecycle === null ||
        lifecycle.invocationId !== pendingInvocationId ||
        lifecycle.settled
      ) {
        return;
      }
      const resolver = pendingResolver;
      const selectorMode = pendingSelectorMode;
      lifecycle.settled = true;
      pendingResolver = null;
      pendingInvocationId = null;
      pendingSelectorMode = null;
      if (lifecycle.snapshotDecodeFailed && isSelectorPayload(payload) && payload.ok) {
        closeRendererFrameSession(lifecycle, true);
        resolver(selectorFailure("cancelled", takePreviousApp(lifecycle)));
        return;
      }
      if (isSelectorPayload(payload) && payload.ok) {
        if (lifecycle.targetDisplayId === null || payload.displayId !== lifecycle.targetDisplayId) {
          closeRendererFrameSession(lifecycle, true);
          resolver(selectorFailure("cancelled", takePreviousApp(lifecycle)));
          return;
        }
        // Renderer ships rects in WINDOW-LOCAL display logical
        // coords. The selector window covers display.bounds via
        // simple-fullscreen, so window-local (0,0) maps to display
        // global (display.bounds.x, display.bounds.y). Translate
        // back here so capture-handlers + the snapshot crop see a
        // single, consistent global-coord rect.
        const display = screen.getAllDisplays().find((d) => d.id === payload.displayId);
        const offsetX = display?.bounds.x ?? 0;
        const offsetY = display?.bounds.y ?? 0;
        // Any renderer-requested HWND capture must refer to a candidate from
        // this invocation's filtered, terminal window list. The renderer is
        // sandboxed but still untrusted input; accepting an arbitrary numeric
        // HWND here could capture an excluded or unrelated window.
        const hasSnappedWindowId = typeof payload.snappedWindowId === "number";
        const requiresTrustedWindow =
          selectorMode === "window" || payload.fullWindow === true || hasSnappedWindowId;
        const trustedWindow =
          typeof payload.snappedWindowId === "number" && lifecycle.windowCandidatesReady
            ? lifecycle.allowedWindowCandidates.get(payload.snappedWindowId)
            : undefined;
        if (requiresTrustedWindow && trustedWindow === undefined) {
          closeRendererFrameSession(lifecycle, true);
          resolver(selectorFailure("cancelled", takePreviousApp(lifecycle)));
          return;
        }

        // Any allowlisted full-window commit is sourced from the native
        // window backing store and therefore does not require frozen pixels.
        const commitsWithoutSnapshot =
          payload.fullWindow === true && trustedWindow !== undefined;
        const commitsVideoCoordinates = lifecycle.intent === "video";
        const requiresCommittedRendererCrop =
          lifecycle.intent === "snap" &&
          lifecycle.captureStrategy === "renderer-display-media" &&
          !commitsWithoutSnapshot;
        const hasRequiredPixels = requiresCommittedRendererCrop
          ? lifecycle.frameReady && lifecycle.committedCropPath !== null
          : activeScreenSnapshot !== null || commitsWithoutSnapshot || commitsVideoCoordinates;
        if (!hasRequiredPixels) {
          closeRendererFrameSession(lifecycle, true);
          resolver(selectorFailure("cancelled", takePreviousApp(lifecycle)));
        } else {
          // Ownership transfer: clear the module-scope reference so
          // hideAllSelectors skips the cleanup. The consumer (the
          // capture handler) calls releaseSnapshot(id) after it
          // finishes cropping.
          const snapshot = activeScreenSnapshot;
          activeScreenSnapshot = null;
          const committedCropPath = lifecycle.committedCropPath;
          lifecycle.committedCropPath = null;
          // Transfer the explicit previous-app context with the result. The
          // caller may restore only the `external` arm; `unknown` must never
          // be interpreted as "PwrSnap was frontmost".
          const previousApp = takePreviousApp(lifecycle);
          // The allowlist authenticates the window id, not renderer geometry.
          // payload.rect may be the candidate's raw full-window bounds or a
          // user-adjusted region and must survive validation unchanged.
          const selectedRect = payload.rect;
          const result: SelectorResult = {
            ok: true,
            rect: {
              x: selectedRect.x + offsetX,
              y: selectedRect.y + offsetY,
              w: selectedRect.w,
              h: selectedRect.h
            },
            displayId: lifecycle.targetDisplayId,
            ...previousApp
          };
          if (snapshot !== null) result.screenSnapshotId = snapshot.id;
          if (committedCropPath !== null) result.committedCropPath = committedCropPath;
          if (typeof payload.snappedWindowId === "number") {
            result.snappedWindowId = payload.snappedWindowId;
          }
          if (payload.fullWindow === true) {
            result.fullWindow = true;
          }
          if (typeof payload.captureCursor === "boolean") {
            result.captureCursor = payload.captureCursor;
          }
          closeRendererFrameSession(lifecycle, false);
          resolver(result);
        }
      } else {
        closeRendererFrameSession(lifecycle, true);
        resolver(selectorFailure("cancelled", takePreviousApp(lifecycle)));
      }
      // (intentionally no hideAllSelectors here — caller owns it)
    });
    resultListenerAttached = true;
  }

  if (!displayListenersAttached) {
    // Resize-in-place when a display's metrics change rather than
    // destroying + recreating the selector. The destroy-and-recreate
    // approach was racy: macOS fires `display-metrics-changed` whenever
    // a window enters simple-fullscreen (the menu bar showing/hiding
    // counts as a metric change), and rebuilding the selector mid-show
    // killed the very window we were trying to put on screen. setBounds
    // is cheap, idempotent, and doesn't disturb the show/hide state.
    screen.on("display-metrics-changed", handleDisplayMetricsChanged);
    screen.on("display-added", handleDisplayAdded);
    screen.on("display-removed", handleDisplayRemoved);
    displayListenersAttached = true;
  }
}

/**
 * Show the selector on the display under the cursor and resolve when
 * the user commits or cancels. A concurrent invocation is rejected as
 * `busy`; it never replaces or hides the active selector.
 *
 * `mode` controls the selector UI:
 *   - 'auto' (default): snap-to-window is live + drag-region works
 *   - 'region': pure rect drag, snap candidates suppressed
 *   - 'window': window-picker only, drag suppressed, ⇧-not-required
 *     for full-window capture
 *
 * `keepPwrSnapChrome` (default false) — by default the selector hides
 * PwrSnap's own tray popover + float-over right before snapshotting,
 * so they don't sit on top of whatever the user is trying to capture.
 * Timed mode opts IN to leaving them: the whole point of the timer is
 * to let the user stage transient UI (including the PwrSnap tray
 * menu itself) and have it preserved in the snapshot they pick
 * against.
 */
export async function pickRegion(
  opts: {
    mode?: SelectorMode;
    keepPwrSnapChrome?: boolean;
    /** BrowserWindow ids to exclude from the frozen snapshot via
     *  content protection (NSWindow.sharingType=.none) — WITHOUT
     *  hiding them. Used when the capture was triggered from a PwrSnap
     *  window the user obviously didn't mean to capture (e.g. the
     *  Library's own Capture button): the Library stays exactly where
     *  it is on screen, but is absent from the picker's frozen
     *  background. Cleared the instant the snapshot is taken. */
    protectWindowIds?: readonly number[];
    /** Visual intent telegraphed to the renderer. `"video"` swaps
     *  the "Capture" chip for a "● Recording video" badge and
     *  changes the hint text so the user knows clicking commits a
     *  recording, not a snap. No behavioral effect on selection
     *  itself — both intents return the same rect / window payload. */
    intent?: "snap" | "video";
    /** Video-only seed for the selector's cursor toggle. Forwarded to
     *  the renderer in the mode signal; the committed value rides back
     *  on the result as `captureCursor`. */
    cursorDefault?: boolean;
    /** Called synchronously once the accepted invocation's truthful selector
     *  surface has been presented and acknowledged after show. */
    onSelectorPresented?: (event: SelectorPresentedEvent) => void;
  } = {}
): Promise<SelectorResult> {
  const mode: SelectorMode = opts.mode ?? "auto";
  const keepPwrSnapChrome = opts.keepPwrSnapChrome ?? false;
  const protectWindowIds = opts.protectWindowIds ?? [];
  const intent = opts.intent ?? "snap";
  const cursorDefault = opts.cursorDefault;
  if (pickerInvocationActive || pendingResolver !== null) {
    log.info("capture selector invocation suppressed", {
      mode,
      reason: "in_flight",
      activeInvocationId: pendingInvocationId
    });
    return selectorFailure("busy");
  }
  pickerInvocationActive = true;
  const invocationId = nextInvocationId;
  nextInvocationId += 1;
  const rendererOwnedExperimentEnabled = isRendererOwnedSelectorCaptureEnabled();
  const captureStrategy = selectorDisplayMediaStrategy(
    process.platform,
    rendererOwnedExperimentEnabled
  );
  let resolveTermination!: (result: Extract<SelectorResult, { ok: false }>) => void;
  const terminationPromise = new Promise<Extract<SelectorResult, { ok: false }>>((resolve) => {
    resolveTermination = resolve;
  });
  const lifecycle: ActiveSelectorLifecycle = {
    invocationId,
    mode,
    intent,
    targetWindow: null,
    targetDisplayId: null,
    previousApp: unknownPreviousApp(),
    windowCandidatesReady: false,
    allowedWindowCandidates: new Map(),
    snapshotDecodeFailed: false,
    frameReady: false,
    frameAuthorizationRequested: false,
    framePort: null,
    framePortClosed: true,
    cropPort: null,
    cropPortClosed: true,
    cropPortOpened: false,
    cropReceiver: null,
    committedCropPath: null,
    onSelectorPresented: opts.onSelectorPresented ?? null,
    presentationGeneration: null,
    presentationSurface: null,
    presentationAcknowledged: false,
    presentationTimeout: null,
    onPresentationAcknowledged: null,
    captureStrategy,
    settled: false,
    terminationResult: null,
    terminationPromise,
    resolveTermination,
    stopAsyncWork: null
  };
  activeSelectorLifecycle = lifecycle;
  const focusedWindowAtInvocationStart = BrowserWindow.getFocusedWindow();
  const focusedProtectedWindowAtInvocationStart =
    focusedWindowAtInvocationStart !== null &&
    protectWindowIds.includes(focusedWindowAtInvocationStart.id)
      ? focusedWindowAtInvocationStart
      : null;
  let snapshotContentProtectionActive = false;
  const temporarilyHiddenProtectedWindows: Array<{
    window: BrowserWindow;
    restoreActivation: boolean;
  }> = [];
  const liftSnapshotContentProtection = (): void => {
    if (!snapshotContentProtectionActive) return;
    snapshotContentProtectionActive = false;
    setSnapshotContentProtection(protectWindowIds, false);
  };
  const restoreTemporarilyHiddenProtectedWindows = (): void => {
    for (const hidden of temporarilyHiddenProtectedWindows.splice(0)) {
      if (hidden.window.isDestroyed()) continue;
      hidden.window.showInactive();
      if (hidden.restoreActivation) {
        pendingProtectedWindowActivationRestore = hidden.window;
      }
    }
  };
  try {
    const requestStartedAt = Date.now();
    const elapsedFromRequest = (): number => Date.now() - requestStartedAt;
    log.info("capture selector requested", {
      invocationId,
      mode,
      intent,
      keepPwrSnapChrome,
      ...selectorPrewarmAgePayload()
    });
    if (selectorWindows.size === 0) {
      preWarmRegionSelector("lazy");
    }
    if (selectorWindows.size === 0) {
      return selectorFailure("destroyed");
    }

    // Route to whichever display the cursor is on right now.
    const cursor = screen.getCursorScreenPoint();
    const targetDisplay = screen.getDisplayNearestPoint(cursor);
    lifecycle.targetDisplayId = targetDisplay.id;
    log.info("capture selector target display resolved", {
      displayId: targetDisplay.id,
      durationFromUserRequestMs: elapsedFromRequest(),
      ...selectorPrewarmAgePayload(targetDisplay.id)
    });
    let targetWindow = selectorWindows.get(targetDisplay.id);
    if (targetWindow === undefined || targetWindow.isDestroyed()) {
      // Stale entry — rebuild lazily and try again.
      rebuildSelectorForDisplay(targetDisplay.id);
      targetWindow = selectorWindows.get(targetDisplay.id);
    }
    if (targetWindow === undefined) {
      return selectorFailure("destroyed");
    }
    lifecycle.targetWindow = targetWindow;
    const targetLoad = await raceSelectorTermination(
      lifecycle,
      waitForSelectorWindowLoad(targetDisplay.id, targetWindow)
    );
    if (targetLoad.kind === "terminated") return targetLoad.result;
    if (!targetLoad.value) {
      return selectorFailure("destroyed");
    }

    const win = targetWindow;

    // Auto/region freeze the screen before show so a rect is cropped from
    // exactly the pixels the user selected. On macOS and Windows the selector
    // renderer owns that frame; Linux retains the measured file fallback until
    // the portal can guarantee exact-display selection. Pure window mode is different:
    // its commit always asks desktopCapturer for the chosen HWND's backing
    // buffer, so a full-display PNG was expensive dead work on the reveal
    // path. It shows a truthful live loading shell and starts enumeration
    // only after that shell is visible.
    const needsFrozenSnapshot = mode !== "window";
    const usesRendererDisplayMedia =
      needsFrozenSnapshot && captureStrategy === "renderer-display-media";
    const usesLegacyFileSnapshot = needsFrozenSnapshot && captureStrategy === "legacy-file";
    log.info("capture selector frame strategy selected", {
      invocationId,
      mode,
      platform: process.platform,
      strategy: needsFrozenSnapshot ? captureStrategy : "none",
      rendererOwnedExperimentEnabled,
      fallback: usesLegacyFileSnapshot
    });
    releaseActiveScreenSnapshot();
    // Synchronously dismiss PwrSnap capture chrome BEFORE the snapshot
    // and window-list enumeration so our own popovers/toasts neither
    // appear in the frozen background nor become snap candidates. The
    // user's normal PwrSnap windows (Library / Edit) are intentionally
    // left alone: if they're on screen, they're valid capture targets.
    //
    // Timed mode opts out via `keepPwrSnapChrome` — the user may have
    // re-opened the tray during the countdown precisely so it appears
    // in the picker. Skipping the hide also skips the 50 ms compositor
    // wait, which only mattered as a "let the hide reach the window
    // server before snapshotting" guard.
    if (!keepPwrSnapChrome) hideTrayPopoverIfVisible();
    if (!keepPwrSnapChrome || mode === "window") {
      // A window-picker shell must enumerate while the float-over is hidden;
      // otherwise our toast can become the top PwrSnap window/candidate.
      setFloatOverState({ kind: "cancel" });
    }
    // Content-protect the windows the trigger says shouldn't appear in
    // the snapshot (e.g. the Library when the capture was started from
    // its own Capture button). sharingType=.none excludes them from the
    // screencapture output but keeps them visible on screen — no hide,
    // no flicker, no focus disturbance. Set AFTER the hide above so a
    // hide throw can't leave a window protected, and the try/finally
    // around the snapshot below lifts it on every exit path.
    if (needsFrozenSnapshot && protectWindowIds.length > 0) {
      // Mark active before entering the native/Electron toggle loop. The
      // outer pickRegion finally is the last-resort cleanup for every
      // synchronous throw until the snapshot-local finally runs.
      snapshotContentProtectionActive = true;
      setSnapshotContentProtection(protectWindowIds, true);
    }
    const hidesProtectedWindows =
      mode === "window" || (usesRendererDisplayMedia && process.platform === "darwin");
    if (hidesProtectedWindows) {
      // A live pure-window picker must not visibly leave an excluded PwrSnap
      // window over the allowlisted window behind it: the hover surface and
      // candidate geometry would disagree. Renderer-owned ScreenCaptureKit
      // also needs this on macOS because it may include content-protected
      // windows. Keep only windows that were actually visible, and restore
      // them without activation after selection/frame acquisition.
      for (const windowId of protectWindowIds) {
        const protectedWindow = BrowserWindow.fromId(windowId);
        if (
          protectedWindow !== null &&
          !protectedWindow.isDestroyed() &&
          protectedWindow.isVisible()
        ) {
          protectedWindow.hide();
          temporarilyHiddenProtectedWindows.push({
            window: protectedWindow,
            restoreActivation: protectedWindow === focusedProtectedWindowAtInvocationStart
          });
        }
      }
    }
    if (
      (needsFrozenSnapshot && (!keepPwrSnapChrome || protectWindowIds.length > 0)) ||
      temporarilyHiddenProtectedWindows.length > 0
    ) {
      // Compositor flush — let the hide / content-protection toggle
      // reach the window server before we snapshot, otherwise the
      // frozen background can race ahead of the state change.
      const compositorFlush = await raceSelectorTermination(
        lifecycle,
        new Promise<void>((resolve) => setTimeout(resolve, 50))
      );
      if (compositorFlush.kind === "terminated") {
        liftSnapshotContentProtection();
        return compositorFlush.result;
      }
    }
    if (lifecycle.terminationResult !== null) {
      liftSnapshotContentProtection();
      return lifecycle.terminationResult;
    }

    const displayBounds = targetDisplay.bounds;
    const displayCursor = {
      x: cursor.x - displayBounds.x,
      y: cursor.y - displayBounds.y
    };
    const ourPids = selfPidSet();
    const protectedWindows = protectWindowIds
      .map((id) => BrowserWindow.fromId(id))
      .filter((w): w is BrowserWindow => w !== null && !w.isDestroyed());
    const excludeWindowIds =
      process.platform === "win32"
        ? protectedWindows.flatMap((protectedWindow) => {
            try {
              const windowId = windowsNativeWindowId(protectedWindow.getNativeWindowHandle());
              return windowId === null ? [] : [windowId];
            } catch {
              return [];
            }
          })
        : [];
    // macOS window enumeration and Electron expose different identifiers,
    // so bounds remain the best available join there. Windows uses HWND:
    // Electron's frame bounds and DWM extended-frame bounds can legitimately
    // differ and must not be compared for protection/exclusion correctness.
    const excludeWindowBounds =
      process.platform === "win32" ? [] : protectedWindows.map((w) => w.getBounds());
    let windowListPayload: SelectorWindowListPayload | null = null;
    let windowListResolver: ((result: SelectorResult) => void) | null = null;
    let acceptingWindowList = true;
    let selectorVisible = false;
    // Never let a reused renderer or a failed helper carry source metadata
    // from the prior invocation into this one.
    lastSnapshot = [];
    lifecycle.previousApp =
      focusedProtectedWindowAtInvocationStart === null
        ? unknownPreviousApp()
        : { previousAppOrigin: "pwrsnap", previousAppPid: null };
    lifecycle.stopAsyncWork = () => {
      acceptingWindowList = false;
    };
    const deliverWindowListPayload = (payload: SelectorWindowListPayload): void => {
      if (
        !acceptingWindowList ||
        !selectorVisible ||
        pendingResolver !== windowListResolver ||
        win.isDestroyed()
      ) {
        return;
      }
      win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, payload);
      setTimeout(() => {
        if (!acceptingWindowList || pendingResolver !== windowListResolver || win.isDestroyed()) {
          return;
        }
        win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, payload);
      }, 50);
    };
    let windowListPromise: Promise<void> | null = null;
    const requestWindowList = (): void => {
      if (
        !acceptingWindowList ||
        windowListPromise !== null ||
        lifecycle.terminationResult !== null
      ) {
        return;
      }
      const windowLayoutRequestedAt = Date.now();
      log.info("picker latency stage", {
        invocationId,
        mode,
        stage: "window_enumeration_started",
        displayId: targetDisplay.id,
        durationFromUserRequestMs: elapsedFromRequest(),
        shellVisible: selectorVisible
      });
      windowListPromise = listWindowsSnapshot()
        .then((snapshot): void => {
          if (!acceptingWindowList || lifecycle.terminationResult !== null) return;
          if (selectorVisible && pendingResolver !== windowListResolver) return;
          log.info("picker latency stage", {
            invocationId,
            mode,
            stage: "window_enumeration_completed",
            displayId: targetDisplay.id,
            durationMs: Date.now() - windowLayoutRequestedAt,
            durationFromUserRequestMs: elapsedFromRequest(),
            rawWindowCount: snapshot.windows.length,
            frontmostPid: snapshot.frontmostPid,
            frontmostBundleId: snapshot.frontmostBundleId
          });
          const normalizedWindows = windowSnapshotInElectronDip(
            snapshot.windows,
            process.platform,
            (rect) => screen.screenToDipRect(null, rect)
          );
          const prepared = prepareWindowListPayload({
            rawSnapshot: normalizedWindows,
            targetDisplay,
            displayCursor,
            ourPids,
            excludeWindowIds,
            excludeWindowBounds,
            selectorWindow: win,
            frontmostPid: snapshot.frontmostPid,
            frontmostBundleId: snapshot.frontmostBundleId
          });
          lastSnapshot = prepared.snapshot;
          if (focusedProtectedWindowAtInvocationStart === null) {
            lifecycle.previousApp = {
              previousAppOrigin: prepared.previousAppOrigin,
              previousAppPid: prepared.previousAppPid
            };
          }
          lifecycle.allowedWindowCandidates = new Map(
            prepared.payload.windows
              .filter(
                (candidate) =>
                  Number.isFinite(candidate.rect.x) &&
                  Number.isFinite(candidate.rect.y) &&
                  Number.isFinite(candidate.rect.w) &&
                  Number.isFinite(candidate.rect.h) &&
                  candidate.rect.w > 0 &&
                  candidate.rect.h > 0
              )
              .map(
                (
                  candidate
                ): [number, { rect: typeof candidate.rect; rawRect: typeof candidate.rawRect }] => [
                  candidate.windowId,
                  { rect: candidate.rect, rawRect: candidate.rawRect }
                ]
              )
          );
          lifecycle.windowCandidatesReady = true;
          windowListPayload = {
            ...prepared.payload,
            invocationId,
            status: "ready"
          };
          deliverWindowListPayload(windowListPayload);
        })
        .catch((err): void => {
          if (!acceptingWindowList || lifecycle.terminationResult !== null) return;
          log.warn("window-list helper failed during selector startup", {
            invocationId,
            mode,
            displayId: targetDisplay.id,
            durationMs: Date.now() - windowLayoutRequestedAt,
            durationFromUserRequestMs: elapsedFromRequest(),
            message: err instanceof Error ? err.message : String(err)
          });
          lastSnapshot = [];
          if (focusedProtectedWindowAtInvocationStart === null) {
            lifecycle.previousApp = unknownPreviousApp();
          }
          lifecycle.allowedWindowCandidates.clear();
          lifecycle.windowCandidatesReady = false;
          windowListPayload = {
            invocationId,
            status: "error",
            windows: [],
            displayBounds: {
              width: displayBounds.width,
              height: displayBounds.height
            },
            cursor: displayCursor
          };
          deliverWindowListPayload(windowListPayload);
        })
        .finally(() => {
          if (
            mode === "window" &&
            acceptingWindowList &&
            selectorVisible &&
            lifecycle.terminationResult === null &&
            pendingResolver === windowListResolver
          ) {
            // Enumeration has reached a terminal ready/error payload. Input
            // can now activate, and a frozen/opaque selector may safely
            // pre-show the float-over beneath it.
            if (process.platform === "win32" && !win.isDestroyed()) {
              win.setFocusable(true);
              win.focus();
              win.webContents.focus();
              win.moveTop();
            }
            if (activeScreenSnapshot !== null) {
              setFloatOverState({ kind: "show-idle" });
            }
          }
        });
    };

    // Auto/region overlap native metadata work with the required frozen
    // snapshot. Window mode starts it from reveal(), after loading feedback
    // is actually on screen; this ordering is the latency contract.
    if (mode !== "window") requestWindowList();

    if (usesLegacyFileSnapshot) {
      const screenSnapshotRequestedAt = Date.now();
      log.info("picker latency stage", {
        invocationId,
        mode,
        stage: "screen_snapshot_started",
        displayId: targetDisplay.id,
        durationFromUserRequestMs: elapsedFromRequest()
      });
      try {
        const capturePromise = captureAndRegister(targetDisplay.id, { mode });
        const capture = await raceSelectorTermination(lifecycle, capturePromise);
        if (capture.kind === "terminated") {
          // The native capture cannot be synchronously cancelled. Return the
          // destroyed result now and release its registry entry if/when it lands.
          void capturePromise.then(
            (lateSnapshot) => releaseSnapshot(lateSnapshot.id),
            () => undefined
          );
          return capture.result;
        }
        const screenSnapshot = capture.value;
        activeScreenSnapshot = screenSnapshot;
        log.info("picker latency stage", {
          invocationId,
          mode,
          stage: "screen_snapshot_completed",
          displayId: targetDisplay.id,
          durationMs: Date.now() - screenSnapshotRequestedAt,
          durationFromUserRequestMs: elapsedFromRequest(),
          snapshotId: screenSnapshot.id,
          strategy: "legacy-file"
        });
      } catch (err) {
        if (lifecycle.terminationResult !== null) return lifecycle.terminationResult;
        log.warn("screen snapshot failed; selector aborted", {
          invocationId,
          mode,
          displayId: targetDisplay.id,
          durationMs: Date.now() - screenSnapshotRequestedAt,
          durationFromUserRequestMs: elapsedFromRequest(),
          message: err instanceof Error ? err.message : String(err)
        });
        acceptingWindowList = false;
        void windowListPromise;
        return selectorFailure("destroyed", takePreviousApp(lifecycle));
      } finally {
        // Lift protection on EVERY snapshot exit path — success, throw, or
        // the early return in the catch. The frozen snapshot already excludes
        // protected windows; holding this longer would leave them uncapturable.
        liftSnapshotContentProtection();
      }
    }

    if (lifecycle.terminationResult !== null) return lifecycle.terminationResult;

    // Arm Esc + Enter via globalShortcut for the duration of the
    // selector. macOS sometimes withholds keyboard events from a
    // newly-shown window until the user clicks to "engage" it — the
    // renderer's keydown listener exists but the event never reaches
    // it. globalShortcut bypasses focus entirely; for the brief
    // duration the selector is up the user has nothing else they'd
    // want Esc / ↵ doing anyway, since the screen-saver-level overlay
    // covers everything.
    installSelectorGlobalShortcuts(win);

    const result = await new Promise<SelectorResult>((resolve) => {
      pendingResolver = resolve;
      pendingInvocationId = invocationId;
      pendingSelectorMode = mode;
      windowListResolver = resolve;
      // Tell the renderer which mode + snapshot URL to use, then let it
      // render + DECODE the frozen-snapshot <img> while the window is
      // STILL HIDDEN. We reveal the window only once the renderer acks
      // that paint (or a short timeout elapses) — see `reveal()` below.
      // Showing first (the old behavior) made the window appear as an
      // empty transparent overlay for a frame, flashing the live screen
      // / desktop behind the screen-saver-level selector before the
      // snapshot landed. ("compose → load image → show in one go.")
      const captureSource = usesRendererDisplayMedia
        ? {
            kind: "renderer-display-media" as const,
            displayId: targetDisplay.id,
            displayBounds: {
              width: targetDisplay.bounds.width,
              height: targetDisplay.bounds.height
            }
          }
        : activeScreenSnapshot !== null
          ? {
              kind: "legacy-file" as const,
              screenUrl: `pwrsnap-screen://r/${activeScreenSnapshot.id}`
            }
          : { kind: "none" as const };
      const paintKey =
        captureSource.kind === "renderer-display-media"
          ? `renderer-display-media:${invocationId}`
          : captureSource.kind === "legacy-file"
            ? captureSource.screenUrl
            : null;
      const modePayload = {
        invocationId,
        mode,
        captureSource,
        ...(captureSource.kind === "legacy-file" ? { screenUrl: captureSource.screenUrl } : {}),
        intent,
        cursor: cursorDefault
      };
      if (!win.isDestroyed()) {
        win.webContents.send(SELECTOR_MODE_CHANNEL, modePayload);
        if (usesRendererDisplayMedia) {
          installRendererFramePort(lifecycle, win, targetDisplay);
        }
      }
      const displayRequestedAt = Date.now();
      log.info("picker latency stage", {
        invocationId,
        mode,
        stage: "shell_show_requested",
        displayId: targetDisplay.id,
        durationFromUserRequestMs: elapsedFromRequest()
      });
      // Reveal the window once the snapshot has painted (gated below).
      const reveal = (): void => {
        if (win.isDestroyed() || pendingResolver !== resolve) return;
        // Order matters: setSimpleFullScreen(true) BEFORE show().
        //
        // Without this, `win.show()` paints the renderer's first frame
        // while Cocoa is still clipping content to the work-area (the
        // region below the menu bar) — even though the BrowserWindow
        // bounds cover the full display. The screen snapshot, painted
        // at body coords (0, 0), then sits 25-or-so pixels below where
        // it should, with the LIVE menu bar still visible above. ~150ms
        // later setSimpleFullScreen settles, the menu bar slides out,
        // the window's content area expands, and the snapshot suddenly
        // jumps up by the menu-bar height — visible to the user as the
        // whole screen "lurching."
        //
        // First ⌘⇧P after launch happened to look clean because no prior
        // teardown had toggled setSimpleFullScreen back to false; the
        // pre-warmed window inherited a permissive style mask. Subsequent
        // shows hit the lurch because hideAllSelectors → leaveMenuBarOverlayMode
        // had reset it.
        //
        // Doing the toggle while the window is hidden lets the style-
        // mask change settle off-screen; show() then reveals the window
        // already in its final geometry. Snapshot's menu bar pixels land
        // exactly where the user expects them, no jump.
        //
        // The renderer paints the menu bar / dock area itself via the
        // screen snapshot, so covering the real menu bar is fine — user
        // sees a 1-frame-old version of it instead of the live one.
        // Matches every native Mac capture tool (Cleanshot, Shottr,
        // SnagIt).
        enterMenuBarOverlayMode(win);
        const inactiveWindowsPicker = process.platform === "win32" && mode === "window";
        if (inactiveWindowsPicker) {
          // Showing/focusing a normal Windows BrowserWindow can reorder the
          // foreground HWND before the helper records origin/z-order. Paint
          // truthful feedback without activation. Keep input owned by the
          // selector so its loading guard consumes clicks instead of passing
          // them through to and mutating the underlying desktop.
          win.setFocusable(false);
          win.showInactive();
        } else {
          if (process.platform === "win32") win.setFocusable(true);
          win.show();
          win.focus();
          win.webContents.focus();
        }
        selectorDisplaysNeedingFreshPanel.add(targetDisplay.id);
        // Non-activating panels do not always win the final z-order
        // arbitration when another app was frontmost at hotkey time. The
        // selector still receives normal-window hover/mouse events, but
        // the Dock/menu bar can remain live above it. Re-assert ordering
        // after show/focus, matching the float-over and recording HUD
        // pattern without activating PwrSnap or changing Spaces.
        win.moveTop();
        // Do not let lazy float-over BrowserWindow creation delay the first
        // picker show. Region/auto can pre-show it now beneath their frozen
        // background; every window-picker defers it until native enumeration
        // reaches its terminal payload.
        if (mode !== "window" && activeScreenSnapshot !== null) {
          setFloatOverState({ kind: "show-idle" });
        }
        log.info("picker latency stage", {
          invocationId,
          mode,
          stage: "shell_show_called",
          displayId: targetDisplay.id,
          durationFromDisplayRequestedMs: Date.now() - displayRequestedAt,
          durationFromUserRequestMs: elapsedFromRequest()
        });
        selectorVisible = true;
        if (windowListPayload !== null) {
          deliverWindowListPayload(windowListPayload);
        }
        const surface: SelectorPresentedEvent["surface"] = lifecycle.snapshotDecodeFailed
          ? "error"
          : mode === "window"
            ? "window-loading"
            : "frozen-frame";
        const generation = nextPresentationGeneration;
        nextPresentationGeneration += 1;
        lifecycle.presentationGeneration = generation;
        lifecycle.presentationSurface = surface;
        lifecycle.presentationAcknowledged = false;
        lifecycle.onPresentationAcknowledged =
          surface === "window-loading"
            ? () => {
                log.info("picker latency stage", {
                  invocationId,
                  mode,
                  stage: "selector_presentation_acknowledged",
                  surface,
                  durationFromUserRequestMs: elapsedFromRequest()
                });
                requestWindowList();
              }
            : null;
        lifecycle.presentationTimeout = setTimeout(() => {
          if (
            activeSelectorLifecycle !== lifecycle ||
            lifecycle.settled ||
            lifecycle.presentationAcknowledged ||
            lifecycle.presentationGeneration !== generation
          ) {
            return;
          }
          log.warn("selector presentation acknowledgement timed out", {
            invocationId,
            mode,
            surface,
            generation
          });
          teardownActiveSelectorLifecycle("presentation_timeout", { window: win });
        }, SELECTOR_PRESENTATION_ACK_TIMEOUT_MS);
        // This dedicated arm is intentionally after show/showInactive,
        // focus (where applicable), and moveTop. Hidden prepaint and the
        // diagnostic shell-painted mark cannot satisfy presentation.
        win.webContents.send(SELECTOR_PRESENTATION_ARM_CHANNEL, {
          invocationId,
          generation,
          surface
        });
        scheduleStandbySelectorWarm(targetDisplay);
        // No mode re-send here: the renderer already received the mode +
        // snapshot at the pre-gate send above — that's precisely what it
        // loaded/decoded to fire the paint ack we just waited on. Showing
        // the window doesn't reset the renderer's state, so a re-send is a
        // no-op.
      };

      // Gate the reveal on the snapshot actually painting in the
      // (still-hidden) renderer, so the window never appears empty. The
      // timeout fails closed: if the renderer is wedged, do not reveal an
      // unverified surface or falsely release the caller's handoff HUD.
      if (paintKey === null) {
        reveal();
      } else {
        void waitForSnapshotPainted(
          paintKey,
          invocationId,
          usesRendererDisplayMedia
            ? RENDERER_FRAME_PAINT_TIMEOUT_MS
            : LEGACY_SNAPSHOT_PAINT_TIMEOUT_MS
        ).then((paintOutcome) => {
          restoreTemporarilyHiddenProtectedWindows();
          liftSnapshotContentProtection();
          log.info("picker latency stage", {
            invocationId,
            mode,
            stage: "snapshot_renderer_paint_gate_completed",
            outcome: paintOutcome,
            durationFromUserRequestMs: elapsedFromRequest()
          });
          if (paintOutcome === "timeout") {
            teardownActiveSelectorLifecycle("snapshot_paint_timeout", { window: win });
            return;
          }
          if (paintOutcome === "superseded") return;
          if (paintOutcome === "error") {
            // The renderer sends `error` only after its opaque error shell has
            // painted. Reveal that safe, cancellable shell instead of leaving a
            // hidden picker promise that can never receive Escape.
            lifecycle.snapshotDecodeFailed = true;
            reveal();
            return;
          }
          reveal();
        });
      }
    });
    if (process.platform === "win32" && !win.isDestroyed()) {
      win.setFocusable(true);
    }
    acceptingWindowList = false;
    lifecycle.stopAsyncWork = null;
    supersedeSelectorWaiters(invocationId);
    void windowListPromise;
    uninstallSelectorGlobalShortcuts();
    log.info("capture selector selection finished", {
      invocationId,
      displayId: targetDisplay.id,
      ok: result.ok,
      reason: result.ok ? "completed" : result.reason,
      durationFromUserRequestMs: elapsedFromRequest()
    });
    return result;
  } finally {
    // Covers synchronous throws between protection-on and the inner capture
    // try/finally (native handle reads, bounds reads, and list setup). The
    // helper is idempotent so normal snapshot cleanup cannot double-toggle.
    liftSnapshotContentProtection();
    restoreTemporarilyHiddenProtectedWindows();
    closeRendererFrameSession(lifecycle, true);
    releaseActiveScreenSnapshot();
    if (pendingInvocationId === invocationId) {
      pendingResolver = null;
      pendingInvocationId = null;
      pendingSelectorMode = null;
    }
    if (activeSelectorLifecycle === lifecycle) {
      activeSelectorLifecycle = null;
    }
    pickerInvocationActive = false;
  }
}

/**
 * Decide which app pid (if any) the capture flow should re-activate
 * after a commit or cancel. Pure function, exported for unit testing.
 *
 * Returns `null` when one of OUR pids owns the topmost window in the
 * snapshot — i.e. the user was already inside PwrSnap (Library,
 * Settings, an edit window). Re-activating any other app in that case
 * is wrong for two reasons:
 *
 *   1. It sends the Library to the background even though the user
 *      explicitly had it foreground when they triggered the capture.
 *   2. The activate call deactivates PwrSnap as a side-effect, and
 *      with our persistent floating-level panels in the window list
 *      AppKit periodically demotes our activation policy to Accessory
 *      (NSUIElement). The Dock icon vanishes and the Library window
 *      gets orphaned — alive, but unreachable via Dock or ⌘-Tab
 *      because the app is no longer Regular.
 *
 * Returns the topmost non-PwrSnap pid otherwise — exactly the
 * historical behavior. The "first non-ours, front-to-back" walk
 * matches `listWindows`' z-order-descending output (index 0 =
 * frontmost), so we restore the app the user had ACTIVE before they
 * opened the tray popover or pressed the global hotkey.
 *
 * The snapshot must already have selector-overlay self-windows
 * filtered out (see isSelectorOverlayWindow) — those would otherwise
 * always be at the top and short-circuit the "top is ours" check.
 */
export function decidePreviousApp(
  snapshot: readonly WindowInfo[],
  ourPids: ReadonlySet<number>
): PreviousAppContext {
  if (snapshot.length === 0) {
    return { previousAppOrigin: "unknown", previousAppPid: null };
  }
  // Topmost overall window in the filtered snapshot. If it's ours,
  // the user was inside PwrSnap and there's no "previous app" to
  // restore.
  if (ourPids.has(snapshot[0]!.pid)) {
    return { previousAppOrigin: "pwrsnap", previousAppPid: null };
  }
  // First (and therefore topmost) non-ours window. Matches the prior
  // behavior for the common case where the user was in Claude /
  // Terminal / Slack / etc. and triggered a capture via global
  // hotkey or tray.
  const topNonOurs = snapshot.find((w) => !ourPids.has(w.pid));
  return topNonOurs === undefined
    ? { previousAppOrigin: "unknown", previousAppPid: null }
    : { previousAppOrigin: "external", previousAppPid: topNonOurs.pid };
}

/** @deprecated Prefer `decidePreviousApp`, which preserves null's origin. */
export function decidePreviousAppPid(
  snapshot: readonly WindowInfo[],
  ourPids: ReadonlySet<number>
): number | null {
  return decidePreviousApp(snapshot, ourPids).previousAppPid;
}

type BoundsLike = { x: number; y: number; width: number; height: number };

/** Decode Electron's pointer-sized little-endian HWND buffer without losing
 * precision. Native enumeration exposes HWNDs as JS numbers, so values beyond
 * Number.MAX_SAFE_INTEGER cannot be compared safely and are rejected. */
export function windowsNativeWindowId(handle: Buffer): number | null {
  try {
    let value: bigint;
    if (handle.length === 4) {
      value = BigInt(handle.readUInt32LE(0));
    } else if (handle.length === 8) {
      value = handle.readBigUInt64LE(0);
    } else {
      return null;
    }
    if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  } catch {
    return null;
  }
}

/**
 * Normalize native-helper window bounds into Electron's screen coordinate
 * space. The Windows helper is per-monitor-DPI-aware and DWM therefore gives
 * it physical-pixel rectangles. Electron's Display bounds, cursor points,
 * BrowserWindow bounds, and selector overlays are all DIPs on Windows.
 *
 * Keeping the conversion at this boundary means every downstream consumer
 * (display filtering, renderer payloads, protected-window matching, and
 * source-app hit testing through lastSnapshot) sees one coherent DIP space.
 * macOS already emits the logical coordinates Electron uses, so it remains an
 * identity path.
 */
export function windowSnapshotInElectronDip(
  windows: readonly WindowInfo[],
  platform: NodeJS.Platform,
  screenToDipRect: (rect: BoundsLike) => BoundsLike
): WindowInfo[] {
  if (platform !== "win32") return [...windows];
  return windows.map((windowInfo) => ({
    ...windowInfo,
    bounds: screenToDipRect(windowInfo.bounds)
  }));
}

/** True when `b` matches one of the excluded windows' bounds within a
 *  small rounding tolerance — used to drop content-protected windows
 *  (e.g. the Library) from the snap-candidate list, since they're
 *  absent from the picker image but still appear in window enumeration. */
function matchesExcludedBounds(b: BoundsLike, excluded: readonly BoundsLike[]): boolean {
  return excluded.some(
    (e) =>
      Math.abs(b.x - e.x) <= 2 &&
      Math.abs(b.y - e.y) <= 2 &&
      Math.abs(b.width - e.width) <= 2 &&
      Math.abs(b.height - e.height) <= 2
  );
}

export function prepareWindowListPayload(args: {
  rawSnapshot: WindowInfo[];
  targetDisplay: Display;
  displayCursor: { x: number; y: number };
  ourPids: Set<number>;
  /** Native window ids excluded from the snapshot. On Windows these are
   *  HWNDs decoded from BrowserWindow.getNativeWindowHandle(). */
  excludeWindowIds: readonly number[];
  /** Bounds of windows excluded from the snapshot via content
   *  protection — dropped from the snap-candidate list too. */
  excludeWindowBounds: readonly BoundsLike[];
  selectorWindow: BrowserWindow;
  /** pid reported by `NSWorkspace.shared.frontmostApplication` at
   *  snapshot time. `null` on non-darwin platforms or when the
   *  envelope wasn't produced by a frontmost-aware helper build. */
  frontmostPid: number | null;
  /** bundle id companion to `frontmostPid` — included in the
   *  mismatch warning for legibility. */
  frontmostBundleId: string | null;
}): {
  snapshot: WindowInfo[];
  previousAppOrigin: PreviousAppOrigin;
  previousAppPid: number | null;
  payload: SelectorWindowListBasePayload;
} {
  const {
    rawSnapshot,
    targetDisplay,
    displayCursor,
    ourPids,
    excludeWindowIds,
    excludeWindowBounds,
    selectorWindow,
    frontmostPid,
    frontmostBundleId
  } = args;
  const displayBounds = targetDisplay.bounds;
  // `snapshot` keeps the Library even when it's content-protected, so
  // `decidePreviousApp` still correctly records "PwrSnap's own window
  // was frontmost" for a button-triggered capture. The
  // content-protected window is dropped only from the snap-CANDIDATE
  // list below — it's absent from the picker image, so it mustn't be a
  // snap-to-window target.
  const snapshot = rawSnapshot.filter(
    (w) => !isSelectorOverlayWindow(w, displayBounds, ourPids, selectorWindow)
  );

  // Snapshot the previously-frontmost app's pid. See
  // `decidePreviousApp` for the full rationale — the short version
  // is: if one of OUR windows (Library, Settings, edit window) was the
  // topmost window in z-order, the user was already in PwrSnap, so we
  // skip the post-capture activateApp call. Activating any other app
  // in that case yanks the Library out from under the user AND, as a
  // side-effect of the deactivation through our floating-level panels,
  // demotes PwrSnap's activation policy to Accessory (NSUIElement),
  // which strips the Dock icon and orphans the Library. See
  // capture-handlers.ts for the matching dock-reclaim guard on the
  // external-origin branch.
  const previousApp = decidePreviousApp(snapshot, ourPids);

  // Candidate list: drop content-protected windows (absent from the
  // picker image, so not pickable) before the display/area filters.
  const excludedIds = new Set(excludeWindowIds);
  const candidates = snapshot.filter(
    (w) =>
      !excludedIds.has(w.windowId) &&
      !(ourPids.has(w.pid) && matchesExcludedBounds(w.bounds, excludeWindowBounds))
  );

  // Step 1: keep windows that overlap the active display. Anything
  // entirely on another monitor is irrelevant to this selector.
  const onThisDisplay = candidates.filter((w) => {
    const wx2 = w.bounds.x + w.bounds.width;
    const wy2 = w.bounds.y + w.bounds.height;
    const dx2 = displayBounds.x + displayBounds.width;
    const dy2 = displayBounds.y + displayBounds.height;
    return wx2 > displayBounds.x && w.bounds.x < dx2 && wy2 > displayBounds.y && w.bounds.y < dy2;
  });

  // Step 2: previously a per-app frontmost collapse — kept only the
  // first window per pid, on the theory that subsequent same-pid
  // entries were panels / toolbars the user wouldn't mean by "snap
  // to that app." That heuristic was wrong for any app with multiple
  // top-level windows (terminals, browsers, Finder, IDEs). The
  // collapse hid the very window the user was hovering, and the
  // hit-test fell through to whatever was layered behind it.
  //
  // We now keep every window from the prior filter pass. The Swift
  // helper already drops menu-bar / dock / status items by layer,
  // invisible windows by alpha, and known system chrome by bundle
  // id, so what arrives here is broadly legitimate top-level
  // content. The MIN_AREA_PX gate below removes sub-pixel tracking
  // strips. Z-order hit-testing in `findWindowAt` returns whichever
  // window is visually topmost at the cursor; if a panel happens to
  // be there, snapping to it is correct (it's what the user is
  // pointing at). Tab in the selector cycles through candidates at
  // the cursor, which is more useful with all windows present.
  const meaningful = onThisDisplay;

  // No visibility / occlusion filter. Showing a window's outline
  // even when it's mostly obscured matches what every other capture
  // tool does — the user wants to capture the WINDOW, not the
  // visible-fragment of the window. The screen snapshot already
  // covers the visual; the snap highlight just tags the bounds.
  const localized = meaningful
    .map((w, idx) => ({ w, idx }))
    .filter(({ w }) => w.bounds.width * w.bounds.height >= MIN_AREA_PX)
    .map(({ w, idx }) => ({
      windowId: w.windowId,
      pid: w.pid,
      bundleId: w.bundleId,
      appName: w.appName,
      title: w.title,
      // Legacy diagnostic field retained for preload/API shape
      // stability. PwrSnap-owned user windows are now snappable.
      ownedByUs: ourPids.has(w.pid),
      // listWindows returns z-order ascending (index 0 = frontmost).
      // After our `meaningful` filter, indices change but z-order is
      // preserved, so the array index continues to work.
      zIndex: idx,
      // Rect = rawRect; we no longer split visible-bbox from raw
      // bounds. Both fields stay so the renderer doesn't need a shape
      // change, but they're identical now.
      rect: {
        x: w.bounds.x - displayBounds.x,
        y: w.bounds.y - displayBounds.y,
        w: w.bounds.width,
        h: w.bounds.height
      },
      rawRect: {
        x: w.bounds.x - displayBounds.x,
        y: w.bounds.y - displayBounds.y,
        w: w.bounds.width,
        h: w.bounds.height
      }
    }));

  // Compact summary — one line at info level. The detailed candidate
  // dump and selector geometry sit at debug level so they're available
  // for diagnosis (turn on with `electron-log` debug) without flooding
  // the dev terminal every pickRegion call.
  const b = targetDisplay.bounds;
  log.info(
    `snap candidates display=${targetDisplay.id} bounds=${b.x},${b.y} ${b.width}×${b.height}` +
      ` raw=${rawSnapshot.length} onDisplay=${onThisDisplay.length}` +
      ` meaningful=${meaningful.length} kept=${localized.length}`
  );

  // Diagnostic: warn when CGWindowList's z=0 disagrees with the
  // system's frontmost-app pid. Background: the snap picker's hit-
  // test trusts CGWindowList's "front-to-back" ordering — `findWindowAt`
  // walks the list and returns the first window containing the
  // cursor. When CGWindowList z=0 doesn't match the actual frontmost
  // app, the picker can snap to a window the user perceives as
  // "behind" the visually-on-top window (e.g. cursor over the Library
  // gets reported as snapping to Claude). This is the smoking gun for
  // that class of bug — see the "window-picker selecting wrong z-order"
  // investigation in the dock-icon fix PR for the full story.
  //
  // Skipped when frontmostPid is null (non-darwin or pre-envelope
  // helper) or the snapshot is empty.
  if (frontmostPid !== null && snapshot.length > 0) {
    const topWindow = snapshot[0]!;
    if (topWindow.pid !== frontmostPid) {
      log.warn(
        `snap candidates: CGWindowList z=0 (pid=${topWindow.pid} app=${topWindow.appName ?? "?"}` +
          ` window=${topWindow.windowId}) disagrees with NSWorkspace.frontmostApplication` +
          ` (pid=${frontmostPid} bundle=${frontmostBundleId ?? "?"}) — the snap picker may` +
          ` choose a window the user perceives as behind the visually-on-top one`
      );
    }
  }

  log.debug("snap candidates detail", {
    display: {
      id: targetDisplay.id,
      bounds: targetDisplay.bounds,
      workArea: targetDisplay.workArea,
      scaleFactor: targetDisplay.scaleFactor
    },
    selectorWindow: {
      bounds: selectorWindow.getBounds(),
      contentBounds: selectorWindow.getContentBounds(),
      isSimpleFullScreen: selectorWindow.isSimpleFullScreen()
    },
    ourPids: Array.from(ourPids),
    frontmost: {
      pid: frontmostPid,
      bundleId: frontmostBundleId
    },
    candidates: localized.map((c) => ({
      z: c.zIndex,
      id: c.windowId,
      app: c.appName,
      ours: c.ownedByUs,
      rect: c.rect
    }))
  });

  return {
    snapshot,
    ...previousApp,
    payload: {
      windows: localized,
      displayBounds: {
        width: displayBounds.width,
        height: displayBounds.height
      },
      cursor: displayCursor
    }
  };
}

function isSelectorOverlayWindow(
  windowInfo: WindowInfo,
  displayBounds: { x: number; y: number; width: number; height: number },
  ourPids: Set<number>,
  selectorWindow: BrowserWindow
): boolean {
  if (!ourPids.has(windowInfo.pid)) return false;
  if (windowInfo.title === SELECTOR_WINDOW_TITLE) return true;
  if (windowInfo.title !== null && windowInfo.title.trim() !== "") return false;
  return (
    boundsApproxEqual(windowInfo.bounds, displayBounds) &&
    boundsApproxEqual(windowInfo.bounds, selectorWindow.getBounds())
  );
}

const SELECTOR_GLOBAL_KEYS = ["Escape", "Return"] as const;
type SelectorGlobalKey = (typeof SELECTOR_GLOBAL_KEYS)[number];

let selectorShortcutWindow: BrowserWindow | null = null;
let selectorShortcutsSuspended = false;
const ownedSelectorShortcuts = new Set<SelectorGlobalKey>();

function releaseOwnedSelectorGlobalShortcuts(): void {
  for (const accelerator of ownedSelectorShortcuts) {
    try {
      globalShortcut.unregister(accelerator);
    } catch (cause) {
      log.warn("selector global shortcut unregister threw", {
        accelerator,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  ownedSelectorShortcuts.clear();
}

function armSelectorGlobalShortcuts(): void {
  if (selectorShortcutsSuspended || selectorShortcutWindow === null) return;

  for (const accelerator of SELECTOR_GLOBAL_KEYS) {
    if (ownedSelectorShortcuts.has(accelerator)) continue;
    try {
      const registered = globalShortcut.register(accelerator, () => {
        const win = selectorShortcutWindow;
        if (selectorShortcutsSuspended || win === null || win.isDestroyed()) return;
        win.webContents.send(SELECTOR_KEY_CHANNEL, {
          key: accelerator === "Escape" ? "Escape" : "Enter"
        });
      });
      if (registered) {
        ownedSelectorShortcuts.add(accelerator);
      } else {
        log.warn("selector global shortcut unavailable", { accelerator });
      }
    } catch (cause) {
      log.warn("selector global shortcut registration threw", {
        accelerator,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
}

function installSelectorGlobalShortcuts(win: BrowserWindow): void {
  selectorShortcutWindow = win;
  // Forward to the renderer via the same IPC the renderer's own
  // keydown handlers use, so the cancel/commit code path stays
  // single-sourced. The renderer handler reads the freshest rect
  // and snap state and emits submitRegion accordingly.
  armSelectorGlobalShortcuts();
}

function uninstallSelectorGlobalShortcuts(): void {
  selectorShortcutWindow = null;
  releaseOwnedSelectorGlobalShortcuts();
}

hotkeyRecorderSuspension.registerParticipant({
  id: "region-selector-global-shortcuts",
  suspend(): void {
    selectorShortcutsSuspended = true;
    releaseOwnedSelectorGlobalShortcuts();
  },
  restore(): void {
    selectorShortcutsSuspended = false;
    armSelectorGlobalShortcuts();
  }
});

/**
 * The window-list snapshot taken at the most recent pickRegion call.
 * Capture handlers query this to backfill source-app metadata on
 * commit (no need to re-shell to the helper — the snapshot from the
 * moment of capture is exactly the right point-in-time).
 */
export function getLastWindowListSnapshot(): readonly WindowInfo[] {
  return lastSnapshot;
}

/**
 * Hide every pre-warmed selector window. Called by the capture handler
 * AFTER it has populated the float-over to LOADED — the selector hide
 * reveals an already-painted toast at the floating level (no flash, no
 * post-hoc show race). Also called on cancel paths after the float-over
 * has been hidden synchronously.
 *
 * Public sibling of the historical `hideAllSelectors`. The internal
 * function name is preserved to keep diffs small.
 */
export function hideSelector(): void {
  hideAllSelectors();
}

function hideAllSelectors(): void {
  // Release the globalShortcut binding before we lower the window;
  // leaving Esc / ↵ globally bound after the selector is gone would
  // hijack those keys for the rest of the app session.
  uninstallSelectorGlobalShortcuts();
  // Release the screen snapshot UNLESS ownership has already
  // transferred to a consumer (the OK code path clears
  // `activeScreenSnapshot` before calling hideAllSelectors). On
  // cancel / destroyed paths the snapshot is still ours; clean up.
  releaseActiveScreenSnapshot();
  const rebuildAfterHide: { displayId: number; staleWindow: BrowserWindow }[] = [];
  for (const [displayId, win] of selectorWindows) {
    if (win.isDestroyed()) continue;
    // Order: leave overlay → blur → hide.
    // On macOS a screen-saver-level always-on-top window that just
    // calls `hide()` can leave the OS still routing keyboard input
    // to it — the user ends up unable to click anywhere until the
    // focus is forcibly relinquished. setSimpleFullScreen(false)
    // also has to come before hide() or the next show() inherits
    // a partial-overlay state.
    leaveMenuBarOverlayMode(win);
    win.blur();
    win.hide();
    const frameInvocationId = selectorFrameInvocationIds.get(win);
    if (frameInvocationId !== undefined) {
      selectorFrameInvocationIds.delete(win);
      // The renderer keeps the full frozen display only until the selector is
      // actually hidden. Release after hide so clearing the canvas can never
      // flash an empty surface during the capture handoff.
      win.webContents.send(SELECTOR_FRAME_RELEASE_CHANNEL, {
        invocationId: frameInvocationId
      });
      log.info("picker frozen frame release requested", {
        invocationId: frameInvocationId,
        displayId
      });
    }
    // macOS simple-fullscreen + non-activating NSPanel does not fully
    // reset to the fresh pre-warm state after one show/hide cycle. The
    // first selector after launch can cover menu bar + Dock correctly,
    // while the reused panel after Esc/commit can fall back under that
    // system chrome. Destroy and recreate the hidden panel so every
    // subsequent capture starts from the same state as the first one.
    if (process.platform === "darwin" && selectorDisplaysNeedingFreshPanel.has(displayId)) {
      rebuildAfterHide.push({ displayId, staleWindow: win });
    }
  }
  for (const { displayId, staleWindow } of rebuildAfterHide) {
    swapFreshSelectorForDisplay(displayId, staleWindow);
  }
  const activationRestore = pendingProtectedWindowActivationRestore;
  pendingProtectedWindowActivationRestore = null;
  if (activationRestore !== null && !activationRestore.isDestroyed()) {
    if (!activationRestore.isVisible()) activationRestore.show();
    activationRestore.focus();
  }
  // Note: previously-frontmost app activation moved OUT of here. The
  // capture handler now calls `activateApp(previousAppPid)` AFTER it
  // has populated the float-over to LOADED, so the toast is up on
  // screen before we yield focus to the previous app. This is what
  // wins the z-order race that used to leave the toast hidden behind
  // the previous app's key window. See docs/plans/2026-05-04-001
  // §"Solution 4".

  // Windows: while the selector was up (topmost screen-saver level, and on
  // win32 native-fullscreen to cover the taskbar), the post-capture toast
  // could NOT be made topmost — setAlwaysOnTop(true) during show-loaded
  // silently didn't stick (isAlwaysOnTop stayed false, confirmed via the
  // diagnostic log), so the toast rendered behind the Library. show-idle
  // worked because the selector wasn't shown yet. Now that the selector is
  // hidden, re-raise the (already-loaded) toast so it actually appears.
  // ensureFloatOverTopmost polls until isAlwaysOnTop() confirms the raise
  // took — setFullScreen(false) exits asynchronously, so a single assert can
  // land mid-transition; the loop self-terminates the instant it sticks.
  if (process.platform === "win32") {
    ensureFloatOverTopmost();
  }
}

/**
 * Cover the entire display, including the macOS menu bar.
 *
 * The bug: even at `screen-saver` always-on-top level, a frameless
 * Electron window will not draw over the macOS menu bar. The dock
 * sits below the user-facing app windows in the z-order, so our
 * screen-saver-level overlay covers it; the menu bar is special-cased
 * by Cocoa and lives at NSMainMenuWindowLevel (24) but with an
 * additional system-level prohibition against ordinary app windows
 * drawing over it.
 *
 * The fix: macOS has a "simple fullscreen" mode (introduced in
 * 10.7-era APIs as the legacy fallback to native space-animation
 * fullscreen). It puts the window into a borderless, menu-bar-
 * covering overlay without animating into a separate Mission Control
 * space — exactly what every screen-capture tool (Cleanshot, Shottr,
 * SnagIt) does. Toggle it on at show, off at hide so the pre-warmed
 * window can return to its normal-bounds state for next time.
 */
function enterMenuBarOverlayMode(win: BrowserWindow): void {
  if (process.platform === "win32") {
    // Windows: the taskbar (Shell_TrayWnd) is itself topmost, so a plain
    // always-on-top overlay renders BELOW it — the real taskbar shows through
    // on top of the frozen screenshot (which already includes a taskbar →
    // "two taskbars"). Native fullscreen spans the whole monitor including the
    // taskbar, so the overlay covers it. (Verified working on Windows; the
    // earlier 0xC0000005 crash was an unrelated tray-right-click bug.)
    //
    // Note: setFullScreen(true) grows the window to the full display (taskbar
    // covered) but isFullScreen() stays false on Windows, and the
    // enter/leave-full-screen events don't reliably fire — so the post-capture
    // toast can't rely on a leave-full-screen event to re-raise itself. The
    // re-raise is driven from hideAllSelectors instead.
    //
    // Call unconditionally — do NOT guard on isFullScreen(): it's unreliable
    // here (stays false even after a successful setFullScreen(true)), so a
    // guard would either no-op when it shouldn't or, on the leave side, leave
    // the window stuck full-screen. setFullScreen(true) on an already-grown
    // window is a harmless no-op, and this stays correct if a future Electron
    // makes isFullScreen() accurate. leaveMenuBarOverlayMode mirrors this.
    win.setFullScreen(true);
    return;
  }
  if (process.platform !== "darwin") return;
  if (!win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(true);
  }
  // Defensive re-anchor: setSimpleFullScreen(true) on Cocoa
  // sometimes leaves the window's content area at a size that
  // doesn't match the display's logical bounds — the renderer's
  // CSS coord space ends up scaled relative to display.bounds and
  // every rect we paint comes out 2× too large (or otherwise
  // mis-scaled). Force the content rect to display.bounds so the
  // renderer's pixel space is 1:1 with display logical points.
  // No-op when bounds already match.
  const display = screen.getDisplayMatching(win.getBounds());
  win.setContentBounds(display.bounds);
}

function leaveMenuBarOverlayMode(win: BrowserWindow): void {
  if (process.platform === "win32") {
    // Unconditional, NOT guarded on isFullScreen(): that getter stays false on
    // Windows even while the window is grown full-screen (see
    // enterMenuBarOverlayMode), so `if (win.isFullScreen())` would never fire
    // and the window would stay stuck at full-monitor size — the real taskbar
    // would never come back and the next capture's pre-warmed window would
    // start oversized. setFullScreen(false) on a non-fullscreen window is a
    // no-op, so calling it unconditionally is safe.
    win.setFullScreen(false);
    return;
  }
  if (process.platform !== "darwin") return;
  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false);
  }
}

function createSelectorWindow(
  display: Display,
  reason: SelectorPrewarmReason = "startup"
): BrowserWindow {
  // Anchor to display.bounds. The selector enters simple-fullscreen
  // on show (covering the real menu bar) and paints its own copy of
  // the menu bar via the screen snapshot — so the user sees what
  // they expect AND we get a window-local coord space that matches
  // display logical px 1:1.
  const { bounds } = display;
  const window = new BrowserWindow({
    // `type: 'panel'` — NSPanel + NSWindowStyleMaskNonactivatingPanel.
    // Same primitive used by createFloatOverWindow / createTrayWindow.
    // The selector's show()/focus() must NOT cause macOS to switch
    // Spaces. A regular NSWindow, even with the canJoinAllSpaces flag
    // (setVisibleOnAllWorkspaces below), can still trigger AppKit's
    // "find the Space this window belongs to and switch to it" path
    // when the owning app is brought frontmost via show()/focus() —
    // and that path is what Splashtop's separate Space exposes. The
    // non-activating panel skips the app-activation step entirely,
    // so AppKit never has a reason to swap Spaces on the user.
    //
    // (`focusable: true` below is still respected for NSPanel; the
    // float-over uses the same combination to receive clicks/keys
    // without activating the app.)
    //
    // macOS-only — Windows/Linux have no NSPanel; the frameless,
    // transparent, always-on-top window below covers the display directly
    // (setSimpleFullScreen / enterMenuBarOverlayMode are already
    // darwin-gated).
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    title: SELECTOR_WINDOW_TITLE,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // Windows needs native fullscreen (enterMenuBarOverlayMode) to draw OVER
    // the taskbar (a topmost window a plain always-on-top overlay can't cover),
    // so it must be fullscreenable there. macOS uses setSimpleFullScreen and
    // keeps this false.
    fullscreenable: process.platform === "win32",
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Every platform prewarms this renderer hidden. The Linux legacy-file
      // path also waits for a hidden two-rAF decode barrier, so throttling it
      // can stall the picker until the 12-second paint deadline.
      backgroundThrottling: false,
      // The renderer needs the display id baked in so it can post the
      // right value back to main on commit. Pass via a query string.
      additionalArguments: [`--display-id=${display.id}`]
    }
  });
  window.setTitle(SELECTOR_WINDOW_TITLE);
  window.once("closed", () => handleSelectorWindowClosed(display.id, window));
  window.webContents.on("render-process-gone", (_event, details) => {
    handleSelectorRenderProcessGone(display.id, window, details.reason);
  });

  // Highest-of-windows ordering — clears menu bar / other overlays.
  window.setAlwaysOnTop(true, "screen-saver");
  // visibleOnAllWorkspaces + visibleOnFullScreen — the selector must
  // appear on the user's CURRENT Space, regardless of which Space the
  // pre-warmed window was originally constructed on. Without this,
  // running PwrSnap alongside an app that holds its own Space (notably
  // Splashtop, the remote-desktop client) causes macOS to swap Spaces
  // to wherever the selector window was last associated on show —
  // the bug reported as "workspace shift on capture with Splashtop."
  // Paired with `type: 'panel'` above: the panel keeps show()/focus()
  // from activating the app, and canJoinAllSpaces (set here) keeps
  // the panel from being pinned to any single Space.
  // Spaces are macOS-only; on Windows/Linux this call is unnecessary (and
  // the visibleOnFullScreen option is a macOS concept).
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  const loadStartedAt = Date.now();
  selectorPrewarmTimings.set(display.id, {
    reason,
    startedAt: loadStartedAt,
    loadedAt: null
  });
  log.info("pre-warming capture selector", {
    displayId: display.id,
    reason,
    bounds
  });

  const target = rendererTarget(display.id);
  const load =
    target.kind === "url"
      ? window.loadURL(target.url)
      : window.loadFile(target.path, { hash: target.hash });
  selectorWindowLoads.set(
    window,
    load.then(
      () => {
        log.info("region selector renderer loaded", {
          displayId: display.id,
          reason,
          durationMs: Date.now() - loadStartedAt
        });
        const timing = selectorPrewarmTimings.get(display.id);
        if (timing !== undefined && timing.startedAt === loadStartedAt) {
          timing.loadedAt = Date.now();
        }
        return true;
      },
      (err: unknown) => {
        if (!window.isDestroyed()) {
          log.warn("region selector renderer failed to load", {
            displayId: display.id,
            message: err instanceof Error ? err.message : String(err)
          });
        }
        return false;
      }
    )
  );
  return window;
}

function scheduleStandbySelectorWarm(display: Display): void {
  if (process.platform !== "darwin") return;
  const existing = standbySelectorWindows.get(display.id);
  if (existing !== undefined && !existing.isDestroyed()) return;
  if (standbyWarmScheduled.has(display.id)) return;
  standbyWarmScheduled.add(display.id);
  log.info("pre-warming next capture selector scheduled", {
    displayId: display.id
  });
  setTimeout(() => {
    standbyWarmScheduled.delete(display.id);
    warmStandbySelectorForDisplay(display);
  }, 0);
}

function warmStandbySelectorForDisplay(display: Display): void {
  if (process.platform !== "darwin") return;
  const existing = standbySelectorWindows.get(display.id);
  if (existing !== undefined) {
    if (!existing.isDestroyed()) return;
    standbySelectorWindows.delete(display.id);
  }
  const win = createSelectorWindow(display, "standby");
  standbySelectorWindows.set(display.id, win);
}

function selectorPrewarmAgePayload(displayId?: number): {
  sinceLastPrewarmStartedMs?: number;
  sinceLastPrewarmLoadedMs?: number;
  lastPrewarmReason?: SelectorPrewarmReason;
  lastPrewarmDisplayId?: number;
} {
  const now = Date.now();
  let selectedDisplayId: number | undefined = displayId;
  let selected: SelectorPrewarmTiming | undefined =
    displayId === undefined ? undefined : selectorPrewarmTimings.get(displayId);
  if (selected === undefined) {
    for (const [candidateDisplayId, timing] of selectorPrewarmTimings) {
      if (selected === undefined || timing.startedAt > selected.startedAt) {
        selectedDisplayId = candidateDisplayId;
        selected = timing;
      }
    }
  }
  if (selected === undefined) return {};
  const payload: {
    sinceLastPrewarmStartedMs: number;
    sinceLastPrewarmLoadedMs?: number;
    lastPrewarmReason: SelectorPrewarmReason;
    lastPrewarmDisplayId?: number;
  } = {
    lastPrewarmReason: selected.reason,
    sinceLastPrewarmStartedMs: now - selected.startedAt
  };
  if (selectedDisplayId !== undefined) {
    payload.lastPrewarmDisplayId = selectedDisplayId;
  }
  if (selected.loadedAt !== null) {
    payload.sinceLastPrewarmLoadedMs = now - selected.loadedAt;
  }
  return payload;
}

async function waitForSelectorWindowLoad(displayId: number, win: BrowserWindow): Promise<boolean> {
  const load = selectorWindowLoads.get(win);
  if (load === undefined) {
    return !win.isDestroyed() && selectorWindows.get(displayId) === win;
  }
  const loaded = await load;
  return loaded && !win.isDestroyed() && selectorWindows.get(displayId) === win;
}

function rebuildSelectorForDisplay(displayId: number): void {
  destroyStandbySelectorForDisplay(displayId);
  const existing = selectorWindows.get(displayId);
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.destroy();
  }
  selectorWindows.delete(displayId);
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return;
  const win = createSelectorWindow(display, "rebuild");
  selectorWindows.set(displayId, win);
}

function swapFreshSelectorForDisplay(displayId: number, staleWindow: BrowserWindow): void {
  selectorDisplaysNeedingFreshPanel.delete(displayId);
  const standby = standbySelectorWindows.get(displayId);
  standbySelectorWindows.delete(displayId);
  selectorWindows.delete(displayId);
  if (!staleWindow.isDestroyed()) {
    staleWindow.destroy();
  }
  if (standby !== undefined && !standby.isDestroyed()) {
    selectorWindows.set(displayId, standby);
    return;
  }
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return;
  const win = createSelectorWindow(display, "swap-fallback");
  selectorWindows.set(displayId, win);
}

function destroyStandbySelectorForDisplay(displayId: number): void {
  standbyWarmScheduled.delete(displayId);
  const standby = standbySelectorWindows.get(displayId);
  if (standby !== undefined && !standby.isDestroyed()) {
    standby.destroy();
  }
  standbySelectorWindows.delete(displayId);
}

/**
 * Update the selector window's bounds in place to match a display's
 * current bounds. Preferred over rebuild when the display still exists
 * — preserves the loaded renderer + the show/hide state, and dodges
 * the destroy-during-show race that hits us when simple-fullscreen
 * fires `display-metrics-changed` mid-overlay.
 */
function resizeSelectorToDisplay(display: Display): void {
  const win = selectorWindows.get(display.id);
  if (win === undefined || win.isDestroyed()) {
    // Display exists but we don't have a selector for it — fall back
    // to creating one. Cheaper than rebuild because there's no
    // window to destroy.
    rebuildSelectorForDisplay(display.id);
    return;
  }
  // Mirror the createSelectorWindow choice: anchor to display.bounds.
  const { bounds } = display;
  const current = win.getBounds();
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) {
    return; // already matches — nothing to do
  }
  win.setBounds(bounds);
  const standby = standbySelectorWindows.get(display.id);
  if (standby !== undefined && !standby.isDestroyed()) {
    standby.setBounds(bounds);
  }
}

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash: string };

function rendererTarget(displayId: number): RendererTarget {
  const hash = `stage=region&displayId=${displayId}`;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined) {
    return {
      kind: "url",
      url: `${process.env.ELECTRON_RENDERER_URL}#${hash}`
    };
  }
  return {
    kind: "file",
    path: join(__dirname, "../renderer/index.html"),
    hash
  };
}

function isSelectorPayload(value: unknown): value is {
  ok: true;
  rect: { x: number; y: number; w: number; h: number };
  displayId: number;
  snappedWindowId?: number;
  fullWindow?: boolean;
  captureCursor?: boolean;
} {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true) return false;
  const rect = v.rect as Record<string, unknown> | undefined;
  if (rect === undefined) return false;
  if (
    typeof rect.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.w !== "number" ||
    typeof rect.h !== "number" ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h) ||
    rect.w <= 0 ||
    rect.h <= 0 ||
    typeof v.displayId !== "number" ||
    !Number.isInteger(v.displayId)
  ) {
    return false;
  }
  // snappedWindowId is optional but must be a number if present.
  if (v.snappedWindowId !== undefined && typeof v.snappedWindowId !== "number") {
    return false;
  }
  if (v.fullWindow !== undefined && typeof v.fullWindow !== "boolean") {
    return false;
  }
  if (v.captureCursor !== undefined && typeof v.captureCursor !== "boolean") {
    return false;
  }
  return true;
}

export function disposeRegionSelector(): void {
  teardownActiveSelectorLifecycle("dispose");
  pendingProtectedWindowActivationRestore = null;
  supersedeSelectorWaiters();
  uninstallSelectorGlobalShortcuts();
  releaseActiveScreenSnapshot();
  lastSnapshot = [];

  for (const win of [...selectorWindows.values()]) {
    if (!win.isDestroyed()) win.destroy();
  }
  selectorWindows.clear();
  for (const win of [...standbySelectorWindows.values()]) {
    if (!win.isDestroyed()) win.destroy();
  }
  standbySelectorWindows.clear();
  standbyWarmScheduled.clear();
  selectorDisplaysNeedingFreshPanel.clear();
  if (resultListenerAttached) {
    ipcMain.removeAllListeners(SELECTOR_CROP_PORT_CHANNEL);
    ipcMain.removeAllListeners(SELECTOR_RESULT_CHANNEL);
    ipcMain.removeAllListeners(SELECTOR_PAINTED_CHANNEL);
    ipcMain.removeAllListeners(SELECTOR_DIAGNOSTICS_CHANNEL);
    ipcMain.removeAllListeners(SELECTOR_PERFORMANCE_CHANNEL);
    ipcMain.removeAllListeners(SELECTOR_PRESENTED_CHANNEL);
    resultListenerAttached = false;
  }
  if (displayListenersAttached) {
    screen.removeListener("display-metrics-changed", handleDisplayMetricsChanged);
    screen.removeListener("display-added", handleDisplayAdded);
    screen.removeListener("display-removed", handleDisplayRemoved);
    displayListenersAttached = false;
  }
}

export const REGION_SELECTOR_RESULT_CHANNEL = SELECTOR_RESULT_CHANNEL;
export const REGION_SELECTOR_WINDOW_LIST_CHANNEL = SELECTOR_WINDOW_LIST_CHANNEL;
export const REGION_SELECTOR_KEY_CHANNEL = SELECTOR_KEY_CHANNEL;
export const REGION_SELECTOR_MODE_CHANNEL = SELECTOR_MODE_CHANNEL;
export const REGION_SELECTOR_PRESENTATION_ARM_CHANNEL = SELECTOR_PRESENTATION_ARM_CHANNEL;
export const REGION_SELECTOR_PRESENTED_CHANNEL = SELECTOR_PRESENTED_CHANNEL;
