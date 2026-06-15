// Permission readiness service for the Fast Video Capture feature
// (issue #64). Single source of truth for "can PwrSnap record screen,
// microphone, and system audio right now" — read by the System
// Permissions page on mount, by the recording preflight before
// countdown, and by the startup routing decision.
//
// Three distinct capabilities, three distinct OS-level surfaces:
//
//   1. Screen Recording — Electron's `systemPreferences.getMediaAccessStatus`
//      reports the macOS TCC value. No prompt API exists; the user must
//      grant via System Settings → Privacy & Security and (in some
//      macOS versions) restart the app.
//
//   2. Microphone — `systemPreferences.askForMediaAccess('microphone')`
//      DOES prompt. We use it from the System Permissions page's
//      "Request" action. The renderer can also kick off a recording
//      with mic and the OS prompt fires on first capture.
//
//   3. System Audio — ScreenCaptureKit-backed system audio reuses the
//      Screen Recording TCC grant on macOS 13+. We treat its readiness
//      as `screenRecording === "granted"` AND a minimum macOS version
//      check. Older macOS reports `unavailable` so the System
//      Permissions row can disable the toggle with a clear reason.
//
// The fingerprint is a stable SHA-1 of `(screen, mic, systemAudio,
// backend, appVersion)`. Settings persists the last fingerprint that
// triggered routing to System Permissions; startup routes only when
// the current fingerprint differs AND any permission needs attention.

