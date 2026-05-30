import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { resolveFfmpegPath } from "../recording/ffmpeg-resolver";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:sizzle-audio");

export class AudioExtractError extends Error {
  constructor(
    public readonly code: "ffmpeg_missing" | "ffmpeg_failed",
    message: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = "AudioExtractError";
  }
}

function nativeCacheDir(): string {
  return join(app.getPath("userData"), "sizzle-cache", "native-audio");
}

function silenceCacheDir(): string {
  return join(app.getPath("userData"), "sizzle-cache", "silence");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  const bin = resolveFfmpegPath();
  if (bin === null) {
    return Promise.reject(
      new AudioExtractError("ffmpeg_missing", "ffmpeg binary not found")
    );
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4096);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new AudioExtractError(
          "ffmpeg_failed",
          `ffmpeg exited with code ${code}`,
          tail.slice(-1024)
        )
      );
    });
  });
}

/**
 * Extract the audio track from a video clip for the given trim range
 * into a stand-alone m4a in the sizzle cache directory. Content-
 * addressed by `(videoPath, startSec, endSec)` so repeat extractions
 * for the same trim are free.
 *
 * The output is AAC in an m4a container using ffmpeg's native AAC
 * encoder. The composer decodes every scene's audio as an input and
 * concatenates decoded PCM in the filter graph, so this no longer
 * needs a GPL/nonfree-capable mp3 encoder.
 *
 * Returns the on-disk audio path.
 */
/**
 * Compute the content-addressed cache key for a native-audio
 * extraction. Exported pure helper so the cache-key contract is
 * unit-testable without invoking ffmpeg.
 *
 * Inputs that are part of the key:
 *
 *   - `videoPath`        — different files → different keys.
 *   - `mtimeMs`          — if the file at `videoPath` is rewritten
 *     in-place (rare but possible — third-party tool, future
 *     in-place trim operation), a path-only key would silently
 *     return the stale extraction. mtime closes that gap.
 *   - `size`             — defense in depth alongside mtime: some
 *     filesystems coalesce mtime updates on rapid writes, but the
 *     file's byte length is essentially always different.
 *   - `startSec` / `durationSec` — quantized to milliseconds so a
 *     UI-driven floating-point change in the 7th decimal doesn't
 *     invalidate the cache.
 *
 * Returns the first 24 hex chars of the sha256, matching the
 * pre-mtime cache key length.
 */
export function computeNativeAudioCacheKey(args: {
  videoPath: string;
  mtimeMs: number;
  size: number;
  startSec: number;
  durationSec: number;
}): string {
  return createHash("sha256")
    .update(args.videoPath)
    .update("\0")
    .update(args.mtimeMs.toString())
    .update("\0")
    .update(args.size.toString())
    .update("\0")
    .update(args.startSec.toFixed(3))
    .update("\0")
    .update(args.durationSec.toFixed(3))
    .digest("hex")
    .slice(0, 24);
}

export async function extractVideoAudio(args: {
  videoPath: string;
  startSec: number;
  durationSec: number;
}): Promise<string> {
  const dir = nativeCacheDir();
  await mkdir(dir, { recursive: true });
  // Resolve mtime + size BEFORE hashing. If the source file went
  // missing, fail loudly here rather than letting ffmpeg fail with
  // a less-actionable "no such file" error a few lines down. The
  // catch falls back to (0, 0) — those values still produce a valid
  // cache key; the subsequent ffmpeg call will throw cleanly with
  // the source-file context preserved.
  let mtimeMs = 0;
  let size = 0;
  try {
    const s = await stat(args.videoPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    /* fall through — ffmpeg will surface the real error below */
  }
  const hash = computeNativeAudioCacheKey({
    videoPath: args.videoPath,
    mtimeMs,
    size,
    startSec: args.startSec,
    durationSec: args.durationSec
  });
  const outPath = join(dir, `${hash}.m4a`);
  if (await fileExists(outPath)) {
    log.info("native-audio cache HIT", {
      videoPath: args.videoPath,
      startSec: args.startSec,
      durationSec: args.durationSec,
      outPath
    });
    return outPath;
  }
  log.info("native-audio cache MISS — extracting", {
    videoPath: args.videoPath,
    startSec: args.startSec,
    durationSec: args.durationSec
  });
  // Native AAC keeps this path inside FFmpeg's LGPL-clean built-in
  // codec set; do not use libmp3lame/libfdk_aac here.
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    args.startSec.toFixed(3),
    "-t",
    args.durationSec.toFixed(3),
    "-i",
    args.videoPath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outPath
  ]);
  return outPath;
}

/**
 * Synthesize a silent m4a of `durationSec` length. Used for video
 * scenes with audioSource: "muted" so the audio concat list stays
 * render paths that need an audio input even when the user muted a
 * scene. The composer can concatenate this with mp3 voiceovers
 * because it works from decoded audio streams, not by stream-copying
 * a concat-demuxer list.
 *
 * Cached by duration (rounded to 3 decimal places).
 */
export async function synthesizeSilence(durationSec: number): Promise<string> {
  const dir = silenceCacheDir();
  await mkdir(dir, { recursive: true });
  const safeDur = durationSec.toFixed(3);
  const outPath = join(dir, `silence-${safeDur}.m4a`);
  if (await fileExists(outPath)) return outPath;
  // anullsrc is ffmpeg's silent-audio generator. Mono 44.1kHz is
  // enough for narration-paced content (and matches OpenAI's TTS
  // output sample rate, keeping concat-demuxer transitions clean).
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=44100",
    "-t",
    safeDur,
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    outPath
  ]);
  return outPath;
}
