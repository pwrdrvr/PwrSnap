// First-run / pre-capture Screen Recording gate.
//
// The macOS quirk this exists for: `getMediaAccessStatus('screen')` is
// backed by the boolean `CGPreflightScreenCaptureAccess()` and returns
// `denied` — never `not-determined` — for a fresh install that has never
// attempted a capture. So the OS alone cannot tell "never asked" apart
// from "explicitly denied". PwrSnap remembers it itself
// (`Settings.recording.screenCapturePrompted`) and gates every capture
// entrypoint:
//
//   • granted                      → proceed.
//   • not granted, never asked yet  → issue a real screen grab. macOS
//     shows ITS OWN consent dialog and registers PwrSnap in the Privacy
//     pane; we record that we asked, then stop. The OS dialog is the UI —
//     we deliberately do NOT pop our own Settings window on top of it.
//   • not granted, asked before     → macOS won't prompt again, so the
//     only recovery is the Privacy pane. Open Settings → System
//     Permissions and stop.
//
// "Continue if possible" (per the product decision on this fix): the
// granted fast-path reads `getMediaAccessStatus`, which on some macOS
// versions flips to `granted` in-session the moment the user toggles the
// checkbox — those users flow straight into the real capture. Where it
// stays stale until relaunch, the next attempt routes to Settings, whose
// copy tells them to relaunch (passive guidance — we never force-relaunch
// the running process).
//
// Call `guardScreenCapture()` at the TOP of every command that captures
// screen pixels, BEFORE any frozen-screen snapshot is taken — otherwise
// the snapshot is black on a denied Mac and the user stares at an empty
// selector overlay.

import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import {
  readScreenStatus,
  triggerScreenCapturePrompt
} from "../recording/recording-permissions";

const log = getMainLogger("pwrsnap:screen-permission-gate");

/**
 * Read the persisted "we've triggered the screen-capture prompt at least
 * once" flag. Defaults to `false` if settings can't be read (e.g. the
 * settings handlers aren't registered in a unit test, or a transient read
 * failure) so a missing read never wedges the first-run prompt path — the
 * worst case is one extra harmless prompt attempt.
 */
export async function readScreenCaptureAttempted(): Promise<boolean> {
  try {
    const res = await bus.dispatch("settings:read", {}, { principal: "ipc" });
    return res.ok ? res.value.recording.screenCapturePrompted : false;
  } catch (cause) {
    log.warn("readScreenCaptureAttempted: settings read failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return false;
  }
}

/**
 * Persist that we've triggered the screen-capture prompt. Best-effort: a
 * failed write only means we might re-prompt once more on the next
 * attempt, never a crash. Writing `true` when it's already `true` is a
 * harmless no-op-value write (it still broadcasts, which keeps any open
 * Settings window in sync).
 */
export async function markScreenCaptureAttempted(): Promise<void> {
  try {
    await bus.dispatch(
      "settings:write",
      { recording: { screenCapturePrompted: true } },
      { principal: "ipc" }
    );
  } catch (cause) {
    log.warn("markScreenCaptureAttempted: settings write failed", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

function screenPermissionError(code: string, message: string): PwrSnapError {
  return { kind: "permission", code, message };
}

/**
 * Gate a screen-capturing command. Returns `null` when the caller may
 * proceed, or a `Result.err` to short-circuit the command — in which case
 * the gate has already done the right side-effect (shown the OS prompt, or
 * routed to System Settings). Handlers use it as:
 *
 *   const blocked = await guardScreenCapture();
 *   if (blocked) return blocked;
 *
 * The `Result<never, …>` arm is structurally assignable to any handler's
 * `Result<Res, PwrSnapError>` because the error arm carries no value.
 */
export async function guardScreenCapture(): Promise<Result<never, PwrSnapError> | null> {
  // Non-darwin builds have no screen-capture TCC gate (Linux/CI; Windows
  // has no preflight permission for desktopCapturer). Let everything
  // through — `readScreenStatus()` already returns `granted` off-darwin,
  // but short-circuit explicitly so the intent is obvious.
  if (process.platform !== "darwin") return null;

  if (readScreenStatus() === "granted") return null;

  const attempted = await readScreenCaptureAttempted();
  if (!attempted) {
    // First-ever attempt: drive the macOS prompt with a real screen-source
    // request, remember we asked, then stop. The OS consent dialog is the
    // UI — opening our own Settings window over it would be noise.
    log.info("guardScreenCapture: first attempt — triggering OS prompt");
    await triggerScreenCapturePrompt();
    await markScreenCaptureAttempted();
    // A few macOS configs grant in-session straight off the prompt — if so,
    // let this very capture proceed ("continue if possible").
    if (readScreenStatus() === "granted") return null;
    return err(
      screenPermissionError(
        "screen_permission_pending",
        "PwrSnap just asked macOS for Screen Recording access. Approve it in the dialog (or in System Settings → Privacy & Security → Screen & System Audio Recording), then capture again."
      )
    );
  }

  // We've asked before and macOS still reports not-granted. It will not
  // prompt a second time, so the only path forward is the Privacy pane.
  // Route the user there. (If they already granted it, macOS may need a
  // relaunch before the running process can see it — the System
  // Permissions page says so.)
  log.info("guardScreenCapture: prior attempt, still not granted — routing to Settings");
  void bus.dispatch(
    "settings:open",
    { page: "system-permissions" },
    { principal: "ipc" }
  );
  return err(
    screenPermissionError(
      "screen_not_granted",
      "Screen Recording is not enabled for PwrSnap. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch PwrSnap."
    )
  );
}
