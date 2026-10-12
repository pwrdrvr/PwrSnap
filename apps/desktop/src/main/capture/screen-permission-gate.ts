// Pre-capture Screen Recording gate.
//
// macOS quirk: `getMediaAccessStatus('screen')` is backed by the boolean
// `CGPreflightScreenCaptureAccess()` and returns `denied` — never
// `not-determined` — so the OS cannot tell "never asked" from "denied".
// That no longer matters here, because the gate never asks macOS:
//
//   • granted     → proceed.
//   • not granted → open System Settings with the permission guide beside
//     it (capture/permission-guide.ts) and stop. The guide's drag adds THIS
//     copy to the list whether or not macOS has a decision on file, and its
//     Reset clears a row signed to another copy.
//
// The cardinal rule: NEVER call a capture API (`desktopCapturer.getSources`,
// SCStream, `screencapture`) while preflight says not granted. Doing so is
// what raises macOS's own "would like to record this computer's screen"
// alert. That alert belongs to the system, not to PwrSnap: it outlives a
// relaunch, a second attempt stacks a second copy, and with the guide open
// beside it the user is asked twice in two different ways. The gate used to
// probe with `getSources` on every blocked capture (to register a copy macOS
// had never seen); the guide's drag does that job without the alert.
//
// `recording.screenCapturePrompted` is still written on the first blocked
// capture. Startup routing (index.ts) reads it to tell "the user has tried
// and is blocked" from a fresh install.
//
// Call `guardScreenCapture()` at the TOP of every command that captures
// screen pixels, BEFORE any frozen-screen snapshot is taken: the snapshot is
// itself a capture call.

import { err, type PwrSnapError, type Result } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { readScreenStatus } from "../recording/recording-permissions";

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
 * proceed, or a `Result.err` to short-circuit the command, in which case the
 * gate has already shown the permission guide (unless told not to).
 * Handlers use it as:
 *
 *   const blocked = await guardScreenCapture();
 *   if (blocked) return blocked;
 *
 * The `Result<never, …>` arm is structurally assignable to any handler's
 * `Result<Res, PwrSnapError>` because the error arm carries no value.
 *
 * `opts.routeToSettings` (default true): whether to open System Settings
 * with the permission guide beside it. The headless `capture:region` path
 * passes `false`: an agent/programmatic caller shouldn't have a window
 * popped at it; it just gets the error.
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

  // No capture call here, not even a 1×1 probe: see the header.
  log.info("guardScreenCapture: not granted — showing the permission guide", { routeToSettings });
  await markScreenCapturePrompted();
  if (routeToSettings) {
    void bus.dispatch(
      "permissions:showGuide",
      { permission: "screen" },
      { principal: "ipc" }
    );
  }
  return err(
    screenPermissionError(
      "screen_not_granted",
      "Screen Recording isn't active for PwrSnap yet. Drag PwrSnap into System Settings → Privacy & Security → Screen & System Audio Recording, turn it on, then relaunch PwrSnap."
    )
  );
}
