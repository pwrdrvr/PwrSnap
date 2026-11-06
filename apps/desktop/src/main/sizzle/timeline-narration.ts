import {
  alignSizzleTimelineNarration,
  type SizzleAsset,
  type SizzleNarrationCueInput,
  type SizzleSpeechTiming,
  type SizzleTimeline,
} from "@pwrsnap/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { probeTimelineMedia, timelineProcess } from "./timeline-process";
import { resolveSpeechTiming } from "./speech-timing";
import {
  resolveTimelineNarrationSource,
  timelinePronunciationAliases,
  timelineTranscriptMatches,
} from "./timeline-audio";

export type TimelineNarrationRequest = {
  timeline: SizzleTimeline;
  assets: SizzleAsset[];
  assetsRoot: string;
  cacheRoot: string;
  ffmpeg: string;
  apiKey: string | null;
  signal?: AbortSignal;
};

/** One complete, untrimmed audio asset for audition, reuse and word timing. */
export async function prepareTimelineNarration(
  args: TimelineNarrationRequest,
): Promise<{
  path: string;
  text: string;
  timing: SizzleSpeechTiming;
}> {
  const source = await resolveTimelineNarrationSource(args);
  const sourceDurationSec = (
    await probeTimelineMedia(args.ffmpeg, source.path, args.signal)
  ).durationSec;
  if (sourceDurationSec <= 0 || sourceDurationSec > 600)
    throw new Error(
      "Narration alignment requires a measurable take of at most 10 minutes",
    );
  // Standardize audio-only delivery without fitting or trimming. In
  // particular a long video asset is decoded to bounded narration before ASR.
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(source.path)) {
    args.signal?.throwIfAborted();
    digest.update(chunk as Buffer);
  }
  const key = digest.digest("hex");
  const path = join(args.cacheRoot, `narration-${key}.wav`);
  if (!(await stat(path).catch(() => null))?.isFile()) {
    const temporary = `${path}.${randomUUID()}.wav`;
    try {
      await timelineProcess(
        args.ffmpeg,
        [
          "-hide_banner",
          "-y",
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          source.path,
          "-t",
          "600.02",
          "-map",
          "0:a:0",
          "-vn",
          "-ar",
          "24000",
          "-ac",
          "1",
          "-c:a",
          "pcm_s16le",
          temporary,
        ],
        args.signal,
      );
      args.signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  const durationSec = (await probeTimelineMedia(args.ffmpeg, path, args.signal))
    .durationSec;
  if (durationSec <= 0 || durationSec > 600) throw new Error("Narration preparation requires a complete take of at most 10 minutes");
  const speech =
    source.track.source.kind === "speech" ? source.track.source : null;
  const timing = await resolveSpeechTiming({
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: speech?.voice ?? "ash",
    text: source.text,
    audioPath: path,
    durationSec,
    apiKey: args.apiKey,
    requirePrecise: true,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (timing.quality !== "precise")
    throw new Error(
      "Narration alignment could not obtain word timestamps; check the OpenAI credential and retry explicitly",
    );
  if (
    source.text &&
    !timelineTranscriptMatches(
      source.text,
      timing.words.map((word) => word.word).join(" "),
      timelinePronunciationAliases(source.track.source, args.timeline.bindings),
    )
  )
    throw new Error(
      "Narration QA failed during alignment; the measured take does not match the script",
    );
  return { path, text: source.text, timing };
}

export async function alignTimelineNarration(
  args: TimelineNarrationRequest & {
    cues: SizzleNarrationCueInput[];
    tailFrames: number;
  },
): Promise<{ timeline: SizzleTimeline; timing: SizzleSpeechTiming }> {
  if (
    args.cues.length !== args.timeline.scenes.length - 1 ||
    new Set(args.cues.map((cue) => cue.sceneId)).size !== args.cues.length ||
    args.timeline.scenes
      .slice(1)
      .some((scene) => !args.cues.some((cue) => cue.sceneId === scene.id))
  )
    throw new Error(
      "Narration cues must name every scene after the first exactly once",
    );
  const { timing } = await prepareTimelineNarration(args);
  return {
    timeline: alignSizzleTimelineNarration(
      args.timeline,
      timing,
      args.cues,
      args.tailFrames,
    ),
    timing,
  };
}
