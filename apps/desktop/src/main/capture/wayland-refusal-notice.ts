// The user-visible half of the Wayland region-selector refusal.
//
// Kept out of linux-session.ts on purpose: that module is pure — env in,
// verdict out — and its unit tests import it with no Electron stub. This
// one talks to `dialog` and the command bus, so the impurity stays where
// it can be seen.
//
// Why the notice hangs off the refusal in the handler rather than off
// each trigger: it has to be visible from EVERY entry point, and it was
// not. `capture-trigger.ts` (global hotkeys, native tray menu) observed
// the dispatched result and explained it; the Library's Quick Capture
// button and the tray popover's tiles dispatch straight over IPC from
// the renderer and `void` the promise. So on Ubuntu the headline button
// of the app did nothing whatsoever — a log line and no UI — which is a
// worse failure than the misaligned selector the refusal replaced. One
// notice, raised where the refusal is decided, is the only shape a new
// button cannot silently opt out of.
//
// It is also not a dead end. The message names Full Screen as the way to
// capture here, so the dialog may as well run it: on Wayland the editor's
// crop tool IS the region selection, and making the user dismiss an alert
// and then go find a different button is a worse version of the same
// answer.

import { dialog } from "electron";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { WAYLAND_SELECTOR_MESSAGE } from "./linux-session";

/**
 * Let the alert leave the screen before the grab. On Wayland the portal
 * always interposes a permission prompt and a source picker, so in
 * practice seconds pass — but a portal configured to remember the choice
 * would not, and a dialog baked into the user's screenshot is exactly the
 * class of bug `hidePwrSnapChromeAndSettle` exists to prevent. Same 50ms
 * compositor flush it uses.
 */
const DIALOG_TEARDOWN_SETTLE_MS = 50;

let noticeOpen = false;

/**
 * Explain a refused interactive capture, and offer the capture that does
 * work here. Fire-and-forget: the caller returns its `Result` immediately
 * rather than holding the dispatch open behind a modal.
 */
export function showWaylandRefusalNotice(): void {
  // A held-down or re-pressed hotkey must not stack alerts behind each
  // other — the user would have to dismiss one per press.
  if (noticeOpen) return;
  noticeOpen = true;
  const log = getMainLogger("pwrsnap:capture-trigger");
  void dialog
    .showMessageBox({
      type: "info",
      message: "Drag-to-select capture needs an X11 session",
      detail: WAYLAND_SELECTOR_MESSAGE,
      buttons: ["Capture Full Screen", "Cancel"],
      defaultId: 0,
      cancelId: 1
    })
    .then(async ({ response }) => {
      if (response !== 0) return;
      await new Promise((resolve) => setTimeout(resolve, DIALOG_TEARDOWN_SETTLE_MS));
      const result = await bus.dispatch("capture:fullScreen", {}, { principal: "ipc" });
      if (!result.ok && result.error.code !== "cancelled") {
        log.warn("full-screen capture from the Wayland refusal notice failed", {
          code: result.error.code,
          message: result.error.message
        });
      }
    })
    .catch((cause: unknown) => {
      log.warn("refusal notice failed to show", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    })
    .finally(() => {
      noticeOpen = false;
    });
}
