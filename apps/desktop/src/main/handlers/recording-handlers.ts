// Command-bus handlers for the `permissions:*`, `recording:*`, and
// `video:*` namespaces. Splits cleanly off settings-handlers and
// capture-handlers because:
//
//   • Permissions readiness is its own surface (System Permissions
//     page + recording-time dialog both call it).
//   • Recording lifecycle has its own state machine (recording-state.ts)
//     and would crowd capture-handlers if folded in.
//   • Video export is a derived-artifact path keyed by the same
//     command bus the renderer uses for image clipboard/drag.

import { ok, err } from "@pwrsnap/shared";
import type {
  PwrSnapError,
  RecordingPermission,
  Result,
  VideoExportRequest
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getCaptureById } from "../persistence/captures-repo";
import {
  getVideoMetadata,
  normalizeRange,
  setDefaultRange
} from "../persistence/video-repo";
import {
  openSystemSettingsFor,
  readRecordingReadiness,
  requestPermission
} from "../recording/recording-permissions";
import {
  getRecordingService,
  type RecordingService
} from "../recording/recording-service";
import { getRecordingState } from "../recording/recording-state";
import { exportVideoRange } from "../recording/recording-exporter";

const log = getMainLogger("pwrsnap:recording-handlers");

const KNOWN_PERMISSIONS: readonly RecordingPermission[] = [
  "screen",
  "microphone",
  "systemAudio"
];

function isKnownPermission(value: unknown): value is RecordingPermission {
  return typeof value === "string" && (KNOWN_PERMISSIONS as readonly string[]).includes(value);
}

function permissionError(code: string, message: string): PwrSnapError {
  return { kind: "permission", code, message };
}

function validationError(code: string, message: string): PwrSnapError {
  return { kind: "validation", code, message };
}

function recordingError(code: string, message: string, cause?: unknown): PwrSnapError {
  return { kind: "capture", code, message, cause };
}

/**
 * Validate a video:export request without crossing the bus. We can't
 * trust the renderer (or a future HTTP/MCP transport) to send well-
 * formed audio or range payloads, so every arm is checked.
 */
function validateExportRequest(req: VideoExportRequest): Result<VideoExportRequest, PwrSnapError> {
  if (typeof req.captureId !== "string" || req.captureId.length === 0) {
    return err(validationError("invalid_capture_id", "video:export: captureId must be a non-empty string"));
  }
  if (req.format !== "gif" && req.format !== "mp4") {
    return err(validationError("invalid_format", "video:export: format must be \"gif\" or \"mp4\""));
  }
  if (req.preset !== "low" && req.preset !== "med" && req.preset !== "high") {
    return err(
      validationError(
        "invalid_preset",
        "video:export: preset must be \"low\", \"med\", or \"high\""
      )
    );
  }
  if (req.range !== undefined) {
    const r = req.range;
    if (typeof r.start !== "number" || typeof r.end !== "number") {
      return err(validationError("invalid_range", "video:export: range start/end must be numbers"));
    }
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) {
      return err(validationError("invalid_range", "video:export: range start/end must be finite"));
    }
    if (r.end < r.start) {
      return err(validationError("invalid_range", "video:export: range end must be >= start"));
    }
  }
  if (req.audio !== undefined) {
    if (
      typeof req.audio.includeSystemAudio !== "boolean" ||
      typeof req.audio.includeMicrophone !== "boolean"
    ) {
      return err(validationError("invalid_audio", "video:export: audio toggles must be booleans"));
    }
  }
  return ok(req);
}

let serviceOverrideForTests: RecordingService | null = null;

export function __setRecordingServiceForTests(service: RecordingService | null): void {
  serviceOverrideForTests = service;
}

function getService(): RecordingService {
  return serviceOverrideForTests ?? getRecordingService();
}

