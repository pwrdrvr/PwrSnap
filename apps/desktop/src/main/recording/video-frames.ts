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
// baked into the filename — no DB migration, and orphaned strips are
// tolerated the same way `poster.png` is.
//
// Sampling: input-side `-ss` by half an interval, then `fps=N/D`, so
// frame i lands at `(i + 0.5) * D / N`. Midpoint sampling sidesteps
// the frequently-black frame 0 of screen recordings (see
// video-poster.ts) and centers each thumbnail on the span it
// represents in the strip.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureRecord, VideoCaptureMetadata } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getCacheRoot } from "../persistence/paths";
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
  return `frames-n${spec.count}-w${spec.frameWidth}.jpg`;
}

/**
 * Build the ffmpeg argv for a contact strip. Pure — the unit test
 * pins the shape so a refactor can't silently drop the midpoint
 * offset or the tile geometry.
 */
export function buildFramesArgs(input: {
  sourcePath: string;
  durationSec: number;
  spec: FramesSpec;
  outputPath: string;
}): string[] {
  const { spec } = input;
  const duration = Math.max(input.durationSec, 0.001);
  const interval = duration / spec.count;
  const fps = spec.count / duration;
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    (interval / 2).toFixed(3),
    "-i",
    input.sourcePath,
    "-an",
    "-sn",
    "-vf",
    [
      `fps=${fps.toFixed(6)}`,
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

// In-flight de-dup, same rationale as video-poster.ts — the Library
// timeline and a float-over can both ask for the same strip in the
// same second.
const inFlight = new Map<string, Promise<FramesResult>>();

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
  const key = `${record.id}:${framesFileName(spec)}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const promise = extractFrames(record, video, spec);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Per-capture directory that holds every derived video asset the
 *  `pwrsnap-cache://v/<id>/…` protocol arm is allowed to serve. */
export function videoAssetDir(captureId: string): string {
  return join(getCacheRoot(), "video", captureId);
}

async function extractFrames(
  record: CaptureRecord,
  video: VideoCaptureMetadata,
  spec: FramesSpec
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
