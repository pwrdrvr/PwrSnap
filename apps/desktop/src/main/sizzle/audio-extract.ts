import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { app } from "electron";
import { videoPlaybackNeedsPreparation } from "@pwrsnap/shared";
import {
  AUDIO_PIPELINE_VERSION,
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
// Owned by `recording-audio`, next to the mix it versions; re-exported here
// because this module is where most consumers already reach for it.
export { AUDIO_PIPELINE_VERSION };

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

/**
 * FFmpeg only sees a unique staging file. Readers only see complete media.
 *
 * `signal` is checked around every step, not just handed to ffmpeg. The
 * publishing `rename` is the dangerous one: a cleanup that deletes this
 * capture's cache directory while ffmpeg is finishing would otherwise have
 * the rename land afterwards and recreate the tree. `runAudioFfmpeg` already
 * kills its child on abort, so the encode itself needs nothing more.
 */
async function publishMedia(
  outPath: string,
  args: string[],
  signal?: AbortSignal | undefined
): Promise<string> {
  signal?.throwIfAborted();
  await mkdir(dirname(outPath), { recursive: true });
  const stagingPath = `${outPath}.${process.pid}.${randomUUID()}.partial${extname(outPath)}`;
  try {
    await runAudioFfmpeg(["-y", "-loglevel", "error", ...args, stagingPath], { signal });
    if (!(await fileExists(stagingPath))) {
      throw new AudioExtractError("ffmpeg_failed", "ffmpeg produced empty or invalid media");
    }
    // Last check before the artifact becomes visible to readers.
    signal?.throwIfAborted();
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
    // Unconditional: an aborted run still leaves a staging file behind, and
    // it is named per-process-per-uuid so nothing else can claim it.
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

/**
 * Cache identity for the prepared playback rendition.
 *
 * Mirrors `computeNativeAudioCacheKey` deliberately: the two lanes derive
 * from the same source and must invalidate on the same facts, or they
 * disagree about one recording. #496 addressed the rendition by a name
 * carrying only `AUDIO_PIPELINE_VERSION`, so the ONLY way to invalidate it
 * was a pipeline bump — an in-place rewrite of the source, or a later
 * backfill of the `requested_*` columns, would have been served a stale
 * rendition forever while the sibling waveform re-derived itself.
 *
 * Domain-separated with a `playback` tag so a source can never collide
 * with its own native-audio key.
 *
 * Async because the revision half of the identity (mtime + size) is a
 * `stat`. Callers run the preparation predicate FIRST, so a recording that
 * needs no rendition still touches the filesystem not at all.
 */
export async function computeVideoPlaybackCacheKey(args: RecordingAudioSource): Promise<string> {
  return sourceDigest(await fingerprint(args))
    .update("\0playback\0")
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
    // Probe unconditionally. Short-circuiting the probe when the flags
    // claim no audio makes the flags unfalsifiable: `has*Audio` now means
    // "carried sound above the silence floor", so a quiet-but-real take —
    // or, before the format fix, any PCM layout we could not decode —
    // reads as no-audio, and we would render silence over a track that is
    // right there in the file. ffmpeg's own stream selection is what this
    // path used before, and it never consulted our flags at all.
    const available = await probeAudioStreamCount(args.videoPath);
    const streams = selectedRecordingAudioStreams(args, undefined, available).filter(
      (index) => index < available
    );
    // The flags say nothing is worth mixing, but the file has audio. Trust
    // the file: take its first track rather than silently replacing real
    // audio with silence.
    const resolved = streams.length === 0 && available > 0 ? [0] : streams;
    // A valid old recording can claim audio but contain no samples at all.
    // The composer still needs a duration-matched input for that scene.
    if (resolved.length === 0) return synthesizeSilence(args.durationSec);
    return publishMedia(outPath, [
      "-ss", args.startSec.toFixed(3), "-t", args.durationSec.toFixed(3), "-i", args.videoPath,
      "-vn", ...buildRecordingAudioArgs(resolved),
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"
    ]);
  });
}

/**
 * Playback-only derivative: video packets are copied without re-encoding,
 * while the audible tracks become one AAC track.
 *
 * Written to `outPath` so the caller owns where it lives — the per-capture
 * asset dir. It holds a full copy of the video bytes (stream-copied, not
 * re-encoded), which is the standing cost of keeping the recorded stems
 * separate: the original must stay untouched so exports can still select
 * either source.
 *
 * Because it is source-sized, EVERY path that retires a capture has to
 * purge that dir. `library:purge` always did; boot GC did not, and hard-
 * deleted the rows while leaving the bytes — which only became expensive
 * once this file existed. `gcHardDeleteCaptures` now purges too.
 *
 * Returns the path to play — `outPath` when a rendition was needed, or the
 * original when it was not.
 */
export async function prepareVideoPlayback(
  outPath: string,
  args: RecordingAudioSource,
  signal?: AbortSignal | undefined
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
