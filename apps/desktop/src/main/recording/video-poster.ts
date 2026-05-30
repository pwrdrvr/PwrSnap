// Poster frame extractor — pulls a single representative still PNG
// out of a video source via ffmpeg and caches it next to the
// `recording-exporter.ts` cache artifacts. Used as the drag preview
// icon by `video:prepareDrag` so a video drag-out shows a real
// thumbnail (matching the image drag's downscaled-source preview).
//
// We pull at the midpoint of the recording, not frame 0, because
// frame 0 of a screen recording is frequently black: the recorder
// rounds up to the GOP boundary and the first frame is the
// pre-keyframe IDR that gets decoded as solid color in many players.
// Midpoint is reliably representative content.
//
// 128px wide matches `capture-handlers.ts::DRAG_ICON_WIDTH` for the
// image drag preview so the two drag affordances feel like siblings.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getCacheRoot } from "../persistence/paths";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

const log = getMainLogger("pwrsnap:video-poster");

const POSTER_WIDTH = 128;
const POSTER_FILENAME = "poster.png";

// In-flight de-dup. Two simultaneous drag attempts on the same
// capture would otherwise race to write the same poster.png — both
// spawning ffmpeg, both writing to the same path. Output is
// deterministic (same source, same midpoint frame) so the final
// state is consistent, but it's wasted CPU and on some filesystems
// the concurrent write can produce a truncated file the second
// reader sees zero-length. The Map<captureId, Promise<string>>
// shares one extraction Promise across concurrent callers.
const inFlightPosters = new Map<string, Promise<string>>();

/**
 * Resolve the poster PNG for a video capture. Cache-hit returns the
 * existing path; cache-miss extracts frame at duration/2, scales to
 * `POSTER_WIDTH × auto`, and writes it. Concurrent calls for the
 * same captureId share one ffmpeg run. Throws if ffmpeg fails or
 * the source path doesn't exist.
 */
export async function ensureVideoPoster(
  record: CaptureRecord,
  video: VideoCaptureMetadata
): Promise<string> {
  const existing = inFlightPosters.get(record.id);
  if (existing !== undefined) return existing;

  const promise = extractPoster(record, video);
  inFlightPosters.set(record.id, promise);
  try {
    return await promise;
  } finally {
    inFlightPosters.delete(record.id);
  }
}

async function extractPoster(
  record: CaptureRecord,
  video: VideoCaptureMetadata
): Promise<string> {
  const dir = join(getCacheRoot(), "video", record.id);
  const posterPath = join(dir, POSTER_FILENAME);

  // Existence + non-zero size — empty posters from a crashed ffmpeg
  // get re-extracted on the next call.
  if (existsSync(posterPath)) {
    try {
      const info = await stat(posterPath);
      if (info.size > 0) return posterPath;
    } catch {
      // Fall through to re-extraction.
    }
  }

  if (record.legacy_src_path === null) {
    throw new Error(`video-poster: capture ${record.id} has no source path`);
  }
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg binary not available — run build:ffmpeg or set PWRSNAP_FFMPEG_PATH"
    );
  }

  await mkdir(dir, { recursive: true });

  // `-ss` BEFORE `-i` is input-side seeking (fast, may snap to
  // nearest keyframe). For poster frames we don't need frame-accurate
  // positioning, so input-side seeking is the right tradeoff.
  // `-frames:v 1` writes exactly one frame; `-vf scale` constrains
  // width with auto-height (`-2` rounds to even).
  const seekSec = (video.durationSec / 2).toFixed(3);
  const args = [
    "-y",
    "-ss",
    seekSec,
    "-i",
    record.legacy_src_path,
    "-frames:v",
    "1",
    "-vf",
    `scale=${POSTER_WIDTH}:-2:flags=lanczos`,
    posterPath
  ];

  await runFfmpeg(ffmpeg, args);
  log.info("video poster extracted", {
    captureId: record.id,
    posterPath,
    seekSec
  });
  return posterPath;
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
