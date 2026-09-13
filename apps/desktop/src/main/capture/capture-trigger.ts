import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  createCaptureInvocationTrigger,
  finalizeCaptureInvocation,
  type CaptureInvocationTrigger,
  type CaptureInvocationOrigin
} from "@pwrsnap/shared";
import { dialog } from "electron";
import { bus, type CommandDispatchOptions } from "../command-bus";
import { getMainLogger } from "../log";
import { WAYLAND_SELECTOR_ERROR_CODE } from "./linux-session";

const monotonicNow = (): number => performance.timeOrigin + performance.now();

export function createInteractiveCaptureTrigger(
  origin: CaptureInvocationOrigin
): CaptureInvocationTrigger {
  return createCaptureInvocationTrigger({
    id: randomUUID(),
    origin,
    monotonicNow
  });
}

export function dispatchInteractiveCapture(
  triggerOrOrigin: CaptureInvocationTrigger | CaptureInvocationOrigin,
  mode: "auto" | "region" | "window" | "timed",
  options: CommandDispatchOptions = { principal: "ipc" }
) {
  const trigger =
    typeof triggerOrOrigin === "string"
      ? createInteractiveCaptureTrigger(triggerOrOrigin)
      : triggerOrOrigin;
  const invocation = finalizeCaptureInvocation(trigger, monotonicNow);
  const dispatched = bus.dispatch("capture:interactive", { mode, invocation }, options);
  void dispatched.then((result) => {
    if (!result.ok) explainRefusalIfNeeded(result.error.code, result.error.message);
  });
  return dispatched;
}

let waylandNoticeOpen = false;

/**
 * The hotkey and native-tray entry points have nowhere to report into:
 * neither awaits a window, and a failed `capture:interactive` has until
 * now only reached the log. That is the right default — a cancelled pick
 * must not pop anything — but it cannot stand for a refusal the user can
 * act on, because the visible result of pressing the capture hotkey would
 * be nothing at all, indistinguishable from a dead shortcut.
 *
 * Deliberately narrow: ONLY the Wayland refusal. Every other failure code
 * keeps its log-only behavior.
 *
 * This is not the mid-take dialog that AGENTS.md bans from `tray.ts`. That
 * rule exists because a native alert has no `sharingType` and lands inside
 * the recorded rect; this alert can only ever appear on Linux, where
 * `recordingBackendCapabilities()` reports `backend: "unsupported"` and
 * there is no take to intrude on.
 */
function explainRefusalIfNeeded(code: string, message: string): void {
  if (code !== WAYLAND_SELECTOR_ERROR_CODE) return;
  // A held-down or re-pressed hotkey must not stack alerts behind each
  // other — the user would have to dismiss one per press.
  if (waylandNoticeOpen) return;
  waylandNoticeOpen = true;
  void dialog
    .showMessageBox({
      type: "info",
      message: "Drag-to-select capture needs an X11 session",
      detail: message,
      buttons: ["OK"],
      defaultId: 0
    })
    .catch((cause: unknown) => {
      getMainLogger("pwrsnap:capture-trigger").warn("refusal notice failed to show", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    })
    .finally(() => {
      waylandNoticeOpen = false;
    });
}
