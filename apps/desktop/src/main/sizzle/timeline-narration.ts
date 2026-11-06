import {
  alignSizzleTimelineNarration,
  type SizzleAsset,
  type SizzleNarrationCueInput,
  type SizzleSpeechTiming,
  type SizzleTimeline,
} from "@pwrsnap/shared";
import { probeTimelineMedia } from "./timeline-process";
import { resolveSpeechTiming } from "./speech-timing";
import {
  resolveTimelineNarrationSource,
  timelinePronunciationAliases,
  timelineTranscriptMatches,
} from "./timeline-audio";

export async function alignTimelineNarration(args: {
  timeline: SizzleTimeline;
  assets: SizzleAsset[];
  assetsRoot: string;
  cacheRoot: string;
  ffmpeg: string;
  apiKey: string | null;
  cues: SizzleNarrationCueInput[];
  tailFrames: number;
  signal?: AbortSignal;
}): Promise<{ timeline: SizzleTimeline; timing: SizzleSpeechTiming }> {
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
  const source = await resolveTimelineNarrationSource(args);
  const durationSec = (
    await probeTimelineMedia(args.ffmpeg, source.path, args.signal)
  ).durationSec;
  if (durationSec <= 0 || durationSec > 600)
    throw new Error(
      "Narration alignment requires a measurable take of at most 10 minutes",
    );
  const speech =
    source.track.source.kind === "speech" ? source.track.source : null;
  const timing = await resolveSpeechTiming({
    provider: "openai",
    model: "gpt-4o-mini-tts",
    voice: speech?.voice ?? "ash",
    text: source.text,
    audioPath: source.path,
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
