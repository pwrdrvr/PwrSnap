// macOS TCC (Transparency, Consent & Control) helpers for the screen-
// capture flow. Phase 1 only needs `screen` permission; mic + camera
// land in Phase 5.
//
// Status checks use Electron's systemPreferences.getMediaAccessStatus
// which is implemented atop CGPreflightScreenCaptureAccess and does
// NOT prompt. The "request" path explicitly attempts a screencapture
// CLI invocation to drive TCC's first-grant prompt — `getMediaAccessStatus`
// can return 'granted' on a fresh install before the user has actually
// been prompted, so we always pair a status check with a real capture
// attempt before declaring success.
//
// Mid-session revocation: Preflight does not flip back reliably after
// the user revokes screen-recording in System Settings. The reliable
// signal is a screencapture CLI exit error — `classifyCaptureError`
// distinguishes revocation from cancel from genuine errors.

import { shell, systemPreferences } from "electron";

export type Permission = "screen" | "microphone" | "camera";
export type PermissionStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

export function checkPermission(perm: Permission): PermissionStatus {
  // systemPreferences.getMediaAccessStatus is Mac/Windows only; on
  // unsupported platforms, treat as granted (we won't ship to those
  // until Phase 8).
  if (process.platform !== "darwin") return "granted";
  const status = systemPreferences.getMediaAccessStatus(perm);
  switch (status) {
    case "granted":
    case "denied":
    case "restricted":
    case "not-determined":
      return status;
    default:
      return "unknown";
  }
}

/**
 * Open System Settings → Privacy & Security → <pane>. The deep-link URL
 * scheme has been stable since Sonoma and continues to work on macOS
 * 14 / 15 / 26.
 */
export function openSystemSettingsForPermission(perm: Permission): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const map: Record<Permission, string> = {
    screen: "Privacy_ScreenCapture",
    microphone: "Privacy_Microphone",
    camera: "Privacy_Camera"
  };
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${map[perm]}`);
}

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