export function registerRecordingHandlers(): void {
  // ---- permissions ----

  bus.register("permissions:readiness", async () => {
    return ok(readRecordingReadiness());
  });

  bus.register("permissions:request", async (req) => {
    if (!isKnownPermission(req.permission)) {
      return err(
        validationError(
          "unknown_permission",
          `permissions:request: unknown permission (got ${JSON.stringify(req.permission)})`
        )
      );
    }
    const result = await requestPermission(req.permission);
    return ok(result);
  });

  bus.register("permissions:openSystemSettings", async (req) => {
    if (!isKnownPermission(req.permission)) {
      return err(
        validationError(
          "unknown_permission",
          `permissions:openSystemSettings: unknown permission (got ${JSON.stringify(req.permission)})`
        )
      );
    }
    try {
      await openSystemSettingsFor(req.permission);
      return ok(undefined);
    } catch (cause) {
      log.warn("permissions:openSystemSettings failed", {
        permission: req.permission,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err(
        permissionError(
          "open_settings_failed",
          cause instanceof Error ? cause.message : String(cause)
        )
      );
    }
  });

  // ---- recording lifecycle ----

  bus.register("recording:start", async (req) => {
    // Preflight permissions before the countdown so the user is
    // never staring at "3, 2, 1, …" only to hit a permission wall.
    // We reject only on missing screen (required); missing audio is
    // a degraded continuation that the selector dialog handled
    // before calling us.
    const readiness = readRecordingReadiness();
    if (readiness.screenRecording !== "granted") {
      return err(
        permissionError(
          "screen_not_granted",
          "Screen Recording permission is required. Grant it in System Settings → Privacy & Security and restart PwrSnap."
        )
      );
    }
    if (
      req.capabilities.microphone &&
      readiness.microphone !== "granted"
    ) {
      return err(
        permissionError(
          "microphone_not_granted",
          "Microphone permission is required for the selected recording options."
        )
      );
    }
    if (
      req.capabilities.systemAudio &&
      readiness.systemAudio !== "granted"
    ) {
      return err(
        permissionError(
          "system_audio_not_granted",
          "System Audio capture requires Screen Recording permission on macOS 13 or newer."
        )
      );
    }
    try {
      const session = await getService().start({
        subject: req.subject,
        capabilities: req.capabilities,
        countdownSeconds: req.countdownSeconds ?? 3
      });
      return ok({ sessionId: session.sessionId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "already_recording") {
        return err(recordingError("already_recording", "A recording is already in progress."));
      }
      if (message === "cancelled") {
        // User invoked recording:cancel mid-countdown. State is
        // already reset to idle by cancel(); surface this as a
        // validation-style result rather than an unexpected error
        // so callers (the hotkey path) don't log it as a failure.
        return err({
          kind: "validation",
          code: "cancelled",
          message: "Recording cancelled before capture started."
        });
      }
      log.error("recording:start failed", { message });
      return err(recordingError("recording_start_failed", message, cause));
    }
  });

  bus.register("recording:stop", async () => {
    try {
      const { captureId } = await getService().stop();
      return ok({ captureId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("recording:stop failed", { message });
      return err(recordingError("recording_stop_failed", message, cause));
    }
  });

  bus.register("recording:cancel", async () => {
    try {
      await getService().cancel();
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("recording:cancel failed", { message });
      return err(recordingError("recording_cancel_failed", message, cause));
    }
  });

  bus.register("recording:restart", async () => {
    try {
      const { sessionId } = await getService().restart();
      return ok({ sessionId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "not_recording") {
        return err(
          validationError("not_recording", "No active recording to restart.")
        );
      }
      log.error("recording:restart failed", { message });
      return err(recordingError("recording_restart_failed", message, cause));
    }
  });

  bus.register("recording:state", async () => {
    return ok(getRecordingState());
  });

  // ---- video metadata + export ----

  bus.register("video:setDefaultRange", async (req) => {
    if (typeof req.captureId !== "string" || req.captureId.length === 0) {
      return err(validationError("invalid_capture_id", "video:setDefaultRange: captureId required"));
    }
    if (
      typeof req.range?.start !== "number" ||
      typeof req.range?.end !== "number" ||
      !Number.isFinite(req.range.start) ||
      !Number.isFinite(req.range.end)
    ) {
      return err(validationError("invalid_range", "video:setDefaultRange: range start/end must be finite numbers"));
    }
    const meta = getVideoMetadata(req.captureId);
    if (meta === null) {
      return err(validationError("not_a_video", `video:setDefaultRange: ${req.captureId} is not a video capture`));
    }
    setDefaultRange(req.captureId, normalizeRange(req.range, meta.durationSec));
    return ok(undefined);
  });

  bus.register("video:export", async (req) => {
    const validated = validateExportRequest(req);
    if (!validated.ok) return validated;
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err(validationError("not_found", `video:export: capture not found: ${req.captureId}`));
    }
    if (record.kind !== "video" || record.video === null || record.video === undefined) {
      return err(validationError("not_a_video", `video:export: ${req.captureId} is not a video capture`));
    }
    const range = req.range ?? record.video.defaultRange;
    const audio =
      req.audio ??
      ({ includeSystemAudio: false, includeMicrophone: false } as const);
    // Source metadata is the source of truth for whether a track
    // even exists in the file. Toggling a missing track on is a
    // validator-level rejection, not a silent normalisation, so the
    // renderer can tell the user precisely what went wrong.
    if (req.format === "mp4") {
      if (audio.includeSystemAudio && !record.video.hasSystemAudio) {
        return err(
          validationError(
            "audio_track_missing",
            "video:export: cannot include system audio — source recording has no system-audio track."
          )
        );
      }
      if (audio.includeMicrophone && !record.video.hasMicrophoneAudio) {
        return err(
          validationError(
            "audio_track_missing",
            "video:export: cannot include microphone — source recording has no microphone track."
          )
        );
      }
    }
    try {
      const result = await exportVideoRange({
        record,
        video: record.video,
        format: req.format,
        preset: req.preset,
        range: normalizeRange(range, record.video.durationSec),
        audio: req.format === "gif"
          ? { includeSystemAudio: false, includeMicrophone: false }
          : audio
      });
      return ok(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("video:export failed", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        message
      });
      return err({ kind: "render", code: "video_export_failed", message, cause });
    }
  });
}
