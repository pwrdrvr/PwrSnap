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

import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, recordingFailureSummary } from "@pwrsnap/shared";
import type {
  PwrSnapError,
  RecordingCapabilities,
  RecordingFailureCode,
  RecordingPermission,
  RecordingPermissionAction,
  Result,
  VideoExportRequest,
  VideoPreset,
  VideoPresetMetric
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getCaptureById } from "../persistence/captures-repo";
import {
  getVideoMetadata,
  lookupExport,
  normalizeRange,
  setDefaultRange
} from "../persistence/video-repo";
import {
  openSystemSettingsFor,
  readRecordingPermissionEvidence,
  readRecordingReadiness,
  requestPermission,
  UnsupportedPermissionSettingsError
} from "../recording/recording-permissions";
import {
  guardScreenCapture,
  markScreenCapturePrompted,
  readScreenCapturePrompted
} from "../capture/screen-permission-gate";
import { ensureCapturesDirReady } from "../capture/capture-storage-gate";
import {
  actOnRecordingPermissionPrompt,
  cancelRecordingPermissionPrompt,
  RecordingPermissionPromptError,
  requestRecordingPermissions
} from "../recording/recording-permission-prompt";
import {
  getRecordingService,
  type RecordingService
} from "../recording/recording-service";
import {
  getRecordingState,
  isRecordingActive
} from "../recording/recording-state";
import {
  snapshotRecordingForeground,
  type RecordingForegroundRestorer
} from "../recording/recording-foreground";
import {
  computeOutputDimensions,
  exportVideoRange,
  GIF_PRESETS,
  MP4_PRESETS
} from "../recording/recording-exporter";
import {
  mapVideoResolveError,
  resolveVideoExport
} from "../recording/video-export-resolver";
import { validateVideoExportRequest } from "../recording/video-export-validation";
import { ensureVideoPoster } from "../recording/video-poster";
import { ensureVideoFrames, videoAssetDir } from "../recording/video-frames";
import { extractVideoAudio } from "../sizzle/audio-extract";
import { videoAssetUrl } from "../protocols-parse";
import { broadcastCapturesChanged } from "../events";
import { prepareRenderedFileAlias } from "../render/file-alias";
import { buildPresetExportDisplayName } from "../render/export-filename";
import { getCaptureEnrichment } from "../persistence/enrichment-repo";

const log = getMainLogger("pwrsnap:recording-handlers");

const KNOWN_PERMISSIONS: readonly RecordingPermission[] = [
  "screen",
  "microphone",
  "systemAudio"
];

function isKnownPermission(value: unknown): value is RecordingPermission {
  return typeof value === "string" && (KNOWN_PERMISSIONS as readonly string[]).includes(value);
}

function isRecordingPermissionAction(value: unknown): value is RecordingPermissionAction {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.requestId !== "string") return false;
  if (candidate.action === "cancel" || candidate.action === "recheck") return true;
  return (
    (candidate.action === "openSettings" || candidate.action === "continueWithout") &&
    isKnownPermission(candidate.permission)
  );
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

function safeFailureSummary(fallback: RecordingFailureCode): string {
  const state = getRecordingState();
  return recordingFailureSummary(state.phase === "failed" ? state.code : fallback);
}

function failedSessionId(req: unknown): string | null {
  if (typeof req !== "object" || req === null || !("sessionId" in req)) return null;
  const value = (req as { sessionId?: unknown }).sessionId;
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : null;
}

/** Shared gate for both a fresh start and a session-scoped retry. Retry uses
 * the service-owned capability snapshot, so permission/storage changes while
 * a durable failure card is open are caught before another countdown begins. */
