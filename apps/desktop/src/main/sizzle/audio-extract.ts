import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { app } from "electron";
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
export const AUDIO_PIPELINE_VERSION = "mixed-audio-v2";

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
async function publishMedia(outPath: string, args: string[]): Promise<string> {
  await mkdir(dirname(outPath), { recursive: true });
  const stagingPath = `${outPath}.${process.pid}.${randomUUID()}.partial${extname(outPath)}`;
  try {
    await runAudioFfmpeg(["-y", "-loglevel", "error", ...args, stagingPath]);
    if (!(await fileExists(stagingPath))) {
      throw new AudioExtractError("ffmpeg_failed", "ffmpeg produced empty or invalid media");
    }
    try {
      await rename(stagingPath, outPath);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // A second app process may have published the same complete artifact.
      // Windows refuses replacing it; keep that winner instead of removing it.
      if ((code !== "EEXIST" && code !== "EPERM") || !(await fileExists(outPath))) throw cause;
    }
    return outPath;
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined);
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
    .update(`${Number(args.hasSystemAudio)}:${Number(args.hasMicrophoneAudio)}`)
    .update("\0")
    .update(
      `${Number(args.requestedSystemAudio === true)}:${Number(args.requestedMicrophone === true)}`
    );
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

async function fingerprint(args: RecordingAudioSource): Promise<SourceFingerprint> {
  // Never reuse a cached derivative when its original is no longer readable.
  // Classify the failure: both callers branch on `AudioExtractError`, and a
  // raw ENOENT from here fell through to their `kind: "unknown"` arm.
  try {
    const info = await stat(args.videoPath);
    return { ...args, mtimeMs: info.mtimeMs, size: info.size };
  } catch (cause) {
    throw new AudioExtractError(
      "ffmpeg_failed",
      "The recording file could not be read",
      cause instanceof Error ? cause.message : String(cause)
    );
  }
}

/** Extract selected native audio as ONE AAC stream, mixed when both exist. */
export async function extractVideoAudio(args: RecordingAudioSource & AudioTrim): Promise<string> {
  const source = await fingerprint(args);
  const hash = computeNativeAudioCacheKey({ ...source, startSec: args.startSec, durationSec: args.durationSec });
  const outPath = join(app.getPath("userData"), "sizzle-cache", "native-audio", `${hash}.m4a`);
  return coalesce(outPath, async () => {
    if (await fileExists(outPath)) return outPath;
    // First pass decides only whether anything is worth probing for; the
    // second resolves the indices against the file's real track count.
    const wanted = selectedRecordingAudioStreams(args);
    const available = wanted.length === 0 ? 0 : await probeAudioStreamCount(args.videoPath);
    const streams = selectedRecordingAudioStreams(args, undefined, available).filter(
      (index) => index < available
    );
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
 * Whether a player needs a prepared rendition to hear this recording.
 *
 * `<video>` — and most players — play the FIRST audio track and ignore the
 * rest. So the original file is fine in exactly two cases: the audible audio
 * already IS track 0, or there is no audible audio at all. Everything else
 * needs a rendition, and that covers two distinct shapes:
 *
 *   both sources audible  → they must be MIXED, or one is lost
 *   only track 1 audible  → it must be SELECTED, or the player takes the
 *                           silent track 0 and the recording seems mute
 *
 * That second shape is the common one — system audio armed with nothing
 * playing through it, so a silent track sits in front of a good microphone.
 */
export function videoPlaybackNeedsPreparation(
  source: Pick<
    RecordingAudioSource,
    "hasSystemAudio" | "hasMicrophoneAudio" | "requestedSystemAudio" | "requestedMicrophone"
  >,
  availableTracks?: number
): boolean {
  // Drop indices the file does not actually have BEFORE deciding. Metadata
  // claiming two sources over a single-track file resolves to "track 0 is
  // all there is", which needs no rendition — deciding first and filtering
  // afterwards would remux a file in order to produce what it already was.
  const streams = selectedRecordingAudioStreams(source, undefined, availableTracks).filter(
    (index) => availableTracks === undefined || index < availableTracks
  );
  if (streams.length === 0) return false;
  return !(streams.length === 1 && streams[0] === 0);
}

/**
 * Playback-only derivative: video packets are copied without re-encoding,
 * while the audible tracks become one AAC track.
 *
 * Written to `outPath` so the caller owns where it lives — the per-capture
 * asset dir, which `purgeCacheForCapture` already sweeps. It holds a full
 * copy of the video bytes (stream-copied, not re-encoded), which is the
 * standing cost of keeping the recorded stems separate: the original must
 * stay untouched so exports can still select either source.
 *
 * Returns the path to play — `outPath` when a rendition was needed, or the
 * original when it was not.
 */
export async function prepareVideoPlayback(
  outPath: string,
  args: RecordingAudioSource
): Promise<string> {
  if (!videoPlaybackNeedsPreparation(args)) return args.videoPath;
  return coalesce(outPath, async () => {
    if (await fileExists(outPath)) return outPath;
    const available = await probeAudioStreamCount(args.videoPath);
    // Re-ask against the real track count. Metadata that disagrees with the
    // file can flip the answer back to "nothing to do".
    if (!videoPlaybackNeedsPreparation(args, available)) return args.videoPath;
    const streams = selectedRecordingAudioStreams(args, undefined, available).filter(
      (index) => index < available
    );
    return publishMedia(outPath, [
      "-i", args.videoPath, "-map", "0:v:0", "-c:v", "copy",
      ...buildRecordingAudioArgs(streams),
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"
    ]);
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
