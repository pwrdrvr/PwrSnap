import type { BrowserWindow } from "electron";
import { EVENT_CHANNELS } from "@pwrsnap/shared";

type CloseBarrierState = {
  window: BrowserWindow;
  nextRequestId: number;
  pendingRequestId: number | null;
  allowNextClose: boolean;
};

const barriers = new Map<number, CloseBarrierState>();

/**
 * Pause a native Sizzle-window close until the renderer has either persisted
 * every local edit or received an explicit discard confirmation from the user.
 */
export function wireSizzleCloseBarrier(window: BrowserWindow): void {
  const state: CloseBarrierState = {
    window,
    nextRequestId: 1,
    pendingRequestId: null,
    allowNextClose: false
  };
  barriers.set(window.id, state);

  window.on("close", (event) => {
    if (state.allowNextClose) {
      state.allowNextClose = false;
      return;
    }
    if (window.webContents.isDestroyed()) return;

    event.preventDefault();
    if (state.pendingRequestId !== null) return;

    const requestId = state.nextRequestId;
    state.nextRequestId += 1;
    state.pendingRequestId = requestId;
    window.webContents.send(EVENT_CHANNELS.sizzleCloseRequested, { requestId });
  });

  window.on("closed", () => {
    if (barriers.get(window.id) === state) barriers.delete(window.id);
  });
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
  if (action === "cancel") return true;

  state.allowNextClose = true;
  state.window.close();
  return true;
}