async function guardRecordingAttempt(
  capabilities: RecordingCapabilities,
  options: { routeScreenToSettings?: boolean } = {}
): Promise<Result<never, PwrSnapError> | null> {
  const blocked = await guardScreenCapture({
    routeToSettings: options.routeScreenToSettings ?? true
  });
  if (blocked) return blocked;
  const storageBlocked = await ensureCapturesDirReady();
  if (storageBlocked) return storageBlocked;
  const readiness = readRecordingReadiness();
  if (capabilities.microphone && readiness.microphone !== "granted") {
    return err(
      permissionError(
        "microphone_not_granted",
        "Microphone permission is required for the selected recording options."
      )
    );
  }
  if (capabilities.systemAudio && readiness.systemAudio !== "granted") {
    return err(
      permissionError(
        "system_audio_not_granted",
        "System Audio capture requires Screen Recording permission on macOS 13 or newer."
      )
    );
  }
  return null;
}

/** Filename of the extracted full-clip audio under the video asset dir.
 *  Must stay in the `parseVideoAssetUrl` whitelist. */
const VIDEO_AUDIO_ASSET = "audio.m4a";
/** Matches the timeline's smallest supported trim span. */
const MIN_VIDEO_RANGE_SEC = 0.1;

// The Library and float-over can ask for the same waveform asset at once.
// Coalesce extraction + the final atomic copy so they never race on the
// per-process temporary filename.
const videoAudioInFlight = new Map<string, Promise<void>>();

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function ensureVideoAudioAsset(input: {
  captureId: string;
  videoPath: string;
  durationSec: number;
}): Promise<void> {
  const existing = videoAudioInFlight.get(input.captureId);
  if (existing !== undefined) return existing;

  const work = (async () => {
    const target = join(videoAssetDir(input.captureId), VIDEO_AUDIO_ASSET);
    if (await fileHasBytes(target)) return;

    const extracted = await extractVideoAudio({
      videoPath: input.videoPath,
      startSec: 0,
      durationSec: input.durationSec
    });
    await mkdir(videoAssetDir(input.captureId), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await copyFile(extracted, tmp);
    await rename(tmp, target);
  })();
  videoAudioInFlight.set(input.captureId, work);
  try {
    await work;
  } finally {
    if (videoAudioInFlight.get(input.captureId) === work) {
      videoAudioInFlight.delete(input.captureId);
    }
  }
}

/**
 * Validate a video:export request without crossing the bus. Thin
 * wrapper over the shared `validateVideoExportRequest` — the same
 * gate `clipboard:copyVideoFile` / `clipboard:copyVideoPath` /
 * `video:prepareDrag` run, so no verb can accept a payload another
 * one rejects.
 */
function validateExportRequest(req: VideoExportRequest): Result<VideoExportRequest, PwrSnapError> {
  return validateVideoExportRequest(req, "video:export");
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
    // Superset of the OS-level snapshot: also report whether we've ever
    // triggered the screen-capture prompt, so the System Permissions page
    // can distinguish "Not yet requested" from "Denied" (macOS can't —
    // see screen-permission-gate.ts).
    const readiness = readRecordingReadiness();
    return ok({
      ...readiness,
      permissionEvidence: readRecordingPermissionEvidence(readiness),
      screenCapturePrompted: await readScreenCapturePrompted()
    });
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
    if (
      process.platform === "darwin" &&
      (req.permission === "screen" || req.permission === "systemAudio")
    ) {
      // We just drove the macOS screen-capture prompt (which also
      // registers PwrSnap in the Privacy pane). Remember it so the UI
      // switches to the "Open System Settings" path next time — macOS
      // won't prompt twice. Off Darwin, `requestPermission` is unsupported
      // and returns `unknown`, so there is no prompt attempt to remember.
      await markScreenCapturePrompted();
    }
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
      if (cause instanceof UnsupportedPermissionSettingsError) {
        return err(
          permissionError("permission_settings_unsupported", cause.message)
        );
      }
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

  bus.register("recording:permissionAction", async (req) => {
    if (!isRecordingPermissionAction(req)) {
      return err(
        validationError(
          "invalid_permission_action",
          "recording:permissionAction received an invalid action."
        )
      );
    }
    try {
      await actOnRecordingPermissionPrompt(req);
      return ok(undefined);
    } catch (cause) {
      if (cause instanceof RecordingPermissionPromptError) {
        return err(permissionError(cause.code, cause.message));
      }
      if (cause instanceof UnsupportedPermissionSettingsError) {
        return err(permissionError("permission_settings_unsupported", cause.message));
      }
      return err(
        permissionError(
          "permission_action_failed",
          cause instanceof Error ? cause.message : String(cause)
        )
      );
    }
  });

  bus.register("recording:start", async (req, ctx) => {
    if (getRecordingState().phase === "failed") {
      return err(
        validationError(
          "failure_action_required",
          "Retry or dismiss the current recording failure before starting another recording."
        )
      );
    }
    // Reject before publishing the permission phase. Otherwise a second
    // start can replace the active recording HUD with a prompt and a prompt
    // cancellation can falsely publish idle while the recorder keeps going.
    if (isRecordingActive()) {
      return err(
        recordingError("already_recording", "A recording is already in progress.")
      );
    }

    let foreground: RecordingForegroundRestorer | null = null;
    try {
      let capabilities = { ...req.capabilities };
      if (ctx.principal === "ipc") {
        // The permission panel is intentionally focusable. Preserve the app
        // that was foreground at command entry and put it back before native
        // capture starts so our own UI cannot change the selected pixels.
        foreground = await snapshotRecordingForeground();
        const permissionOutcome = await requestRecordingPermissions(
          capabilities,
          req.subject.displayId
        );
        if (permissionOutcome.status === "busy") {
          return err(
            validationError(
              "permission_prompt_active",
              "A recording permission prompt is already active."
            )
          );
        }
        if (permissionOutcome.status === "cancelled") {
          return err({
            kind: "validation",
            code: "cancelled",
            message: "Recording cancelled before capture started."
          });
        }
        capabilities = permissionOutcome.capabilities;
      }

      // The interactive prompt owns OS-settings routing. Non-renderer
      // callers retain the legacy guard behavior without opening a UI they
      // cannot control.
      const blocked = await guardRecordingAttempt(capabilities, {
        routeScreenToSettings: ctx.principal !== "ipc"
      });
      if (blocked) return blocked;

      await foreground?.restore();
      const session = await getService().start({
        subject: req.subject,
        capabilities,
        captureCursor: req.captureCursor,
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
      return err(
        recordingError(
          "recording_start_failed",
          safeFailureSummary("recorder_start_failed")
        )
      );
    } finally {
      await foreground?.restore();
    }
  });

  bus.register("recording:stop", async () => {
    try {
      const { captureId } = await getService().stop();
      return ok({ captureId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("recording:stop failed", { message });
      return err(
        recordingError("recording_stop_failed", safeFailureSummary("stop_failed"))
      );
    }
  });

  bus.register("recording:cancel", async () => {
    if (getRecordingState().phase === "failed") {
      return err(
        validationError(
          "failure_action_required",
          "Use the failed recording's Dismiss action instead of Cancel."
        )
      );
    }
    if (cancelRecordingPermissionPrompt()) return ok(undefined);
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
    if (getRecordingState().phase === "failed") {
      return err(
        validationError(
          "failure_action_required",
          "Use the failed recording's Retry action instead of Restart."
        )
      );
    }
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

  bus.register("recording:retry", async (req) => {
    const sessionId = failedSessionId(req);
    if (sessionId === null) {
      return err(validationError("invalid_session", "A failed recording session is required."));
    }
    let capabilities: RecordingCapabilities;
    try {
      capabilities = getService().retryCapabilities(sessionId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "stale_failure") {
        return err(validationError("stale_failure", "That recording failure is no longer current."));
      }
      log.error("recording:retry preflight snapshot failed", { message });
      return err(
        recordingError(
          "recording_retry_failed",
          safeFailureSummary("recorder_start_failed")
        )
      );
    }
    const blocked = await guardRecordingAttempt(capabilities);
    if (blocked) return blocked;
    try {
      return ok(await getService().retry(sessionId));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "stale_failure") {
        return err(validationError("stale_failure", "That recording failure is no longer current."));
      }
      log.error("recording:retry failed", { message });
      return err(
        recordingError(
          "recording_retry_failed",
          safeFailureSummary("recorder_start_failed")
        )
      );
    }
  });

  bus.register("recording:dismissFailure", async (req) => {
    const sessionId = failedSessionId(req);
    if (sessionId === null) {
      return err(validationError("invalid_session", "A failed recording session is required."));
    }
    try {
      await getService().dismissFailure(sessionId);
      return ok(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "stale_failure") {
        return err(validationError("stale_failure", "That recording failure is no longer current."));
      }
      log.error("recording:dismissFailure failed", { message });
      return err(
        recordingError(
          "recording_dismiss_failed",
          "PwrSnap couldn't dismiss the recording failure. Open the log file for details."
        )
      );
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
    if (req.range.end <= req.range.start) {
      return err(validationError("invalid_range", "video:setDefaultRange: range end must be greater than start"));
    }
    const range = normalizeRange(req.range, meta.durationSec);
    const minimumRange = Math.min(MIN_VIDEO_RANGE_SEC, Math.max(meta.durationSec, 0));
    if (range.end <= range.start || range.end - range.start < minimumRange) {
      return err(
        validationError(
          "invalid_range",
          `video:setDefaultRange: range must span at least ${String(minimumRange)} seconds`
        )
      );
    }
    setDefaultRange(req.captureId, range);
    // The Library revalidates the record on this broadcast, so the
    // DetailRail's export eyebrow / metrics and any other window
    // (float-over) pick up the new `defaultRange` without polling.
    broadcastCapturesChanged([req.captureId]);
    return ok(undefined);
  });

  // ── video:frames ──────────────────────────────────────────────────
  //
  // Filmstrip contact strip for the timeline. Extraction + on-disk
  // cache live in `recording/video-frames.ts`; the renderer displays
  // the returned `pwrsnap-cache://v/…` URL through the serve-only
  // protocol arm.
  bus.register("video:frames", async (req) => {
    if (typeof req.captureId !== "string" || req.captureId.length === 0) {
      return err(validationError("invalid_capture_id", "video:frames: captureId must be a non-empty string"));
    }
    if (req.count !== undefined && (typeof req.count !== "number" || !Number.isFinite(req.count))) {
      return err(validationError("invalid_count", "video:frames: count must be a finite number"));
    }
    if (
      req.frameWidth !== undefined &&
      (typeof req.frameWidth !== "number" || !Number.isFinite(req.frameWidth))
    ) {
      return err(validationError("invalid_frame_width", "video:frames: frameWidth must be a finite number"));
    }
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err(validationError("not_found", `video:frames: capture not found: ${req.captureId}`));
    }
    if (record.kind !== "video" || record.video === null || record.video === undefined) {
      return err(validationError("not_a_video", `video:frames: ${req.captureId} is not a video capture`));
    }
    try {
      const frames = await ensureVideoFrames(record, record.video, {
        count: req.count,
        frameWidth: req.frameWidth
      });
      return ok({
        url: videoAssetUrl(record.id, frames.fileName),
        frameCount: frames.spec.count,
        frameWidth: frames.spec.frameWidth,
        frameHeight: frames.spec.frameHeight
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("video:frames failed", { captureId: req.captureId, message });
      return err({ kind: "render", code: "video_frames_failed", message, cause });
    }
  });

  // ── video:audio ───────────────────────────────────────────────────
  //
  // Full-clip audio for the waveform lane. Reuses the sizzle
  // native-audio extractor (content-addressed under sizzle-cache) and
  // mirrors the result into the per-capture video asset dir so the
  // `pwrsnap-cache://v/<id>/audio.m4a` arm can serve it.
  bus.register("video:audio", async (req) => {
    if (typeof req.captureId !== "string" || req.captureId.length === 0) {
      return err(validationError("invalid_capture_id", "video:audio: captureId must be a non-empty string"));
    }
    const record = getCaptureById(req.captureId);
    if (record === null) {
      return err(validationError("not_found", `video:audio: capture not found: ${req.captureId}`));
    }
    if (record.kind !== "video" || record.video === null || record.video === undefined) {
      return err(validationError("not_a_video", `video:audio: ${req.captureId} is not a video capture`));
    }
    if (!record.video.hasSystemAudio && !record.video.hasMicrophoneAudio) {
      return ok({ hasAudio: false as const });
    }
    if (record.legacy_src_path === null) {
      return err(validationError("no_video_path", `video:audio: ${req.captureId} has no source path`));
    }
    try {
      await ensureVideoAudioAsset({
        captureId: record.id,
        videoPath: record.legacy_src_path,
        durationSec: record.video.durationSec
      });
      return ok({
        hasAudio: true as const,
        url: videoAssetUrl(record.id, VIDEO_AUDIO_ASSET),
        mimeType: "audio/mp4" as const
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("video:audio failed", { captureId: req.captureId, message });
      return err({ kind: "render", code: "video_audio_failed", message, cause });
    }
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

  // ── video:presetMetrics ───────────────────────────────────────────
  //
  // Returns six entries (2 formats × 3 presets) describing the
  // estimated or exact output dims + byte size for each combination.
  // The renderer's 6-card grid calls this on mount to populate the
  // cards before any user click. Cache hits return exact byte
  // counts (read off the cache row); cache misses return estimated
  // bytes computed from the source resolution + preset scale.
  bus.register("video:presetMetrics", async (req) => {
    if (typeof req.captureId !== "string" || req.captureId.length === 0) {
      return err(validationError("invalid_capture_id", "video:presetMetrics: captureId must be a non-empty string"));
    }
    const record = getCaptureById(req.captureId);
    if (record === null || record.deleted_at !== null) {
      return err(validationError("not_found", `video:presetMetrics: capture not found: ${req.captureId}`));
    }
    if (record.kind !== "video" || record.video === null || record.video === undefined) {
      return err(validationError("not_a_video", `video:presetMetrics: ${req.captureId} is not a video`));
    }
    if (req.range !== undefined) {
      const r = req.range;
      if (
        typeof r?.start !== "number" ||
        typeof r?.end !== "number" ||
        !Number.isFinite(r.start) ||
        !Number.isFinite(r.end) ||
        r.end < r.start
      ) {
        return err(
          validationError(
            "invalid_range",
            "video:presetMetrics: range start/end must be finite numbers with end >= start"
          )
        );
      }
    }
    const range = req.range ?? record.video.defaultRange;
    const normalized = normalizeRange(range, record.video.durationSec);
    const durationSec = normalized.end - normalized.start;
    // Default audio choice mirrors the same fallback the encoder
    // uses when audio is omitted: GIF silent, MP4 inherits the
    // recorded tracks. We compute metrics against this default so
    // cache lookups land on the same row a default-args click would
    // populate.
    const mp4Audio = {
      includeSystemAudio: record.video.hasSystemAudio,
      includeMicrophone: record.video.hasMicrophoneAudio
    };
    const presets: readonly VideoPreset[] = ["low", "med", "high"];
    const metrics: VideoPresetMetric[] = [];
    for (const format of ["gif", "mp4"] as const) {
      for (const preset of presets) {
        const dims = computePresetDimensions(format, preset, record.width_px, record.height_px);
        const cached = lookupExport({
          captureId: record.id,
          range: normalized,
          format,
          preset,
          audio: format === "gif" ? { includeSystemAudio: false, includeMicrophone: false } : mp4Audio
        });
        const byteSize =
          cached !== null
            ? cached.byteSize
            : estimateVideoByteSize(format, preset, dims.widthPx, dims.heightPx, durationSec);
        metrics.push({
          format,
          preset,
          widthPx: dims.widthPx,
          heightPx: dims.heightPx,
          byteSize,
          fromCache: cached !== null
        });
      }
    }
    return ok({ metrics });
  });

  // ── video:prepareDrag ─────────────────────────────────────────────
  //
  // Mirrors `capture:prepareDrag` for video: ensures the encoded
  // file exists (cache-hit or fresh encode), extracts a poster frame
  // for the drag icon, and creates a human-friendly file alias via
  // `prepareRenderedFileAlias`. The main-side IPC listener for
  // `video:drag-start` (in `apps/desktop/src/main/ipc.ts`) calls
  // this then fires `event.sender.startDrag({ file, icon })`.
  bus.register("video:prepareDrag", async (req) => {
    // `ipc.ts::parseVideoDragRequest` already screens the native
    // drag payload, but the bus is reachable without it (HTTP RPC,
    // MCP), so the verb validates for itself too.
    const valid = validateVideoExportRequest(req, "video:prepareDrag");
    if (!valid.ok) return valid;
    const resolved = await resolveVideoExport(req);
    if (!resolved.ok) {
      return err(mapVideoResolveError(resolved.error, "video:prepareDrag", req.captureId));
    }
    try {
      const { result, record, video } = resolved.value;
      const displayName = buildPresetExportDisplayName({
        record,
        enrichment: getCaptureEnrichment(record.id),
        preset: req.preset,
        ext: req.format
      });
      const aliasPath = await prepareRenderedFileAlias(result.path, displayName);
      const iconPath = await ensureVideoPoster(record, video);
      log.info("video drag prepared", {
        captureId: record.id,
        format: req.format,
        preset: req.preset,
        fromCache: result.fromCache,
        aliasPath
      });
      return ok({ path: aliasPath, iconPath });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.error("video:prepareDrag failed", {
        captureId: req.captureId,
        format: req.format,
        preset: req.preset,
        message
      });
      return err({ kind: "render", code: "video_prepare_drag_failed", message, cause });
    }
  });
}

/** Output dimensions for a (format, preset) pair against a source.
 *  Reads the canonical preset width table from the encoder so this
 *  accessor never drifts from what ffmpeg actually produces. */
function computePresetDimensions(
  format: "gif" | "mp4",
  preset: VideoPreset,
  sourceWidth: number,
  sourceHeight: number
): { widthPx: number; heightPx: number } {
  const targetWidth =
    format === "gif" ? GIF_PRESETS[preset].width : MP4_PRESETS[preset].width;
  return computeOutputDimensions(targetWidth, sourceWidth, sourceHeight);
}

/** Rough byte-size estimate for a (format, preset) pair. Used as a
 *  placeholder in `video:presetMetrics` while the actual file
 *  hasn't been encoded yet. The math is calibrated for "screen
 *  content" (mostly-static UI, with motion at cursor / scroll
 *  bursts) — typical PwrSnap recordings.
 *
 *  GIF: ~10 KB per frame for 720p, scaled with pixel count. fps
 *  picked from the preset's frame rate.
 *
 *  MP4: bitrate model. The encoder owns the real per-preset bitrate;
 *  these estimates mirror the LOW / MED / HIGH ladder closely enough
 *  for pre-click labels.
 *
 *  All of this is replaced by the exact cache row size once the
 *  user clicks the card. Estimates only feed the renderer's
 *  pre-click "what to expect" subtitle. */
function estimateVideoByteSize(
  format: "gif" | "mp4",
  preset: VideoPreset,
  widthPx: number,
  heightPx: number,
  durationSec: number
): number {
  if (format === "gif") {
    const pixels = widthPx * heightPx;
    const fps = GIF_PRESETS[preset].fps;
    // 0.20 bpp per palette-encoded GIF frame — calibrated for
    // screen content with bayer dither at the LMH fps tiers.
    const frameBytes = pixels * 0.20;
    return Math.round(frameBytes * fps * durationSec);
  }
  // MP4 — model bitrate from the encoder presets. Numbers are deliberate
  // ballpark; the renderer surfaces these as `~N MB` so a 30% miss
  // is acceptable.
  const bitrateBps = mp4PresetBitrateBps(preset);
  return Math.round((bitrateBps / 8) * durationSec);
}

function mp4PresetBitrateBps(preset: VideoPreset): number {
  const bitrate = MP4_PRESETS[preset].bitrate;
  const match = /^(\d+)k$/.exec(bitrate);
  if (match === null) {
    throw new Error(`recording-handlers: unsupported MP4 preset bitrate ${bitrate}`);
  }
  return Number(match[1]) * 1000;
}
