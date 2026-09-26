// On-screen activity analysis — how much of the frame changed between
// consecutive samples of a video capture. Backs `video:activity` (the
// timeline's activity lane) and `video:inspect` (the agent tools). The
// encoding and every threshold live in `@pwrsnap/shared`
// (`video-activity.ts`); this file only produces the samples.
//
// One ffmpeg run decodes the source, samples it at `sampleHz`, scales
// each sample to a small grayscale frame and streams the raw bytes to
// stdout; Node diffs consecutive frames as they arrive. Nothing but
// `fps`, `scale`, `format` and the rawvideo muxer is involved, all
// native to the LGPL build we ship (docs/ffmpeg-build-reference.md —
// no `--disable-filters`), and nothing is decoded twice.
//
// Measured on a 1701×1082, 60 s browser recording: 297 samples in
// ~0.8 s. Screen recordings are VFR and mostly still, so decoding is
// far faster than realtime.
//
// The result is cached as `activity-v1-h<hz>-w<width>.json` beside the
// contact strip and published through the derived-cache gate: it is a
// seconds-long ffmpeg run whose output lands in `<cacheRoot>/video/<id>/`
// by rename, which is exactly the class of writer AGENTS.md says must
// not race Clear / Trim / purge.

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureRecord, VideoActivityTrack, VideoCaptureMetadata } from "@pwrsnap/shared";
import { encodeActivityMagnitude } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { runGatedCacheWrite } from "../persistence/derived-cache-gate";
import { resolveFfmpegPath } from "./ffmpeg-resolver";
import { videoAssetDir } from "./video-frames";

const log = getMainLogger("pwrsnap:video-activity");

/** Bump when the measure changes (noise floor, scaling, encoding) so a
 *  stale cache file is never read as the new one. */
export const ACTIVITY_VERSION = 1;

/** Grayscale analysis width. Small on purpose — see the shared module:
 *  the downscale is what folds a blinking caret into "still". */
export const ACTIVITY_ANALYSIS_WIDTH = 192;

/** A pixel counts as changed when its luma moved more than this (of
 *  255). Above H.264's re-encode shimmer on a static screen. */
export const ACTIVITY_NOISE_FLOOR = 10;

/** 5 samples a second resolves a click from the page it opened; long
 *  recordings drop to 2 so the track stays a few thousand samples. */
export function activitySampleHz(durationSec: number): number {
  return durationSec > 3600 ? 2 : 5;
}

export function activityAnalysisSize(
  sourceWidthPx: number,
  sourceHeightPx: number
): { width: number; height: number } {
  const srcW = Math.max(2, sourceWidthPx);
  const srcH = Math.max(2, sourceHeightPx);
  const width = Math.min(ACTIVITY_ANALYSIS_WIDTH, srcW - (srcW % 2));
  const height = Math.max(2, Math.round((width * srcH) / srcW / 2) * 2);
  return { width, height };
}

export function activityFileName(sampleHz: number, width: number): string {
  return `activity-v${String(ACTIVITY_VERSION)}-h${String(sampleHz)}-w${String(width)}.json`;
}

export function buildActivityArgs(input: {
  sourcePath: string;
  sampleHz: number;
  width: number;
  height: number;
}): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    input.sourcePath,
    "-an",
    "-sn",
    "-vf",
    // `area` averages source pixels into each output pixel — the
    // low-pass that makes the measure ignore sub-pixel flicker.
    `fps=${String(input.sampleHz)},scale=${String(input.width)}:${String(input.height)}:flags=area,format=gray`,
    "-f",
    "rawvideo",
    "pipe:1"
  ];
}

/** Fraction of pixels whose value moved by more than `noiseFloor`. */
export function frameChangeFraction(
  prev: Uint8Array,
  cur: Uint8Array,
  noiseFloor: number = ACTIVITY_NOISE_FLOOR
): number {
  const n = Math.min(prev.length, cur.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i += 1) {
    const d = prev[i]! - cur[i]!;
    if (d > noiseFloor || d < -noiseFloor) changed += 1;
  }
  return changed / n;
}

/**
 * Splits a raw grayscale byte stream into frames and diffs each against
 * the one before it. Holds two frames, whatever the recording length.
 */
export class ActivityAccumulator {
  private readonly frameBytes: number;
  private pending: Buffer = Buffer.alloc(0);
  private prev: Uint8Array | null = null;
  readonly magnitudes: number[] = [];

