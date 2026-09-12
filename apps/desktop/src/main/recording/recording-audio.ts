import { spawn } from "node:child_process";
import type { VideoExportAudio } from "@pwrsnap/shared";
import { resolveFfmpegPath } from "./ffmpeg-resolver";

/**
 * Version token for the recorded-audio mix produced by
 * `buildRecordingAudioArgs`. Every artifact derived from that mix — the
 * waveform asset, the prepared playback rendition, the MP4 export cache —
 * carries it, so one bump invalidates all of them together.
 *
 * It lives HERE, next to the function whose output it describes, rather
 * than beside any one consumer. When each consumer spelled its own token
 * they drifted: the export cache still said `mixed-audio-v1` after the
 * mix moved to v2, so a bump would have re-derived the other two assets
 * while `lookupExport` quietly kept serving the old mixing.
 */
export const AUDIO_PIPELINE_VERSION = "mixed-audio-v2";

export type RecordingAudioSource = {
  videoPath: string;
  /** Samples actually landed for the source. Decides whether to USE a track. */
  hasSystemAudio: boolean;
  hasMicrophoneAudio: boolean;
  /**
   * A writer input was ADDED for the source. Decides which INDEX a track has.
   *
   * Optional because recordings written before migration 0033 have no such
   * column; for those, `hasX` is the only evidence a track exists and is used
   * as the fallback (see `selectedRecordingAudioStreams`).
   */
  requestedSystemAudio?: boolean | undefined;
  requestedMicrophone?: boolean | undefined;
};

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

