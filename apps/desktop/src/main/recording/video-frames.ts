// Filmstrip contact-strip extractor — pulls N evenly spaced frames out
// of a video source with one ffmpeg run and tiles them left→right
// into a single JPEG under the per-capture render cache (next to
// `poster.png` from `video-poster.ts` and the export artifacts from
// `recording-exporter.ts`). Backs the `video:frames` IPC that the
// Library timeline + float-over mini-trim use for their filmstrip
// lane.
//
// Why a contact strip instead of N files: one file, one protocol
// request, one `<img>`; the renderer slices it with `object-position`
// / background offsets. Cache key is `(captureId, count, frameWidth)`
// plus `FRAMES_PIPELINE_VERSION`, baked into the filename — no DB
// migration, and orphaned strips (including every strip a version bump
// retires) are tolerated the same way `poster.png` is.
//
// Sampling: tile k shows the frame ON SCREEN at the middle of its span,
// `(k + 0.5) * D / N` — the latest frame at or before that instant,
// which is what a player shows there. Every filter in the chain is
// load-bearing:
//
//   tpad    Clones the last frame past EOF. `durationSec` is wall-clock,
//           and the recorder appends only frames whose content changed and
//           never ends its session explicitly, so a take that closes on a
//           still screen has a video track that stops seconds before
//           `durationSec`. Every tile past that point used to be black.
//   setpts  Shifts the timeline back half an interval so fps tick k lands
//           on the span's midpoint rather than its start.
//   fps     `round=up`: tick k takes the latest frame at or before it. The
//           default rounding takes one up to half an interval LATE, so the
//           v1 strip actually showed the END of each span, and its last
//           tile sat on the clip's final instant — where one rounding step
//           of the EOF timestamp decided between a frame and a black tile
//           (a 40.000 s clip at 12 tiles emitted 11). `start_time=0` pins
//           tick 0 when the first frame arrives after it (it is duplicated
//           backwards); without it the whole strip shifts a slot later and
//           tile 0 shows tile 1's frame.
//   tile    N×1. It pads a short strip with black, so everything above
//           exists to hand it exactly N frames.
//
// No input-side `-ss`. An accurate seek DISCARDS every frame before the
// seek point, and a take that opens on a still screen holds frame 0
// across it: the v1 strip started on the first change after the seek and
// ran out of frames before the end. Frame 0 is the recorder's first
// complete frame, so showing it when nothing moved is correct. Decoding
// the skipped half-interval costs nothing next to decoding the rest.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getCacheRoot } from "../persistence/paths";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

const log = getMainLogger("pwrsnap:video-frames");

export const FRAMES_COUNT_DEFAULT = 24;
export const FRAMES_COUNT_MIN = 2;
export const FRAMES_COUNT_MAX = 96;
export const FRAMES_WIDTH_DEFAULT = 96;
export const FRAMES_WIDTH_MIN = 16;
export const FRAMES_WIDTH_MAX = 320;
/** Widths are quantized to this step so tiny renderer measurement
 *  differences don't produce near-duplicate strips on disk. */
export const FRAMES_WIDTH_STEP = 16;
/** Frame counts are quantized to this step for the same reason. */
export const FRAMES_COUNT_STEP = 4;
/**
 * Part of the cache filename. Bump it whenever `buildFramesArgs` changes
 * which frame a tile shows, or strips already on disk keep being served.
 * v1 is the unversioned `frames-n…` name, which sampled span ends and
 * could end in a black tile.
 */
export const FRAMES_PIPELINE_VERSION = 2;

export type FramesSpec = {
  count: number;
  frameWidth: number;
  frameHeight: number;
};

/**
 * Normalize a renderer request into the quantized spec that names the
 * cache file. Pure — unit-tested without ffmpeg.
 */
export function normalizeFramesSpec(input: {
  count?: number | undefined;
  frameWidth?: number | undefined;
  sourceWidthPx: number;
  sourceHeightPx: number;
}): FramesSpec {
  const rawCount = Number.isFinite(input.count) ? (input.count as number) : FRAMES_COUNT_DEFAULT;
  const rawWidth = Number.isFinite(input.frameWidth)
    ? (input.frameWidth as number)
    : FRAMES_WIDTH_DEFAULT;
  const count = clamp(
    Math.round(rawCount / FRAMES_COUNT_STEP) * FRAMES_COUNT_STEP,
    FRAMES_COUNT_MIN,
    FRAMES_COUNT_MAX
  );
  const frameWidth = clamp(
    Math.round(rawWidth / FRAMES_WIDTH_STEP) * FRAMES_WIDTH_STEP,
    FRAMES_WIDTH_MIN,
    FRAMES_WIDTH_MAX
  );
  const aspect =
    input.sourceWidthPx > 0 && input.sourceHeightPx > 0
      ? input.sourceHeightPx / input.sourceWidthPx
      : 9 / 16;
  // Explicit even height (instead of ffmpeg's `-2`) so the renderer
  // knows the exact tile geometry without probing the JPEG.
  const frameHeight = Math.max(2, Math.round((frameWidth * aspect) / 2) * 2);
  return { count, frameWidth, frameHeight };
}

