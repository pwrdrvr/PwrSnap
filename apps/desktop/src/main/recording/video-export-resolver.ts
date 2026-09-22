// Shared "resolve a video export to a file on disk" entry point for
// the three video-aware handlers (`video:prepareDrag`,
// `clipboard:copyVideoFile`, `clipboard:copyVideoPath`). Each of
// those wants the same thing — given a `VideoExportCoordinates`
// (captureId, format, preset, optional range/audio), return the
// path to the encoded file, encoding it if the cache misses.
//
// Centralizing the resolution here keeps the cache-key derivation
// in one place. The omitted-audio default is the persisted MP4 audio
// preference, read through `resolveExportAudio` (mp4-export-audio.ts).

import type {
  CaptureRecord,
  VideoCaptureMetadata,
  VideoExportAudio,
  VideoExportCoordinates,
  VideoExportResult
} from "@pwrsnap/shared";
import { getCaptureById } from "../persistence/captures-repo";
import { resolveExportAudio } from "./mp4-export-audio";
import { exportVideoRange } from "./recording-exporter";
import { resolveVideoExportSpans } from "./video-export-spans";

export type ResolvedVideoExport = {
  /** The full export result — `path` is the on-disk file location;
   *  `widthPx`/`heightPx` reflect the preset's output dimensions;
   *  `fromCache` lets the caller distinguish "instant cache hit"
   *  from "fresh encode" for logging. */
  result: VideoExportResult;
  /** The capture record looked up during resolution. Returned so the
   *  caller can avoid a second `getCaptureById` round-trip — useful
   *  for handlers that need `record.id` / `record.kind` / source-app
   *  fields in their own response shape. */
  record: CaptureRecord;
  /** The video metadata block. Same rationale as `record`. */
  video: VideoCaptureMetadata;
};

export type ResolveVideoExportError =
  | { kind: "not_found" }
  | { kind: "not_a_video" }
  | { kind: "audio_track_missing"; track: "system" | "microphone" };

/**
 * Lookup + normalize + encode pipeline for the per-preset video
 * handlers. Returns either the resolved export (cache-hit or fresh)
 * or a discriminated error the caller maps into a PwrSnapError.
 * Throws if the encoder itself fails — callers wrap with try/catch
 * and surface `kind: "render"` errors.
 */
export async function resolveVideoExport(
  coords: VideoExportCoordinates
): Promise<{ ok: true; value: ResolvedVideoExport } | { ok: false; error: ResolveVideoExportError }> {
  const record = getCaptureById(coords.captureId);
  if (record === null || record.deleted_at !== null) {
    return { ok: false, error: { kind: "not_found" } };
  }
  if (record.kind !== "video" || record.video === null || record.video === undefined) {
    return { ok: false, error: { kind: "not_a_video" } };
  }

  const { range, spans } = resolveVideoExportSpans(record.video, coords);
  // GIF is always silent regardless of caller intent; an MP4 with no
  // explicit choice keeps what the user's MP4 audio preference keeps.
  // `video:export` resolves through the same function, so its preflight
  // lands on the cache key this copy / path / drag then hits.
  const effectiveAudio: VideoExportAudio = await resolveExportAudio(
    coords.format,
    coords.audio,
    record.video
  );

  if (coords.format === "mp4") {
    if (effectiveAudio.includeSystemAudio && !record.video.hasSystemAudio) {
      return { ok: false, error: { kind: "audio_track_missing", track: "system" } };
    }
    if (effectiveAudio.includeMicrophone && !record.video.hasMicrophoneAudio) {
      return { ok: false, error: { kind: "audio_track_missing", track: "microphone" } };
    }
  }

  const result = await exportVideoRange({
    record,
    video: record.video,
    format: coords.format,
    preset: coords.preset,
    range,
    spans,
    audio: effectiveAudio
  });

  return { ok: true, value: { result, record, video: record.video } };
}

/** Map a `ResolveVideoExportError` to a PwrSnapError-shaped object
 *  suitable for the bus envelope. Centralizes the error message
 *  formatting so all callers (clipboard:copyVideoFile,
 *  clipboard:copyVideoPath, video:prepareDrag) report consistently
 *  and the renderer's error toasts use the same phrasing. */
export function mapVideoResolveError(
  error: ResolveVideoExportError,
  verb: string,
  captureId: string
): { kind: "validation"; code: string; message: string } {
  if (error.kind === "not_found") {
    return {
      kind: "validation",
      code: "not_found",
      message: `${verb}: capture not found: ${captureId}`
    };
  }
  if (error.kind === "not_a_video") {
    return {
      kind: "validation",
      code: "not_a_video",
      message: `${verb}: capture ${captureId} is not a video`
    };
  }
  return {
    kind: "validation",
    code: "audio_track_missing",
    message: `${verb}: cannot include ${
      error.track === "system" ? "system audio" : "microphone"
    } — source recording has no ${error.track} track`
  };
}
