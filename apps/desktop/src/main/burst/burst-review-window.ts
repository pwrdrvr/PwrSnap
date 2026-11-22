// The Burst Review window's lifecycle, tied to its session.
//
// - Stop opens it (recording-service → openBurstReviewWindow).
// - Keep / Discard end the session; the session's "closed" notice closes
//   the window.
// - Closing the window is a discard. With stills still unkept it asks
//   first, because the stills exist nowhere else and the close button is
//   one stray click away.

import { app, dialog } from "electron";
import { closeBurstReviewWindow, showBurstReviewWindow } from "../window";
import { getMainLogger } from "../log";
import { onSizzleQuitCancelled } from "../sizzle/sizzle-close-barrier";
import { notifyWindowCloseCancelled } from "../window-close-cancellation";
import {
  discardAllBurstsSync,
  discardBurst,
  discardBurstSync,
  getBurstSessionView,
  onBurstSessionChange
} from "./burst-session";

const log = getMainLogger("pwrsnap:burst-review");

let wired = false;
/** Quitting: a review window closes without asking, and takes its stills. */
let quitting = false;

function wire(): void {
  if (wired) return;
  wired = true;
  app.on("before-quit", () => {
    quitting = true;
  });
  // A quit can be called off (Sizzle's unsaved-changes Cancel). Left set,
  // the flag would skip the confirm on every later close.
  onSizzleQuitCancelled(() => {
    quitting = false;
  });
  app.on("will-quit", () => discardAllBurstsSync());
  onBurstSessionChange((burstId, state) => {
    if (state === "closed") closeBurstReviewWindow(burstId);
  });
}

function unkeptFrames(burstId: string): number {
  const view = getBurstSessionView(burstId);
  return view === null ? 0 : view.frames.length - view.keptIndexes.length;
}

export function openBurstReviewWindow(burstId: string): void {
  wire();
  showBurstReviewWindow(burstId, {
    needsConfirm: () => !quitting && unkeptFrames(burstId) > 0,
    confirm: async (window) => {
      const unkept = unkeptFrames(burstId);
      if (unkept === 0) return true;
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        message: `Discard ${unkept} ${unkept === 1 ? "frame" : "frames"}?`,
        detail: "Burst frames you don’t keep are deleted. They aren’t saved anywhere else.",
        buttons: ["Discard", "Go Back"],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      const discard = response === 0;
      if (!discard && !window.isDestroyed()) notifyWindowCloseCancelled();
      return discard;
    },
    // However the window went (confirmed close, quit, crash), its stills go.
    onClosed: () => {
      // Only THIS burst: other review windows decide for their own stills
      // (and will-quit sweeps whatever is left when the quit goes through).
      if (quitting) {
        discardBurstSync(burstId);
        return;
      }
      void discardBurst(burstId).catch((cause: unknown) => {
        log.warn("burst discard on close failed", {
          burstId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
    }
  });
}