import { createHash } from "node:crypto";
import { desktopCapturer, shell, systemPreferences } from "electron";
import type {
  RecordingPermission,
  RecordingPermissionStatus,
  RecordingReadiness
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:recording-permissions");

/** Recorder backend identity feeds the fingerprint so a future
 *  backend swap (e.g. ScreenCaptureKit → CoreAudio Tap) re-routes
 *  the user once to confirm the new permission surface. */
const RECORDER_BACKEND = "screencapturekit" as const;

/** Minimum macOS version that exposes ScreenCaptureKit's
 *  `SCStreamConfiguration.capturesAudio`. Below this we report
 *  system-audio as `unavailable` and the System Permissions row
 *  surfaces the version requirement directly. */
const MIN_SYSTEM_AUDIO_MAJOR = 13;

/** Coerce Electron's media-access status enum into our `RecordingPermissionStatus`.
 *  Electron returns `"granted" | "denied" | "restricted" | "not-determined" |
 *  "unknown"` — same union order as ours plus the `unavailable` arm that
 *  Electron never produces (we set it ourselves for system-audio on
 *  unsupported macOS). */
function fromElectronStatus(value: string): RecordingPermissionStatus {
  switch (value) {
    case "granted":
    case "denied":
    case "restricted":
    case "not-determined":
      return value;
    default:
      return "unknown";
  }
}

/** Read screen-recording readiness without prompting. Returns
 *  `granted` on non-darwin so dev / Linux CI environments don't
 *  surface false-negative banners for code paths that gate on
 *  this.
 *
 *  NOTE: on macOS this is backed by the boolean
 *  `CGPreflightScreenCaptureAccess()`, so it only ever returns
 *  `granted` or `denied` — never `not-determined`. A fresh install
 *  that has never attempted a capture reads `denied`, indistinguishable
 *  from an explicit denial. The capture gate disambiguates the two via
 *  the persisted `recording.screenCapturePrompted` flag. */
export function readScreenStatus(): RecordingPermissionStatus {
  if (process.platform !== "darwin") return "granted";
  return fromElectronStatus(systemPreferences.getMediaAccessStatus("screen"));
}

function readMicrophoneStatus(): RecordingPermissionStatus {
  if (process.platform !== "darwin") return "granted";
  return fromElectronStatus(systemPreferences.getMediaAccessStatus("microphone"));
}

/** macOS version → system-audio availability. ScreenCaptureKit's
 *  audio-capture API needs macOS 13+; older Mac users get the
 *  microphone path only and `systemAudio: "unavailable"` so the
 *  Settings UI can hide the toggle. */
function readSystemAudioStatus(): RecordingPermissionStatus {
  if (process.platform !== "darwin") return "granted";
  const release = process.getSystemVersion?.() ?? "";
  const majorStr = release.split(".")[0];
  const major = Number.parseInt(majorStr ?? "", 10);
  if (Number.isFinite(major) && major < MIN_SYSTEM_AUDIO_MAJOR) {
    return "unavailable";
  }
  // ScreenCaptureKit reuses the Screen Recording grant for its
  // system-audio path — the user does not see a separate TCC prompt
  // for system audio. We mirror the screen status so the UI shows
  // a single "fix this once" affordance instead of two confusingly
  // independent rows that always toggle together.
  return readScreenStatus();
}

/** Stable hash for the routing-memory fingerprint. SHA-1 → first 16
 *  hex chars is more than enough collision-space for one user × four
 *  inputs; we are not defending against an adversary.
 *
 *  Deliberately does NOT include the app version. An earlier version
 *  did, which re-routed the user to System Permissions after every
 *  upgrade even when nothing about their grants had changed — a
 *  needless nag. If a future build introduces a new permission
 *  requirement, bump RECORDER_BACKEND (which IS in the material)
 *  so the fingerprint shifts and routing fires once for the new
 *  capability surface. */
function fingerprintOf(
  screen: RecordingPermissionStatus,
  mic: RecordingPermissionStatus,
  systemAudio: RecordingPermissionStatus
): string {
  const material = `${screen}|${mic}|${systemAudio}|${RECORDER_BACKEND}`;
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

/** Single read of every permission. No prompts; no IPC; cheap. The
 *  System Permissions page calls this on mount and re-reads after
 *  any `permissions:request` to refresh the displayed status. */
export function readRecordingReadiness(): RecordingReadiness {
  const screen = readScreenStatus();
  const mic = readMicrophoneStatus();
  const systemAudio = readSystemAudioStatus();
  return {
    screenRecording: screen,
    microphone: mic,
    systemAudio,
    fingerprint: fingerprintOf(screen, mic, systemAudio)
  };
}

/** Predicate the startup-routing decision uses. True when any
 *  capability is in a non-`granted`, non-`unavailable` state (i.e.
 *  the user can do something about it). `unavailable` is excluded
 *  because routing there is just noise — no recovery action exists. */
export function needsAttention(readiness: RecordingReadiness): boolean {
  const wants = (s: RecordingPermissionStatus): boolean =>
    s !== "granted" && s !== "unavailable";
  return (
    wants(readiness.screenRecording) ||
    wants(readiness.microphone) ||
    wants(readiness.systemAudio)
  );
}

/**
 * Force the macOS Screen Recording TCC prompt the first time
 * PwrSnap is unknown to TCC. `desktopCapturer.getSources` is the
 * standard Electron incantation: it touches the screen-capture API
 * on the user's behalf, which causes the OS to show its standard
 * consent dialog and to add our bundle ID to System Settings →
 * Privacy & Security → Screen & System Audio Recording. After the
 * user has answered once, TCC remembers the decision and this call
 * resolves immediately without re-prompting; the read-back of
 * `getMediaAccessStatus` then reflects the new state.
 *
 * We discard the returned sources — the call is purely a prompt
 * trigger. `thumbnailSize` is a 1×1 placeholder so we don't pay for
 * a real thumbnail render on a path we don't consume.
 */
export async function triggerScreenCapturePrompt(): Promise<void> {
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
      fetchWindowIcons: false
    });
  } catch (cause) {
    log.warn("permissions:request: desktopCapturer.getSources threw", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

/**
 * Trigger an OS-level prompt where one is possible:
 *
 *   • Microphone — `systemPreferences.askForMediaAccess`
 *     shows the standard TCC dialog directly.
 *   • Screen Recording / System Audio — no `askForMediaAccess`
 *     equivalent exists, but issuing a real
 *     `desktopCapturer.getSources` call drives the same first-grant
 *     dialog and registers PwrSnap in the Screen Recording pane.
 *     Used only when current status is `not-determined`; once a
 *     decision has been recorded we open System Settings instead
 *     (macOS does not re-prompt) and the caller surfaces "restart
 *     PwrSnap after granting" guidance.
 */
export async function requestPermission(
  permission: RecordingPermission
): Promise<{ status: RecordingPermissionStatus; openedSettings: boolean }> {
  if (process.platform !== "darwin") {
    return { status: "granted", openedSettings: false };
  }

  switch (permission) {
    case "microphone": {
      // askForMediaAccess returns true if granted (now or previously).
      // On first call from an unprompted state, the OS shows the
      // standard "PwrSnap would like to access your microphone" alert.
      const granted = await systemPreferences.askForMediaAccess("microphone");
      const status: RecordingPermissionStatus = granted ? "granted" : readMicrophoneStatus();
      return { status, openedSettings: false };
    }
    case "screen":
    case "systemAudio": {
      // No `askForMediaAccess` equivalent exists for screen capture.
      // Issuing a real screen-source request via
      // `desktopCapturer.getSources` drives the macOS first-grant dialog
      // AND registers PwrSnap's bundle ID in System Settings → Privacy &
      // Security → Screen & System Audio Recording. That registration is
      // the whole point: until it happens the pane doesn't list us, so
      // there is nothing for an "Open System Settings" button to point
      // at — routing there on a fresh install is the dead-end this fix
      // removes.
      //
      // The caller (System Permissions page) only invokes this verb when
      // PwrSnap has NOT yet asked (`recording.screenCapturePrompted ===
      // false`). Once macOS has recorded a decision it will not prompt
      // again, so the page switches to the `permissions:openSystemSettings`
      // path. The `permissions:request` HANDLER persists the
      // `screenCapturePrompted` flag after this returns. A few macOS
      // configurations grant in-session straight off the dialog; we read
      // the status back so the caller sees the live result.
      await triggerScreenCapturePrompt();
      return { status: readScreenStatus(), openedSettings: false };
    }
  }
}

/**
 * Open System Settings to the appropriate Privacy & Security pane.
 * The `x-apple.systempreferences:` URL scheme has been stable since
 * Ventura and continues to work on macOS 14 / 15 / 26.
 */
export async function openSystemSettingsFor(
  permission: RecordingPermission
): Promise<void> {
  if (process.platform !== "darwin") return;
  const anchor =
    permission === "microphone"
      ? "Privacy_Microphone"
      : "Privacy_ScreenCapture";
  await shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${anchor}`
  );
}