/** Shared process runner for audio probing, extraction and playback preparation. */
export function runAudioFfmpeg(
  args: string[],
  options: { signal?: AbortSignal | undefined; onStderr?: (chunk: string) => void } = {}
): Promise<void> {
  options.signal?.throwIfAborted();
  const bin = resolveFfmpegPath();
  if (bin === null) {
    return Promise.reject(new AudioExtractError(
      "ffmpeg_missing",
      "ffmpeg not found: bundled PwrSnapFFmpeg is missing and no ffmpeg was found on PATH"
    ));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ["-nostdin", "-hide_banner", ...args], {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let tail = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (cause?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (cause === undefined) resolve();
      else reject(cause);
    };
    const onAbort = (): void => {
      try {
        proc.kill("SIGKILL");
        // Retain the export slot until close, with the same bounded fallback
        // as the exporter if a child fails to deliver that event.
        killTimer = setTimeout(() => finish(options.signal?.reason), 5_000);
      } catch {
        finish(options.signal?.reason);
      }
    };
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      tail = (tail + text).slice(-4096);
      options.onStderr?.(text);
    });
    proc.once("error", (cause) => finish(options.signal?.aborted ? options.signal.reason : cause));
    proc.once("close", (code) => {
      if (options.signal?.aborted) finish(options.signal.reason);
      else if (code === 0) finish();
      else finish(new AudioExtractError("ffmpeg_failed", `ffmpeg exited with code ${code}`, tail));
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

/**
 * The shipped binary has no ffprobe. Inspect ffmpeg's input stream headers
 * with a zero-duration stream copy: no full decode, no hardware encoder.
 * Ignore output headers (which repeat stream numbers) and parse incrementally
 * so large input metadata cannot push the stream list out of a stderr tail.
 */
export async function probeAudioStreamCount(videoPath: string, signal?: AbortSignal): Promise<number> {
  const streams = new Set<string>();
  let pending = "";
  let inputFinished = false;
  await runAudioFfmpeg([
    "-loglevel", "info", "-i", videoPath,
    "-map", "0:v:0?", "-map", "0:a?", "-c", "copy", "-t", "0", "-f", "null", "-"
  ], {
    signal,
    onStderr: (chunk) => {
      if (inputFinished) return;
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (/^(?:Output #|Stream mapping:)/.test(line)) {
          inputFinished = true;
          break;
        }
        const match = /^\s*Stream #0:(\d+)(?:\[[^\]]+\])?(?:\([^)]*\))?: Audio:/.exec(line);
        if (match !== null) streams.add(match[1]!);
      }
      pending = pending.slice(-4096);
    }
  });
  return streams.size;
}

/**
 * Recorder order is system first, mic second; mic-only uses audio index 0.
 *
 * Track POSITION and track USE are two different questions and must be read
 * from two different facts. The recorder adds a writer input when a source is
 * ARMED (main.swift `writer.add(ai)` / `writer.add(mi)`), so that is what
 * decides the index; `hasX` only records whether samples later landed, and a
 * source that was armed and stayed silent still occupies its slot. Reading the
 * index off `hasX` shifted the microphone to 0 whenever system audio was armed
 * but quiet, so the export mapped the empty system track and dropped the voice.
 *
 * `requestedX` is absent on recordings older than migration 0033; there `hasX`
 * is the only evidence a track exists, which is exactly the pre-0033 behavior.
 */
export function selectedRecordingAudioStreams(
  source: Pick<
    RecordingAudioSource,
    "hasSystemAudio" | "hasMicrophoneAudio" | "requestedSystemAudio" | "requestedMicrophone"
  >,
  audio: VideoExportAudio = { includeSystemAudio: true, includeMicrophone: true },
  availableTracks?: number
): number[] {
  const systemArmed = source.requestedSystemAudio === true || source.hasSystemAudio;
  const micArmed = source.requestedMicrophone === true || source.hasMicrophoneAudio;
  const claimedTracks = (systemArmed ? 1 : 0) + (micArmed ? 1 : 0);
  // Stale metadata: the file holds fewer audio tracks than the arm record
  // claims, so the recorder that wrote it did not add an input per armed
  // source (a pre-0033 recording, or one whose setup failed after the flag
  // was persisted). Position by which source actually carried samples
  // instead — the pre-0033 rule, and the only evidence left. Out-of-range
  // indices are still dropped by the caller's `index < available` filter;
  // this decides the index BEFORE that, so a stale claim relocates the
  // microphone rather than deleting it.
  const trustArmedLayout = availableTracks === undefined || availableTracks >= claimedTracks;
  const systemOccupiesFirstSlot = trustArmedLayout ? systemArmed : source.hasSystemAudio;
  const streams: number[] = [];
  if (source.hasSystemAudio && audio.includeSystemAudio) streams.push(0);
  if (source.hasMicrophoneAudio && audio.includeMicrophone) {
    streams.push(systemOccupiesFirstSlot ? 1 : 0);
  }
  return streams;
}

/**
 * One AAC stream for ordinary players. Multiple filter inputs MUST be probed
 * first: unlike -map, filter labels cannot be optional. A single map remains
 * optional for old recordings whose metadata promised a mic with no samples.
 */
export function buildRecordingAudioArgs(streams: readonly number[]): string[] {
  if (streams.length === 0) return ["-an"];
  if (streams.length === 1) return ["-map", `0:a:${streams[0]}?`];
  // Preserve delayed starts and gaps against the video's zero-based clock.
  // `longest` retains the full voice/system tail when one stream ends first.
  //
  // `normalize=0` is load-bearing. amix's default divides every input by the
  // input count, so a two-source mix came out exactly 6 dB quieter than the
  // single-`-map` path — measured -27.1 dB against -21.1 dB for the same
  // content with a silent second track. That made loudness a function of how
  // many sources were ARMED rather than of what was captured: arming a mic and
  // never speaking halved the system audio. It also stepped: with
  // `duration=longest`, amix renormalizes the instant the shorter input ends,
  // a measured +6.1 dB jump mid-file. Summing without normalization matches
  // what every single-source export already does.
  const inputs = streams.map((index, i) =>
    `[0:a:${index}]aresample=async=1:first_pts=0[recorded_audio_${i}]`
  );
  const labels = streams.map((_, i) => `[recorded_audio_${i}]`).join("");
  return [
    "-filter_complex",
    [...inputs, `${labels}amix=inputs=${streams.length}:duration=longest:dropout_transition=0:normalize=0[recorded_audio]`].join(";"),
    "-map", "[recorded_audio]"
  ];
}
