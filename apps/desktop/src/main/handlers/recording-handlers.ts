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
  readRecordingReadiness,
  requestPermission
} from "../recording/recording-permissions";
import {
  guardScreenCapture,
  markScreenCapturePrompted,
  readScreenCapturePrompted
} from "../capture/screen-permission-gate";
import {
  getRecordingService,
  type RecordingService
} from "../recording/recording-service";
import { getRecordingState } from "../recording/recording-state";
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
import { ensureVideoPoster } from "../recording/video-poster";
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
    // Superset of the OS-level snapshot: also report whether we've ever
    // triggered the screen-capture prompt, so the System Permissions page
    // can distinguish "Not yet requested" from "Denied" (macOS can't —
    // see screen-permission-gate.ts).
    return ok({
      ...readRecordingReadiness(),
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
      // won't prompt twice. darwin-only: off-darwin `requestPermission`
      // is a no-op that never prompts, so there's nothing to remember.
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
    // Screen Recording is required: the gate fires the macOS prompt on
    // the first-ever attempt and routes to System Settings thereafter
    // (see screen-permission-gate.ts). Missing audio is a degraded
    // continuation that the selector dialog handled before calling us.
    const blocked = await guardScreenCapture();
    if (blocked) return blocked;
    const readiness = readRecordingReadiness();
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
    const range = record.video.defaultRange;
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
 *  MP4: bitrate model. HIGH is stream-copy so estimate from source
 *  resolution (we don't know the actual source bitrate, so 0.1 bpp
 *  × pixel count × fps is a reasonable proxy). LOW / MED use the
 *  CRF as a rough bitrate proxy (lower CRF = higher bitrate).
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
  const pixels = widthPx * heightPx;
  if (format === "gif") {
    const fps = GIF_PRESETS[preset].fps;
    // 0.20 bpp per palette-encoded GIF frame — calibrated for
    // screen content with bayer dither at the LMH fps tiers.
    const frameBytes = pixels * 0.20;
    return Math.round(frameBytes * fps * durationSec);
  }
  // MP4 — model bitrate from CRF / source. Numbers are deliberate
  // ballpark; the renderer surfaces these as `~N MB` so a 30% miss
  // is acceptable.
  const sourceFps = 30;
  let bitrateBps: number;
  if (preset === "low") {
    bitrateBps = 3_000_000;
  } else if (preset === "med") {
    bitrateBps = 6_500_000;
  } else {
    // HIGH: stream-copy. ~0.1 bpp × pixels × fps approximates h.264
    // at the recorder's quality setting; close enough to "source"
    // until the cache returns exact bytes.
    bitrateBps = Math.round(pixels * sourceFps * 0.1);
  }
  return Math.round((bitrateBps / 8) * durationSec);
}
