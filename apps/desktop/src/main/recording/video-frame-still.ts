// Full-resolution still of the frame a player shows at one instant of a
// recording. Backs "Copy Frame" and "Save Frame as Snap" on the Library's
// video stage and export rail (`clipboard:copyVideoFrame`,
// `video:saveFrameAsSnap`).
//
// The rule it implements is the player's: at time T the screen shows the
// LATEST frame whose timestamp is at or before T. A recording from the
// native recorder holds a frame for as long as the screen did not change
// (it appends only changed frames), so "the frame at T" is very often one
// that started seconds earlier. Asking ffmpeg for the first frame AT or
// AFTER T — what an accurate `-ss` gives — returns the NEXT change, which is
// a picture the user never saw at that playhead. Past the last frame it
// returns nothing at all.
//
// So the extract seeks with `-noaccurate_seek` (to the keyframe at or before
// T, which always exists: frame 0 is one), keeps every decoded frame whose
// time relative to T is <= 0, and lets `-update 1` overwrite the output with
// each one. The last frame written is the frame on screen at T. Input-side
// `-ss` makes ffmpeg's `t` relative to the seek TARGET (not the keyframe it
// landed on), which also absorbs a non-zero container start time.
//
// Cached under `<cacheRoot>/video/<id>/` beside the poster and contact strip,
// keyed by the millisecond, and written through the derived-cache gate like
// those lanes so a purge never races the publish.

import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { CaptureRecord } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getCacheRoot } from "../persistence/paths";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

const log = getMainLogger("pwrsnap:video-frame-still");

/** Bump when the extract would choose a different frame for the same time. */
export const FRAME_STILL_PIPELINE_VERSION = 1;

/** Tolerance on "at or before T": ffmpeg's timestamps are rationals in the
 *  stream time base, so a frame stamped exactly T can surface as T + 1e-6.
 *  Half a millisecond is far below any frame interval a recorder produces. */
const AT_OR_BEFORE_EPSILON_SEC = 0.0005;

export type VideoFrameStill = {
  path: string;
  widthPx: number;
  heightPx: number;
  /** The requested time, quantized to the millisecond the cache is keyed by. */
  timeSec: number;
};

/** Quantize to a whole millisecond and clamp into the recording. Pure. */
export function normalizeFrameTime(timeSec: number, durationSec: number): number {
  const finiteDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const t = Number.isFinite(timeSec) ? timeSec : 0;
  const clamped = Math.min(Math.max(t, 0), finiteDuration);
  return Math.round(clamped * 1000) / 1000;
}

export function frameStillFileName(timeSec: number): string {
  return `frame-v${FRAME_STILL_PIPELINE_VERSION}-${Math.round(timeSec * 1000)}ms.png`;
}

/**
 * ffmpeg argv for one still. Pure — the unit test pins the shape so a
 * refactor cannot swap in an accurate seek (the next change, not the frame
 * on screen) or drop `-update` (an image2 sequence error past one frame).
 * `seekSec` is the requested time on the first pass and 0 on the fallback
 * pass, where `selectSec` carries the absolute time instead.
 */
export function buildFrameStillArgs(input: {
  sourcePath: string;
  seekSec: number;
  selectSec: number;
  outputPath: string;
}): string[] {
  const limit = (input.selectSec + AT_OR_BEFORE_EPSILON_SEC).toFixed(4);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    input.seekSec.toFixed(3),
    "-noaccurate_seek",
    "-i",
    input.sourcePath,
    "-map",
    "0:v:0",
    "-vf",
    `select='lte(t\\,${limit})'`,
    "-fps_mode",
    "passthrough",
    "-update",
    "1",
    "-c:v",
    "png",
    "-f",
    "image2",
    input.outputPath
  ];
}

/**
 * Resolve the PNG still of `record` at `timeSec` (source time). Cache-hit
 * returns the existing file; concurrent callers share one extract.
 */
export async function ensureVideoFrameStill(
  record: CaptureRecord,
  timeSec: number
): Promise<VideoFrameStill> {
  const durationSec = record.video?.durationSec ?? 0;
  const t = normalizeFrameTime(timeSec, durationSec);
  const dir = join(getCacheRoot(), "video", record.id);
  const finalPath = join(dir, frameStillFileName(t));
  const path = await runGatedCacheWrite(record.id, finalPath, () =>
    extractFrameStill(record, t, dir, finalPath)
  );
  const meta = await sharp(path).metadata();
  return { path, widthPx: meta.width ?? 0, heightPx: meta.height ?? 0, timeSec: t };
}

async function extractFrameStill(
  record: CaptureRecord,
  timeSec: number,
  dir: string,
  finalPath: string
): Promise<string> {
  if (await hasBytes(finalPath)) return finalPath;
  if (record.legacy_src_path === null) {
    throw new Error(`video-frame-still: capture ${record.id} has no source path`);
  }
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg not found: bundled PwrSnapFFmpeg is missing and no ffmpeg was found on PATH — set PWRSNAP_FFMPEG_PATH (see docs/ffmpeg-build-reference.md)"
    );
  }
  await mkdir(dir, { recursive: true });
  const staging = `${finalPath}.partial-${process.pid}-${Date.now()}.png`;
  try {
    await runFfmpeg(
      ffmpeg,
      buildFrameStillArgs({ sourcePath: record.legacy_src_path, seekSec: timeSec, selectSec: 0, outputPath: staging })
    );
    if (!(await hasBytes(staging))) {
      // The keyframe index put the seek past T (a broken or edited index);
      // decode from the start instead, where `t` is absolute.
      log.warn("frame still: seek found no frame; decoding from start", {
        captureId: record.id,
        timeSec
      });
      await runFfmpeg(
        ffmpeg,
        buildFrameStillArgs({ sourcePath: record.legacy_src_path, seekSec: 0, selectSec: timeSec, outputPath: staging })
      );
    }
    if (!(await hasBytes(staging))) {
      throw new Error(`no video frame at or before ${timeSec.toFixed(3)} s`);
    }
    await rename(staging, finalPath);
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
  }
  log.info("video frame still extracted", { captureId: record.id, timeSec });
  return finalPath;
}

async function hasBytes(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
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