  constructor(width: number, height: number) {
    this.frameBytes = width * height;
  }

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    let offset = 0;
    while (this.pending.length - offset >= this.frameBytes) {
      const frame = this.pending.subarray(offset, offset + this.frameBytes);
      offset += this.frameBytes;
      if (this.prev !== null) {
        this.magnitudes.push(encodeActivityMagnitude(frameChangeFraction(this.prev, frame)));
      }
      // Copy: `frame` is a view into a buffer the next push replaces.
      this.prev = Uint8Array.from(frame);
    }
    this.pending = offset === 0 ? this.pending : this.pending.subarray(offset);
  }
}

export type VideoActivityAnalysis = {
  track: VideoActivityTrack;
  width: number;
  height: number;
};

type ActivityFile = {
  version: number;
  sampleHz: number;
  width: number;
  height: number;
  /** base64 of one byte per sample. */
  magnitudes: string;
};

/**
 * Resolve (analyse on miss) the activity track for a video capture.
 * Throws when ffmpeg is unavailable or fails, or the source is missing.
 */
export async function ensureVideoActivity(
  record: CaptureRecord,
  video: VideoCaptureMetadata
): Promise<VideoActivityAnalysis> {
  const sampleHz = activitySampleHz(video.durationSec);
  const { width, height } = activityAnalysisSize(record.width_px, record.height_px);
  const fileName = activityFileName(sampleHz, width);
  const target = join(videoAssetDir(record.id), fileName);
  // Registered synchronously, before any await — the gate's contract.
  return runGatedCacheWrite(record.id, target, (signal) =>
    readOrAnalyse(record, { sampleHz, width, height, target }, signal)
  );
}

async function readOrAnalyse(
  record: CaptureRecord,
  spec: { sampleHz: number; width: number; height: number; target: string },
  signal: AbortSignal
): Promise<VideoActivityAnalysis> {
  const cached = await readActivityFile(spec.target);
  if (cached !== null) return cached;

  if (record.legacy_src_path === null) {
    throw new Error(`video-activity: capture ${record.id} has no source path`);
  }
  const ffmpeg = resolveFfmpegPath();
  if (ffmpeg === null) {
    throw new Error(
      "ffmpeg not found: bundled PwrSnapFFmpeg is missing and no ffmpeg was found on PATH — set PWRSNAP_FFMPEG_PATH (see docs/ffmpeg-build-reference.md)"
    );
  }
  const startMs = Date.now();
  const magnitudes = await runActivityFfmpeg(
    ffmpeg,
    buildActivityArgs({
      sourcePath: record.legacy_src_path,
      sampleHz: spec.sampleHz,
      width: spec.width,
      height: spec.height
    }),
    new ActivityAccumulator(spec.width, spec.height),
    signal
  );
  const analysis: VideoActivityAnalysis = {
    track: { sampleHz: spec.sampleHz, magnitudes },
    width: spec.width,
    height: spec.height
  };
  const file: ActivityFile = {
    version: ACTIVITY_VERSION,
    sampleHz: spec.sampleHz,
    width: spec.width,
    height: spec.height,
    magnitudes: Buffer.from(Uint8Array.from(magnitudes)).toString("base64")
  };
  await mkdir(videoAssetDir(record.id), { recursive: true });
  const tmp = `${spec.target}.${String(process.pid)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(file));
    // Last check before the file becomes visible: a cleanup that removed
    // this directory while ffmpeg ran must not have it recreated.
    signal.throwIfAborted();
    await rename(tmp, spec.target);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  log.info("video activity analysed", {
    captureId: record.id,
    samples: magnitudes.length,
    sampleHz: spec.sampleHz,
    analysisMs: Date.now() - startMs
  });
  return analysis;
}

async function readActivityFile(path: string): Promise<VideoActivityAnalysis | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ActivityFile>;
    if (
      parsed.version !== ACTIVITY_VERSION ||
      typeof parsed.sampleHz !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number" ||
      typeof parsed.magnitudes !== "string"
    ) {
      return null;
    }
    return {
      track: {
        sampleHz: parsed.sampleHz,
        magnitudes: Array.from(Buffer.from(parsed.magnitudes, "base64"))
      },
      width: parsed.width,
      height: parsed.height
    };
  } catch {
    // A truncated or foreign file re-analyses rather than failing.
    return null;
  }
}

function runActivityFfmpeg(
  ffmpeg: string,
  args: string[],
  accumulator: ActivityAccumulator,
  signal: AbortSignal
): Promise<number[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (cause === undefined) resolve(accumulator.magnitudes);
      else reject(cause);
    };
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!settled) accumulator.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.once("error", (cause) => settle(cause));
    child.once("close", (code) => {
      if (signal.aborted) settle(signal.reason ?? new DOMException("aborted", "AbortError"));
      else if (code === 0) settle();
      else settle(new Error(`ffmpeg exited ${String(code)}: ${stderr.slice(-1500)}`));
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