export function framesFileName(spec: FramesSpec): string {
  return `frames-v${FRAMES_PIPELINE_VERSION}-n${spec.count}-w${spec.frameWidth}.jpg`;
}

/**
 * Build the ffmpeg argv for a contact strip. Pure — the unit test
 * pins the shape so a refactor can't silently drop the midpoint
 * offset, the end padding, or the tile geometry. The header explains
 * each filter.
 */
export function buildFramesArgs(input: {
  sourcePath: string;
  durationSec: number;
  spec: FramesSpec;
  outputPath: string;
}): string[] {
  const { spec } = input;
  // One rounded duration feeds every filter, so the shift and the rate
  // cannot disagree about where the ticks fall.
  const durationArg = Math.max(input.durationSec, 0.001).toFixed(3);
  const halfInterval = Number(durationArg) / spec.count / 2;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input.sourcePath,
    "-an",
    "-sn",
    "-vf",
    [
      // Pad by the whole claimed duration: enough for the last tick even
      // when the media is far shorter, and bounded, so a stream with no
      // usable frame rate pads nothing rather than forever. `-frames:v 1`
      // stops ffmpeg as soon as the strip is full, so only media that ends
      // before the last tick generates clones, and only as many as that
      // gap needs (10 s of media under a 600 s claim: ~0.2 s wall).
      `tpad=stop_mode=clone:stop_duration=${durationArg}`,
      `setpts=PTS-${halfInterval.toFixed(6)}/TB`,
      `fps=fps=${spec.count}/${durationArg}:start_time=0:round=up`,
      `scale=${spec.frameWidth}:${spec.frameHeight}:flags=bilinear`,
      `tile=${spec.count}x1`
    ].join(","),
    "-frames:v",
    "1",
    "-q:v",
    "4",
    input.outputPath
  ];
}

export type FramesResult = {
  path: string;
  fileName: string;
  spec: FramesSpec;
};

/**
 * Resolve (extract on miss) the contact strip for a video capture.
 * Throws when ffmpeg is unavailable or fails, or when the source path
 * is missing; the handler maps that to a `render` error.
 */
export async function ensureVideoFrames(
  record: CaptureRecord,
  video: VideoCaptureMetadata,
  request: { count?: number | undefined; frameWidth?: number | undefined }
): Promise<FramesResult> {
  const spec = normalizeFramesSpec({
    count: request.count,
    frameWidth: request.frameWidth,
    sourceWidthPx: record.width_px,
    sourceHeightPx: record.height_px
  });
  // Through the derived-cache gate: the strip is published by `rename` into
  // `<cacheRoot>/video/<id>/`, which `purgeCacheForCapture` and Clear/Trim
  // `rm -rf`. Ungated, that rename lands after the delete and recreates the
  // directory for a capture that may no longer exist. The gate also does the
  // in-flight de-dup this function used to keep for itself — the Library
  // timeline and a float-over can both ask for the same strip in the same
  // second — so there is one registry, not two that must agree.
  const fileName = framesFileName(spec);
  return runGatedCacheWrite(record.id, join(videoAssetDir(record.id), fileName), (signal) =>
    extractFrames(record, video, spec, signal)
  );
}

/** Per-capture directory that holds every derived video asset the
 *  `pwrsnap-cache://v/<id>/…` protocol arm is allowed to serve. */
export function videoAssetDir(captureId: string): string {
  return join(getCacheRoot(), "video", captureId);
}

async function extractFrames(
  record: CaptureRecord,
  video: VideoCaptureMetadata,
  spec: FramesSpec,
  signal?: AbortSignal | undefined
): Promise<FramesResult> {
  const dir = videoAssetDir(record.id);
  const fileName = framesFileName(spec);
  const outputPath = join(dir, fileName);

  if (existsSync(outputPath)) {
    try {
      const info = await stat(outputPath);
      if (info.size > 0) return { path: outputPath, fileName, spec };
    } catch {
      // Fall through to re-extraction.
    }
  }

  if (record.legacy_src_path === null) {
    throw new Error(`video-frames: capture ${record.id} has no source path`);
  }
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg not found: bundled PwrSnapFFmpeg is missing and no ffmpeg was found on PATH — set PWRSNAP_FFMPEG_PATH (see docs/ffmpeg-build-reference.md)"
    );
  }
  await mkdir(dir, { recursive: true });

  // Write to a temp name and rename so a crashed ffmpeg never leaves
  // a truncated strip at the cache path (the size>0 check above would
  // otherwise trust it).
  const tmpPath = `${outputPath}.${process.pid}.tmp.jpg`;
  const args = buildFramesArgs({
    sourcePath: record.legacy_src_path,
    durationSec: video.durationSec,
    spec,
    outputPath: tmpPath
  });
  await runFfmpeg(ffmpeg, args);
  // Last check before the strip becomes visible: a cleanup that removed this
  // directory while ffmpeg ran must not have it recreated by this rename.
  signal?.throwIfAborted();
  const { rename } = await import("node:fs/promises");
  await rename(tmpPath, outputPath);
  log.info("video frames extracted", { captureId: record.id, fileName, ...spec });
  return { path: outputPath, fileName, spec };
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
