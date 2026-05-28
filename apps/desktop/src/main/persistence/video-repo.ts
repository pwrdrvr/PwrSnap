// Video-captures metadata read/write surface. Companion to
// captures-repo.ts — every video metadata mutation goes through here.
// The 1:1 FK to `captures.id` means we never INSERT a video_captures
// row without first calling `insertCapture` from captures-repo (and
// ON DELETE CASCADE in the schema means we never need to manually
// remove this row when the capture goes — hardDeleteCapture handles
// it for us).

import type {
  RecordingSubject,
  VideoCaptureMetadata,
  VideoExportAudio,
  VideoExportResult,
  VideoPreset,
  VideoRange
} from "@pwrsnap/shared";
import { getDb } from "./db";

type VideoRow = {
  capture_id: string;
  duration_sec: number;
  container_format: "mp4" | "mov";
  has_system_audio: number;
  has_microphone_audio: number;
  default_range_start_sec: number;
  default_range_end_sec: number;
  preview_path: string | null;
  preview_status: "pending" | "ready" | "failed";
  subject_kind: "region" | "window" | "display";
  subject_display_id: number | null;
  subject_window_id: number | null;
  source_rect_x_px: number | null;
  source_rect_y_px: number | null;
  source_rect_w_px: number | null;
  source_rect_h_px: number | null;
  created_at: string;
};

function rowToMetadata(row: VideoRow): VideoCaptureMetadata {
  return {
    durationSec: row.duration_sec,
    containerFormat: row.container_format,
    hasSystemAudio: row.has_system_audio === 1,
    hasMicrophoneAudio: row.has_microphone_audio === 1,
    defaultRange: {
      start: row.default_range_start_sec,
      end: row.default_range_end_sec
    },
    previewPath: row.preview_path,
    previewStatus: row.preview_status
  };
}

export type InsertVideoMetadata = {
  captureId: string;
  durationSec: number;
  containerFormat: "mp4" | "mov";
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  subject: RecordingSubject;
};

/**
 * Insert the video-specific metadata for a freshly-persisted video
 * capture. Caller must have already inserted the row in `captures`
 * via `insertCapture`. Idempotent on capture_id — re-running during
 * a crash-recovery re-import is a no-op (the PK enforces).
 *
 * `defaultRange` seeds to the full clip (`[0, durationSec]`) so the
 * float-over can paint a full-range scrubber before the user picks a
 * subrange. Preview status seeds to `pending`; the preview-proxy
 * worker bumps it to `ready`/`failed` when its async job finishes.
 */
export function insertVideoMetadata(input: InsertVideoMetadata): void {
  const db = getDb();
  const subject = input.subject;
  db.prepare(
    `INSERT INTO video_captures (
       capture_id, duration_sec, container_format,
       has_system_audio, has_microphone_audio,
       default_range_start_sec, default_range_end_sec,
       preview_path, preview_status,
       subject_kind,
       subject_display_id, subject_window_id,
       source_rect_x_px, source_rect_y_px,
       source_rect_w_px, source_rect_h_px,
       created_at
     ) VALUES (
       @capture_id, @duration_sec, @container_format,
       @has_system_audio, @has_microphone_audio,
       0, @duration_sec,
       NULL, 'pending',
       @subject_kind,
       @subject_display_id, @subject_window_id,
       @source_rect_x_px, @source_rect_y_px,
       @source_rect_w_px, @source_rect_h_px,
       datetime('now')
     )
     ON CONFLICT(capture_id) DO NOTHING`
  ).run({
    capture_id: input.captureId,
    duration_sec: input.durationSec,
    container_format: input.containerFormat,
    has_system_audio: input.hasSystemAudio ? 1 : 0,
    has_microphone_audio: input.hasMicrophoneAudio ? 1 : 0,
    subject_kind: subject.kind,
    subject_display_id: subject.kind === "region" || subject.kind === "window" || subject.kind === "display"
      ? subject.displayId
      : null,
    subject_window_id: subject.kind === "window" ? subject.windowId : null,
    source_rect_x_px: subject.kind === "region" || subject.kind === "window" ? subject.rect.x : null,
    source_rect_y_px: subject.kind === "region" || subject.kind === "window" ? subject.rect.y : null,
    source_rect_w_px: subject.kind === "region" || subject.kind === "window" ? subject.rect.w : null,
    source_rect_h_px: subject.kind === "region" || subject.kind === "window" ? subject.rect.h : null
  });
}

/**
 * Look up the video metadata for a capture id. Returns `null` for
 * image captures, missing rows, or rows where the FK target was
 * hard-deleted (cascade should have removed this row too — but
 * defensive null-return shields callers from a stale-cache race).
 *
 * The float-over and Library card both call this on every render of
 * a video; it's a single primary-key lookup so the cost is negligible.
 * If we ever want to fold it into the captures-repo's list query as
 * a LEFT JOIN, the read shape stays the same — this helper is the
 * stable seam.
 */
export function getVideoMetadata(captureId: string): VideoCaptureMetadata | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM video_captures WHERE capture_id = ?")
    .get(captureId) as VideoRow | undefined;
  if (row === undefined) return null;
  return rowToMetadata(row);
}

/**
 * Bulk variant of `getVideoMetadata`. Used by the Library list path
 * to enrich a page of capture rows in a single query rather than N
 * sequential lookups.
 */
