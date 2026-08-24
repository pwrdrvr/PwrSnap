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
// Windows is different: its current recorder is screen-only and the capture
// pipeline has no reliable permission preflight. Operational readiness stays
// permissive so a real capture can run, while `readRecordingPermissionEvidence`
// gives Settings the truthful model (uninspectable screen, global microphone,
// unsupported system audio). Never present the readiness fallback as a grant.
//
// The fingerprint is a stable SHA-1 of `(screen, mic, systemAudio,
// backend)`. Settings persists the last fingerprint that
// triggered routing to System Permissions; startup routes only when
// the current fingerprint differs AND any permission needs attention.

import { createHash } from "node:crypto";
import { desktopCapturer, shell, systemPreferences } from "electron";
import type {
  RecordingPermission,
  RecordingPermissionEvidenceReport,
  RecordingPermissionStatus,
  RecordingReadiness
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:recording-permissions");

/** Recorder backend identity feeds the fingerprint so a future
 *  backend swap (e.g. ScreenCaptureKit → CoreAudio Tap) re-routes
 *  the user once to confirm the new permission surface. */
function recorderBackend(): string {
  if (process.platform === "darwin") return "screencapturekit";
  if (process.platform === "win32") return "ffmpeg-gdigrab-video-only";
  return "desktop-capture";
}

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
  // The current Windows FFmpeg/gdigrab implementation explicitly emits
  // video-only output (`-an`). Reporting `granted` here made a requested
  // mic look usable even though RecordingService silently discarded it.
  if (process.platform === "win32") return "unavailable";
  if (process.platform !== "darwin") return "granted";
  return fromElectronStatus(systemPreferences.getMediaAccessStatus("microphone"));
}

/** macOS version → system-audio availability. ScreenCaptureKit's
 *  audio-capture API needs macOS 13+; older Mac users get the
 *  microphone path only and `systemAudio: "unavailable"` so the
 *  Settings UI can hide the toggle. */
function readSystemAudioStatus(): RecordingPermissionStatus {
  if (process.platform === "win32") return "unavailable";
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
  const material = `${screen}|${mic}|${systemAudio}|${recorderBackend()}`;
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

/**
 * Presentation-safe evidence for Settings. Keep this separate from
 * `readRecordingReadiness`: off macOS, readiness deliberately lets the real
 * capture operation run when no preflight API exists. That fallback is not
 * proof that Windows inspected or granted a permission.
 *
 * Electron exposes one useful Windows signal here: the global microphone
 * control for classic desktop apps. Its Windows screen value is always
 * `granted`, so reporting it as an OS check would be fictitious. The current
 * Windows recorder is screen-only, making system-audio permission unsupported.
 */
export function readRecordingPermissionEvidence(
  readiness: RecordingReadiness
): RecordingPermissionEvidenceReport {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      screen: { kind: "os-status", status: readiness.screenRecording },
      microphone: { kind: "os-status", status: readiness.microphone },
      // ScreenCaptureKit system audio shares the screen grant, so this is
      // derived readiness rather than a separately inspected permission.
      systemAudio: { kind: "derived", status: readiness.systemAudio }
    };
  }

  if (process.platform === "win32") {
    let microphone: RecordingPermissionStatus = "unknown";
    try {
      microphone = fromElectronStatus(
        systemPreferences.getMediaAccessStatus("microphone")
      );
    } catch (cause) {
      log.warn("permissions:readiness: Windows microphone status unavailable", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    return {
      platform: "win32",
      screen: { kind: "not-inspectable" },
      microphone: { kind: "os-status", status: microphone },
      systemAudio: { kind: "unsupported" }
    };
  }

  return {
    platform: "other",
    screen: { kind: "not-inspectable" },
    microphone: { kind: "not-inspectable" },
    systemAudio: { kind: "unsupported" }
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
 *     equivalent exists, but issuing a real `desktopCapturer.getSources`
 *     call drives the same first-grant dialog and registers PwrSnap in
 *     the Screen Recording pane. The caller (System Permissions page)
 *     only invokes this when PwrSnap has never asked; once macOS has
 *     recorded a decision it won't re-prompt, so the page switches to
 *     the separate `permissions:openSystemSettings` verb. Returns the
 *     live status read back after the prompt.
 */
export async function requestPermission(
  permission: RecordingPermission
): Promise<{ status: RecordingPermissionStatus }> {
  if (process.platform !== "darwin") {
    const readiness = readRecordingReadiness();
    return {
      status:
        permission === "screen"
          ? readiness.screenRecording
          : permission === "microphone"
          ? readiness.microphone
          : readiness.systemAudio
    };
  }

  switch (permission) {
    case "microphone": {
      // askForMediaAccess returns true if granted (now or previously).
      // On first call from an unprompted state, the OS shows the
      // standard "PwrSnap would like to access your microphone" alert.
      const granted = await systemPreferences.askForMediaAccess("microphone");
      const status: RecordingPermissionStatus = granted ? "granted" : readMicrophoneStatus();
      return { status };
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
      return { status: readScreenStatus() };
    }
  }
}

/**
 * Open the platform-owned privacy page for a known permission. The renderer
 * supplies only the permission enum; every URI stays hardcoded here so this
 * command cannot become an arbitrary-navigation gadget.
 */
export async function openSystemSettingsFor(
  permission: RecordingPermission
): Promise<void> {
  if (process.platform === "darwin") {
    const anchor =
      permission === "microphone"
        ? "Privacy_Microphone"
        : "Privacy_ScreenCapture";
    await shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${anchor}`
    );
    return;
  }

  if (process.platform === "win32") {
    if (permission === "screen") {
      // Windows does not expose this state through Electron. This is the
      // official Windows 11 programmatic-screen-capture privacy page, so the
      // UI presents it as troubleshooting rather than a per-app grant.
      await shell.openExternal("ms-settings:privacy-graphicscaptureprogrammatic");
    } else if (permission === "microphone") {
      // Controls the global "desktop apps" microphone switch that Electron's
      // getMediaAccessStatus('microphone') reports on Windows 10+.
      await shell.openExternal("ms-settings:privacy-microphone");
    }
  }
}
