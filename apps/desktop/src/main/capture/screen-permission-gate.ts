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
//   • not granted                  → ALWAYS attempt the real screen-
//     capture API (`getSources`) first. It shows the OS consent dialog +
//     registers PwrSnap when macOS has no decision on file (fresh install
//     OR after a `tccutil reset` / new unsigned dev build, which our
//     persisted flag CANNOT detect), and picks up a grant that landed
//     without a relaunch. Then re-read status:
//       – granted now            → proceed ("continue if possible").
//       – first time we've asked → stop quietly; the OS dialog is the UI.
//       – asked before, still no → route to Settings (grant + relaunch).
//
// The cardinal rule (learned the hard way): NEVER let the persisted
// `screenCapturePrompted` flag pre-decide "denied" and skip the real
// attempt. The flag survives a `tccutil reset` that wipes macOS's
// decision + the Privacy-pane listing, so a flag-gated short-circuit
// would open Settings for an app macOS no longer lists and never
// re-register it. The getSources probe is harmless when macOS already
// has a decision (black sources, no prompt), so we run it every time.
//
// "Continue if possible" / relaunch: `getMediaAccessStatus` flips to
// granted in-session on some macOS versions the moment the user toggles
// the checkbox; on others it stays stale until relaunch, so the route-to-
// Settings copy tells them to relaunch (passive guidance — we never
// force-relaunch the running process).
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
export async function readScreenCapturePrompted(): Promise<boolean> {
  try {
    const res = await bus.dispatch("settings:read", {}, { principal: "ipc" });
    return res.ok ? res.value.recording.screenCapturePrompted : false;
  } catch (cause) {
    log.warn("readScreenCapturePrompted: settings read failed", {
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
export async function markScreenCapturePrompted(): Promise<void> {
  try {
    await bus.dispatch(
      "settings:write",
      { recording: { screenCapturePrompted: true } },
      { principal: "ipc" }
    );
  } catch (cause) {
    log.warn("markScreenCapturePrompted: settings write failed", {
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
 *
 * `opts.routeToSettings` (default true): on the "asked before, still not
 * granted" branch, whether to open Settings → System Permissions. The
 * headless `capture:region` path passes `false` — an agent/programmatic
 * caller shouldn't have a window popped at it; it just gets the error.
 */
export async function guardScreenCapture(
  opts: { routeToSettings?: boolean } = {}
): Promise<Result<never, PwrSnapError> | null> {
  const routeToSettings = opts.routeToSettings ?? true;
  // Non-darwin builds have no screen-capture TCC gate (Linux/CI; Windows
  // has no preflight permission for desktopCapturer). Let everything
  // through — `readScreenStatus()` already returns `granted` off-darwin,
  // but short-circuit explicitly so the intent is obvious.
  if (process.platform !== "darwin") return null;

  if (readScreenStatus() === "granted") return null;

  // Not granted by preflight. ALWAYS attempt the real screen-capture API
  // before giving up — never let our persisted flag pre-decide "denied"
  // and skip the attempt. `desktopCapturer.getSources` is the only thing
  // that:
  //   • shows the OS consent dialog AND registers PwrSnap in the Privacy
  //     pane when macOS has no decision on file. That's true on a fresh
  //     install — but ALSO after `tccutil reset` (or a new unsigned dev
  //     build that gets a different TCC identity), which our persisted
  //     `screenCapturePrompted` flag CANNOT detect. The old "asked before
  //     → just open Settings, never re-attempt" branch dead-ended here:
  //     it opened Settings for an app macOS no longer listed, and never
  //     re-registered it because it never tried to capture again.
  //   • lets a grant that just landed (without a relaunch) start working.
  // Harmless no-op when macOS already has a decision recorded — it just
  // returns black sources without a prompt.
  const firstAsk = !(await readScreenCapturePrompted());
  log.info("guardScreenCapture: not granted — attempting real probe", { firstAsk });
  await triggerScreenCapturePrompt();
  await markScreenCapturePrompted();

  // Re-read after the real attempt — some macOS configs flip to granted
  // in-session right off the prompt. ("Continue if possible.")
  if (readScreenStatus() === "granted") return null;

  if (firstAsk) {
    // The probe just showed the OS consent dialog / registered us for the
    // first time. The dialog is the UI — don't stack our own Settings
    // window over it. Stop quietly; the next attempt will route to
    // Settings if it's still not granted.
    return err(
      screenPermissionError(
        "screen_permission_pending",
        "PwrSnap just asked macOS for Screen Recording access. Approve it in the dialog (it has an “Open System Settings” button), then capture again."
      )
    );
  }

  // We've asked before AND a fresh real attempt still didn't grant —
  // either a standing denial, or a grant that needs a relaunch to take
  // effect. Route to the Privacy pane (unless the caller is headless).
  log.info("guardScreenCapture: re-probe still not granted — routing to Settings", {
    routeToSettings
  });
  if (routeToSettings) {
    void bus.dispatch(
      "settings:open",
      { page: "system-permissions" },
      { principal: "ipc" }
    );
  }
  return err(
    screenPermissionError(
      "screen_not_granted",
      "Screen Recording isn't active for PwrSnap yet. If you just enabled it, relaunch PwrSnap so the change takes effect; otherwise turn it on in System Settings → Privacy & Security → Screen & System Audio Recording."
    )
  );
}
