import type { App, BrowserWindow } from "electron";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { retryQuitAfterDispatch } from "../quit-retry";

type CloseBarrierState = {
  window: BrowserWindow;
  nextRequestId: number;
  pendingRequestId: number | null;
  requestSent: boolean;
  rendererReady: boolean;
  allowNextClose: boolean;
};

type QuitApp = Pick<App, "on" | "quit">;

const barriers = new Map<number, CloseBarrierState>();
let quitApp: QuitApp | null = null;
let deferredQuit: CloseBarrierState | null = null;
let quitAttempt = 0;
const quitCancelledListeners = new Set<() => void>();

function resumeDeferredQuit(): void {
  deferredQuit = null;
  const app = quitApp;
  const attempt = quitAttempt;
  retryQuitAfterDispatch(() => {
    if (attempt === quitAttempt) app?.quit();
  });
}

/** Observe an explicit cancellation of app quit, rather than a pending save. */
export function onSizzleQuitCancelled(listener: () => void): () => void {
  quitCancelledListeners.add(listener);
  return () => { quitCancelledListeners.delete(listener); };
}

function sendPendingRequest(state: CloseBarrierState): void {
  if (
    state.pendingRequestId === null ||
    state.requestSent ||
    !state.rendererReady ||
    state.window.webContents.isDestroyed()
  ) {
    return;
  }
  try {
    state.window.webContents.send(EVENT_CHANNELS.sizzleCloseRequested, {
      requestId: state.pendingRequestId
    });
    state.requestSent = true;
  } catch {
    // A reload can invalidate webContents between the readiness check and
    // send. Keep the request queued; the next ready handshake retransmits it.
    state.rendererReady = false;
    state.requestSent = false;
  }
}

function requestClose(state: CloseBarrierState): void {
  if (state.pendingRequestId === null) {
    state.pendingRequestId = state.nextRequestId;
    state.nextRequestId += 1;
    state.requestSent = false;
  }
  sendPendingRequest(state);
}

/**
 * Install before transient-window teardown. A first app.quit() is deferred
 * while Sizzle saves; the successful close response retries app.quit(), so
 * Electron performs its normal before-quit/window-close/will-quit sequence.
 */
export function installSizzleQuitBarrier(app: QuitApp): void {
  quitApp = app;
  app.on("before-quit", (event) => {
    const state = [...barriers.values()].find(
      (candidate) =>
        !candidate.window.isDestroyed() && !candidate.allowNextClose
    );
    if (state === undefined) return;

    event.preventDefault();
    deferredQuit = state;
    requestClose(state);
  });
}

/** True only during the first, intentionally deferred before-quit pass. */
export function isSizzleQuitDeferred(): boolean {
  return deferredQuit !== null;
}

/**
 * Pause a native Sizzle-window close until the renderer has either persisted
 * every local edit or received an explicit discard confirmation from the user.
 */
export function wireSizzleCloseBarrier(window: BrowserWindow): void {
  const state: CloseBarrierState = {
    window,
    nextRequestId: 1,
    pendingRequestId: null,
    requestSent: false,
    rendererReady: false,
    allowNextClose: false
  };
  barriers.set(window.id, state);

  window.webContents.on("did-start-loading", () => {
    state.rendererReady = false;
    state.requestSent = false;
  });

  window.on("close", (event) => {
    if (state.allowNextClose) {
      state.allowNextClose = false;
      return;
    }
    if (window.webContents.isDestroyed()) return;

    event.preventDefault();
    requestClose(state);
  });

  window.on("closed", () => {
    if (barriers.get(window.id) === state) barriers.delete(window.id);
    // destroy() bypasses close and can win while a save acknowledgement is
    // pending. Its window can no longer answer, so release only its barrier.
    if (deferredQuit === state) resumeDeferredQuit();
  });
}

/** Mark the renderer listener live, then deliver any close queued before mount. */
export function markSizzleCloseRendererReady(windowId: number): boolean {
  const state = barriers.get(windowId);
  if (state === undefined || state.window.isDestroyed()) return false;
  state.rendererReady = true;
  sendPendingRequest(state);
  return true;
}

/** Resolve the matching close request. Stale renderer responses are ignored. */
export function completeSizzleCloseRequest(
  windowId: number,
  requestId: number,
  action: "close" | "cancel"
): boolean {
  const state = barriers.get(windowId);
  if (
    state === undefined ||
    state.window.isDestroyed() ||
    state.pendingRequestId !== requestId
  ) {
    return false;
  }

  state.pendingRequestId = null;
  state.requestSent = false;
  if (action === "cancel") {
    const cancelledQuit = deferredQuit !== null;
    deferredQuit = null;
    // Also revoke a successful save's retry queued before this cancellation.
    quitAttempt += 1;
    if (cancelledQuit) {
      for (const listener of quitCancelledListeners) listener();
    }
    return true;
  }

  state.allowNextClose = true;
  if (deferredQuit !== null && quitApp !== null) {
    resumeDeferredQuit();
  } else {
    state.window.close();
  }
  return true;
}
