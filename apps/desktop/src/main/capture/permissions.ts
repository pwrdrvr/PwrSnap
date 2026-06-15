// macOS TCC (Transparency, Consent & Control) helper for the screen-
// capture flow: classifying the outcome of a `screencapture` CLI run.
//
// Permission STATUS reads and System Settings routing live elsewhere:
// `readScreenStatus` / `openSystemSettingsFor` / `triggerScreenCapturePrompt`
// in ../recording/recording-permissions.ts, gated by
// ./screen-permission-gate.ts. A key macOS quirk those rely on:
// `systemPreferences.getMediaAccessStatus('screen')` is backed by the
// boolean `CGPreflightScreenCaptureAccess()`, so for the `screen` media
// type it returns only 'granted' or 'denied' — never 'not-determined'.
// A fresh install that has never attempted a capture reads 'denied',
// indistinguishable from an explicit denial (see
// docs/solutions/2026-06-14-first-run-screen-recording-permission.md).
//
// Mid-session revocation: preflight does not flip back reliably after
// the user revokes screen-recording in System Settings. The reliable
// signal is a screencapture CLI exit error — `classifyCaptureError`
// distinguishes revocation from cancel from genuine errors.

/**
 * Classify the outcome of a `screencapture` CLI invocation. The CLI
 * exits 0 on success; non-zero with a recognisable stderr blurb on
 * TCC denial; non-zero with empty stderr when the user pressed Esc on
 * an interactive flag (we don't use interactive in Phase 1 but keep
 * the classification for symmetry).
 */
export function classifyCaptureError(
  exitCode: number,
  stderr: string
): "revoked" | "cancelled" | "error" {
  if (exitCode === 0) return "error"; // shouldn't be called for success
  const lower = stderr.toLowerCase();
  if (
    lower.includes("not authorized") ||
    lower.includes("cannot be completed") ||
    lower.includes("permission denied")
  ) {
    return "revoked";
  }
  if (stderr.trim().length === 0) return "cancelled";
  return "error";
}
