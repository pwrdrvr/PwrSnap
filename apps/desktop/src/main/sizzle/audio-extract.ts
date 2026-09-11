import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { app } from "electron";
import { getCacheRoot } from "../persistence/paths";
import { runVideoPlaybackPreparation } from "../persistence/video-playback-cache";
import {
  AudioExtractError,
  buildRecordingAudioArgs,
  probeAudioStreamCount,
  runAudioFfmpeg,
  selectedRecordingAudioStreams,
  type RecordingAudioSource
} from "../recording/recording-audio";

export { AudioExtractError } from "../recording/recording-audio";

// Older native extractions silently selected the first audio stream. Changing
// the pipeline invalidates those artifacts without touching original captures.
const AUDIO_PIPELINE_VERSION = "mixed-audio-v1";

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

const inFlight = new Map<string, Promise<string>>();

function coalesce(key: string, work: () => Promise<string>): Promise<string> {
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const pending = work().finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

/** FFmpeg only sees a unique staging file. Readers only see complete media. */
async function publishMedia(outPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  const stagingPath = `${outPath}.${process.pid}.${randomUUID()}.partial${extname(outPath)}`;
  try {
    signal?.throwIfAborted();
    await mkdir(dirname(outPath), { recursive: true });
    signal?.throwIfAborted();
    await runAudioFfmpeg(["-y", "-loglevel", "error", ...args, stagingPath], { signal });
    signal?.throwIfAborted();
    if (!(await fileExists(stagingPath))) {
      throw new AudioExtractError("ffmpeg_failed", "ffmpeg produced empty or invalid media");
    }
    signal?.throwIfAborted();
    try {
      await rename(stagingPath, outPath);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // A second app process may have published the same complete artifact.
      // Windows refuses replacing it; keep that winner instead of removing it.
      if ((code !== "EEXIST" && code !== "EPERM") || !(await fileExists(outPath))) throw cause;
    }
    signal?.throwIfAborted();
    return outPath;
  } finally {
    await rm(stagingPath, { force: true });
  }
}

type SourceFingerprint = RecordingAudioSource & { mtimeMs: number; size: number };
type AudioTrim = { startSec: number; durationSec: number };

function sourceDigest(args: SourceFingerprint): ReturnType<typeof createHash> {
  return createHash("sha256")
    .update(AUDIO_PIPELINE_VERSION)
    .update("\0")
    .update(args.videoPath)
    .update("\0")
    .update(args.mtimeMs.toString())
    .update("\0")
    .update(args.size.toString())
    .update("\0")
    .update(`${Number(args.hasSystemAudio)}:${Number(args.hasMicrophoneAudio)}`);
}

/** Path, file revision, recorded tracks, trim and mixing version all invalidate. */
export function computeNativeAudioCacheKey(args: SourceFingerprint & AudioTrim): string {
  return sourceDigest(args)
    .update("\0native\0")
    .update(args.startSec.toFixed(3))
    .update("\0")
    .update(args.durationSec.toFixed(3))
    .digest("hex")
    .slice(0, 24);
}

export function computeVideoPlaybackCacheKey(args: SourceFingerprint): string {
  return sourceDigest(args).update("\0playback").digest("hex").slice(0, 24);
}

async function fingerprint(args: RecordingAudioSource): Promise<SourceFingerprint> {
  // Never reuse a cached derivative when its original is no longer readable.
  const info = await stat(args.videoPath);
  return { ...args, mtimeMs: info.mtimeMs, size: info.size };
}

/** Extract selected native audio as ONE AAC stream, mixed when both exist. */
export async function extractVideoAudio(args: RecordingAudioSource & AudioTrim): Promise<string> {
  const source = await fingerprint(args);
  const hash = computeNativeAudioCacheKey({ ...source, startSec: args.startSec, durationSec: args.durationSec });
  const outPath = join(app.getPath("userData"), "sizzle-cache", "native-audio", `${hash}.m4a`);
  return coalesce(outPath, async () => {
    if (await fileExists(outPath)) return outPath;
    const selected = selectedRecordingAudioStreams(args);
    const available = selected.length === 0 ? 0 : await probeAudioStreamCount(args.videoPath);
    const streams = selected.filter((index) => index < available);
    // A valid old recording can claim audio but contain no samples at all.
    // The composer still needs a duration-matched input for that scene.
    if (streams.length === 0) return synthesizeSilence(args.durationSec);
    return publishMedia(outPath, [
      "-ss", args.startSec.toFixed(3), "-t", args.durationSec.toFixed(3), "-i", args.videoPath,
      "-vn", ...buildRecordingAudioArgs(streams),
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"
    ]);
  });
}

/**
 * Playback-only derivative: video packets are copied without re-encoding,
 * while system + microphone become one AAC track. The stored recording stays
 * intact so exports can still select either source. Non-dual recordings (also
 * stale metadata with fewer than two actual streams) use the original file.
 */
export function prepareVideoPlayback(args: RecordingAudioSource & { captureId: string }): Promise<string> {
  const key = JSON.stringify([args.videoPath, args.hasSystemAudio, args.hasMicrophoneAudio]);
  return runVideoPlaybackPreparation(args.captureId, key, async (signal) => {
    if (!args.hasSystemAudio || !args.hasMicrophoneAudio) return args.videoPath;
    const source = await fingerprint(args);
    signal.throwIfAborted();
    const hash = computeVideoPlaybackCacheKey(source);
    const outPath = join(getCacheRoot(), "video", args.captureId, `playback-${hash}.mp4`);
    const cached = await fileExists(outPath);
    signal.throwIfAborted();
    if (cached) return outPath;
    const available = await probeAudioStreamCount(args.videoPath, signal);
    signal.throwIfAborted();
    if (available < 2) return args.videoPath;
    return publishMedia(outPath, [
      "-i", args.videoPath, "-map", "0:v:0", "-c:v", "copy",
      ...buildRecordingAudioArgs([0, 1]),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"
    ], signal);
  });
}

/** Duration-matched silent input for muted scenes or missing recorded audio. */
export async function synthesizeSilence(durationSec: number): Promise<string> {
  const safeDur = durationSec.toFixed(3);
  const outPath = join(app.getPath("userData"), "sizzle-cache", "silence", `silence-${safeDur}.m4a`);
  return coalesce(outPath, async () => {
    if (await fileExists(outPath)) return outPath;
    return publishMedia(outPath, [
      "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
      "-t", safeDur, "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart"
    ]);
  });
}
