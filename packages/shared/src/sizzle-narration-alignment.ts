import { z } from "zod";
import type { SizzleSpeechTiming } from "./protocol";
import { resolvePhraseTiming } from "./sizzle-phrase-match";
import {
  SizzleTimelineSchema,
  type SizzleTimeline,
  type SizzleTimelineLayer,
} from "./sizzle-timeline";

export const SizzleNarrationCueSchema = z
  .object({
    sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    phrase: z.string().min(1).max(500),
    occurrence: z.number().int().min(1).max(1000).default(1),
    edge: z.enum(["start", "end"]).default("start"),
    offsetSec: z.number().min(-10).max(10).default(0),
  })
  .strict();
export const SizzleNarrationCuesSchema = z
  .array(SizzleNarrationCueSchema)
  .min(1)
  .max(99);
export type SizzleNarrationCueInput = z.input<typeof SizzleNarrationCueSchema>;

/** Resolve pictures from the same phrase matcher as sequence scenes. Audio
 * remains one untrimmed take; a picture boundary never becomes an audio cut.
 * The returned ordinary timeline is saved, so preview, frame review and export
 * all use the same measured boundaries, without another transcription. */
export function alignSizzleTimelineNarration(
  timeline: SizzleTimeline,
  timing: SizzleSpeechTiming,
  cueInput: readonly SizzleNarrationCueInput[],
  tailFrames = 15,
): SizzleTimeline {
  const cues = SizzleNarrationCuesSchema.parse(cueInput);
  const voices = timeline.audio.filter((track) => track.role === "voice");
  const voice = voices[0];
  if (
    voices.length !== 1 ||
    !voice ||
    voice.startFrame !== 0 ||
    voice.source.kind === "synth" ||
    (voice.source.kind === "asset" && voice.source.trimStartSec !== 0)
  )
    throw new Error(
      "Narration alignment requires one complete voice track starting at zero",
    );
  if (
    timing.quality !== "precise" ||
    !Number.isFinite(timing.durationSec) ||
    timing.durationSec <= 0
  )
    throw new Error("Narration alignment requires measured word timestamps");
  if (!Number.isInteger(tailFrames) || tailFrames < 0 || tailFrames > 300)
    throw new Error("Narration end padding must be 0–300 frames");
  if (
    cues.length !== timeline.scenes.length - 1 ||
    new Set(cues.map((cue) => cue.sceneId)).size !== cues.length ||
    timeline.scenes
      .slice(1)
      .some((scene) => !cues.some((cue) => cue.sceneId === scene.id))
  )
    throw new Error(
      "Narration cues must name every scene after the first exactly once",
    );
  const total = Math.ceil(timing.durationSec * timeline.fps) + tailFrames;
  const starts = [
    0,
    ...timeline.scenes.slice(1).map((scene) => {
      const cue = cues.find((candidate) => candidate.sceneId === scene.id)!;
      const phrase = resolvePhraseTiming(timing, {
        phrase: cue.phrase,
        occurrence: cue.occurrence,
      });
      if (!phrase)
        throw new Error(
          `Narration phrase not found for scene ${scene.id}: ${JSON.stringify(cue.phrase)}; measured words: ${timing.words
            .map((word) => word.word)
            .join(" ")
            .slice(0, 450)}`,
        );
      return Math.round(
        ((cue.edge === "end" ? phrase.endSec : phrase.startSec) +
          cue.offsetSec) *
          timeline.fps,
      );
    }),
    total,
  ];
  if (
    total > 36_000 ||
    starts.some((start, i) => i > 0 && start <= starts[i - 1]!)
  )
    throw new Error(
      "Narration cues must follow scene order within the measured narration",
    );
  const oldStarts = [0];
  for (const scene of timeline.scenes)
    oldStarts.push(oldStarts.at(-1)! + scene.durationFrames);
  const mapFrame = (frame: number): number => {
    const index = Math.max(
      0,
      oldStarts.findIndex((end, i) => i > 0 && end >= frame) - 1,
    );
    return Math.round(
      starts[index]! +
        ((frame - oldStarts[index]!) /
          (oldStarts[index + 1]! - oldStarts[index]!)) *
          (starts[index + 1]! - starts[index]!),
    );
  };
  return SizzleTimelineSchema.parse({
    ...timeline,
    scenes: timeline.scenes.map((scene, i) => {
      const durationFrames = starts[i + 1]! - starts[i]!;
      const scale = (frame: number): number =>
        Math.round((frame * durationFrames) / scene.durationFrames);
      const layers = scene.layers.map((layer): SizzleTimelineLayer => {
        const startFrame = Math.min(
          durationFrames - 1,
          scale(layer.startFrame),
        );
        return {
          ...layer,
          startFrame,
          ...(layer.endFrame === undefined
            ? {}
            : {
                endFrame: Math.max(
                  startFrame + 1,
                  Math.min(durationFrames, scale(layer.endFrame)),
                ),
              }),
          ...(layer.motion
            ? {
                motion: {
                  ...layer.motion,
                  startFrame: Math.min(
                    durationFrames - 1,
                    scale(layer.motion.startFrame),
                  ),
                  endFrame: Math.max(
                    Math.min(
                      durationFrames - 1,
                      scale(layer.motion.startFrame),
                    ) + 1,
                    scale(layer.motion.endFrame),
                  ),
                },
              }
            : {}),
          ...(layer.kind === "counter"
            ? { countFrames: scale(layer.countFrames) }
            : {}),
          ...(layer.kind === "typing"
            ? { revealFrames: scale(layer.revealFrames) }
            : {}),
          ...(layer.kind === "terminal"
            ? {
                lineDelayFrames: scale(layer.lineDelayFrames),
                revealFrames: scale(layer.revealFrames),
              }
            : {}),
        };
      });
      return { ...scene, durationFrames, layers };
    }),
    audio: timeline.audio.map((track) => {
      if (track.id === voice.id)
        return {
          ...track,
          startFrame: 0,
          durationFrames: total,
          fit: "strict",
          trimSilence: false,
          fadeInFrames: 0,
          fadeOutFrames: 0,
        };
      const startFrame = mapFrame(track.startFrame);
      return {
        ...track,
        startFrame,
        durationFrames: Math.max(
          1,
          mapFrame(track.startFrame + track.durationFrames) - startFrame,
        ),
        ...(track.source.kind === "synth"
          ? {
              source: {
                ...track.source,
                dropFrame:
                  mapFrame(track.startFrame + track.source.dropFrame) -
                  startFrame,
                ...(track.source.finalHitFrame === undefined
                  ? {}
                  : {
                      finalHitFrame:
                        mapFrame(
                          track.startFrame + track.source.finalHitFrame,
                        ) - startFrame,
                    }),
              },
            }
          : {}),
      };
    }),
  });
}