export function listVideoMetadata(
  captureIds: readonly string[]
): Map<string, VideoCaptureMetadata> {
  if (captureIds.length === 0) return new Map();
  const db = getDb();
  // Build a parameter list — better-sqlite3 doesn't support `IN (?)`
  // with array binding directly, so we generate the placeholders.
  const placeholders = captureIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM video_captures WHERE capture_id IN (${placeholders})`)
    .all(...captureIds) as VideoRow[];
  const out = new Map<string, VideoCaptureMetadata>();
  for (const row of rows) {
    out.set(row.capture_id, rowToMetadata(row));
  }
  return out;
}

/**
 * Replace the persisted default range for a video. Validated and
 * clamped against the stored duration so a renderer bug can't
 * persist `end > duration` (the next mount would render a broken
 * scrubber). Returns the normalized range that actually got written.
 */
export function setDefaultRange(captureId: string, range: VideoRange): VideoRange | null {
  const db = getDb();
  const row = db
    .prepare("SELECT duration_sec FROM video_captures WHERE capture_id = ?")
    .get(captureId) as { duration_sec: number } | undefined;
  if (row === undefined) return null;
  const normalized = normalizeRange(range, row.duration_sec);
  db.prepare(
    `UPDATE video_captures
       SET default_range_start_sec = @start,
           default_range_end_sec = @end
     WHERE capture_id = @captureId`
  ).run({ captureId, start: normalized.start, end: normalized.end });
  return normalized;
}

/**
 * Update the preview-proxy asset path + status. Called by the
 * post-recording preview generator when it finishes (or fails). The
 * Library hover preview observes `events:captures:changed` and
 * re-fetches, picking up the new path.
 */
export function updatePreview(
  captureId: string,
  previewPath: string | null,
  status: "pending" | "ready" | "failed"
): void {
  const db = getDb();
  db.prepare(
    `UPDATE video_captures
       SET preview_path = @path,
           preview_status = @status
     WHERE capture_id = @captureId`
  ).run({ captureId, path: previewPath, status });
}

/**
 * Clamp + sanitize a range against a known duration. The float-over
 * scrubber should never produce an out-of-bounds range, but a
 * malicious or buggy bus client can; the validator at the bus
 * boundary rejects nonsense and this helper normalizes anything
 * that survives to a valid in-bounds range.
 */
export function normalizeRange(range: VideoRange, durationSec: number): VideoRange {
  const start = Math.max(0, Math.min(range.start, durationSec));
  const end = Math.max(start, Math.min(range.end, durationSec));
  return { start, end };
}

// ── video_export_cache ──────────────────────────────────────────────

type ExportCacheRow = {
  capture_id: string;
  range_start_sec: number;
  range_end_sec: number;
  format: "gif" | "mp4";
  preset: VideoPreset;
  include_system_audio: number;
  include_microphone: number;
  path: string;
  byte_size: number;
  created_at: string;
};

export type ExportCacheLookup = {
  captureId: string;
  range: VideoRange;
  format: "gif" | "mp4";
  preset: VideoPreset;
  audio: VideoExportAudio;
};

/**
 * Cache-lookup. Returns the on-disk artifact if a previous export
 * with the same (capture, range, format, preset, audio choices) is
 * still around. The render-cache eviction policy is shared across
 * image + video caches (see render-cache-maintenance.ts).
 *
 * `widthPx` / `heightPx` aren't persisted in the cache table — the
 * exporter computes them at call time from the source dims + preset
 * and folds them into the returned `VideoExportResult`. Storing them
 * in the DB would require backfilling existing rows; deriving them
 * each call costs ~1µs and stays in lockstep with whatever the
 * encoder ships at the moment.
 */
export function lookupExport(req: ExportCacheLookup): VideoExportResult | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM video_export_cache
       WHERE capture_id = @captureId
         AND range_start_sec = @start
         AND range_end_sec = @end
         AND format = @format
         AND preset = @preset
         AND include_system_audio = @system
         AND include_microphone = @mic`
    )
    .get({
      captureId: req.captureId,
      start: req.range.start,
      end: req.range.end,
      format: req.format,
      preset: req.preset,
      system: req.audio.includeSystemAudio ? 1 : 0,
      mic: req.audio.includeMicrophone ? 1 : 0
    }) as ExportCacheRow | undefined;
  if (row === undefined) return null;
  return {
    path: row.path,
    byteSize: row.byte_size,
    durationSec: row.range_end_sec - row.range_start_sec,
    // Placeholder dims — the exporter overwrites these from the
    // preset spec + source dims before returning to the caller.
    // Storing dims on cache rows is a follow-up if anyone needs
    // them without going back through the exporter.
    widthPx: 0,
    heightPx: 0,
    fromCache: true
  };
}

export type RecordExportInsert = {
  captureId: string;
  range: VideoRange;
  format: "gif" | "mp4";
  preset: VideoPreset;
  audio: VideoExportAudio;
  path: string;
  byteSize: number;
};

/**
 * Record a freshly-encoded export in the cache. Idempotent on the
 * cache key — re-recording with the same parameters updates the
 * path/size in place so the file rotation post-encode (atomic
 * rename) doesn't leave a stale tombstone behind.
 */
export function recordExport(input: RecordExportInsert): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO video_export_cache (
       capture_id, range_start_sec, range_end_sec, format, preset,
       include_system_audio, include_microphone,
       path, byte_size, created_at
     ) VALUES (
       @captureId, @start, @end, @format, @preset,
       @system, @mic,
       @path, @size, datetime('now')
     )
     ON CONFLICT (
       capture_id, range_start_sec, range_end_sec, format, preset,
       include_system_audio, include_microphone
     ) DO UPDATE SET
       path = excluded.path,
       byte_size = excluded.byte_size,
       created_at = excluded.created_at`
  ).run({
    captureId: input.captureId,
    start: input.range.start,
    end: input.range.end,
    format: input.format,
    preset: input.preset,
    system: input.audio.includeSystemAudio ? 1 : 0,
    mic: input.audio.includeMicrophone ? 1 : 0,
    path: input.path,
    size: input.byteSize
  });
}
