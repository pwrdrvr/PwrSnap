// The sequence-scene timeline planner: narration timing + beats → one
// window per beat on the scene's axis.
//
// Shared between the main-process render/preview path and the renderer's
// timeline so the editor draws the SAME windows the export will cut. It
// is pure (no captures, no I/O); the media half of planning (video trim +
// fit per beat) stays in main, where the capture records live.

import type {
  SizzleScene,
  SizzleSequenceBeat,
  SizzleSequencePreviewBeat,
  SizzleSpeechTiming
} from "./protocol";
import {
  distributeSequenceBeatStarts,
  normalizeSizzleSequenceBeatContinuity
} from "./protocol";
import { resolvePhraseTiming } from "./sizzle-phrase-match";

/** Even-division slice shorter than this (seconds) earns a "too fast to
 *  read" warning (R10; confirmed 2026-05-31). */
export const SIZZLE_SHORT_SLICE_SEC = 0.4;

export type SequencePlannerDiagnostic = {
  beatId: string;
  code: string;
  message: string;
};

export type SequenceTimelinePlan = {
  durationSec: number;
  diagnostics: SequencePlannerDiagnostic[];
  beatPlans: SizzleSequencePreviewBeat[];
};

export class SequencePlannerError extends Error {
  constructor(
    public readonly code:
      | "not_sequence"
      | "capture_missing"
      | "video_source_missing"
      | "image_missing",
    message: string
  ) {
    super(message);
    this.name = "SequencePlannerError";
  }
}

export function planSequenceTimeline(
  scene: SizzleScene,
  speechTiming: SizzleSpeechTiming
): SequenceTimelinePlan {
  if (scene.kind !== "sequence" || scene.beats === undefined || scene.beats.length === 0) {
    throw new SequencePlannerError("not_sequence", "Scene is not a sequence scene");
  }
  const diagnostics: SequencePlannerDiagnostic[] = [];
  const overrideDurationSec =
    scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
      ? scene.durationOverrideSec
      : 0;
  const timelineDurationSec = Math.max(overrideDurationSec, speechTiming.durationSec);
  if (overrideDurationSec > 0 && overrideDurationSec < speechTiming.durationSec) {
    diagnostics.push({
      beatId: scene.beats[0]!.id,
      code: "duration_override_short",
      message: `Duration override was shorter than the ${roundSec(speechTiming.durationSec)}s narration; using the narration length`
    });
  }
  const durationSec = roundSec(Math.max(0.1, timelineDurationSec));
  const beats = normalizeSizzleSequenceBeatContinuity(scene.beats);
  const windows = resolveBeatWindows(
    beats,
    speechTiming,
    durationSec,
    diagnostics
  );
  const beatPlans = beats.map((beat, index): SizzleSequencePreviewBeat => {
    const window = windows[index]!;
    return {
      beatId: beat.id,
      captureId: beat.captureId,
      startSec: window.startSec,
      endSec: window.endSec,
      timing: beat.timing,
      transition: index === 0 ? scene.transition : beat.transition,
      videoFit: beat.videoFit
    };
  });
  return { durationSec, diagnostics, beatPlans };
}

function resolveBeatWindows(
  beats: SizzleSequenceBeat[],
  speechTiming: SizzleSpeechTiming,
  timelineDurationSec: number,
  diagnostics: SequencePlannerDiagnostic[]
): Array<{ startSec: number; endSec: number }> {
  const duration = Math.max(0.1, timelineDurationSec);
  const latestStart = Math.max(0, duration - 0.1);

  // Resolve each beat to a concrete anchor time, or `null` for an `auto` beat
  // — and for a `phrase` that fails to resolve, which degrades to auto (D7).
  // The shared distributor owns the even-division of auto runs between anchors
  // and the monotonic clamp, so preview, the editor strip, and the final
  // render can never disagree.
  const anchors = beats.map((beat): number | null => {
    if (beat.timing.kind === "offset") return clamp(beat.timing.startSec, 0, latestStart);
    if (beat.timing.kind === "auto") return null;
    const resolved = resolvePhraseTiming(speechTiming, {
      phrase: beat.timing.phrase,
      occurrence: beat.timing.occurrence,
      offsetSec: beat.timing.offsetSec,
      durationSec: beat.timing.durationSec
    });
    if (resolved !== null) return clamp(resolved.startSec, 0, latestStart);
    diagnostics.push({
      beatId: beat.id,
      code: "phrase_unresolved",
      message: `Could not resolve phrase anchor ${JSON.stringify(beat.timing.phrase)} — placing it automatically`
    });
    return null; // degrade to auto
  });

  const starts = distributeSequenceBeatStarts(anchors, duration);

  return beats.map((beat, index) => {
    const startSec = starts[index]!;
    let endSec: number;
    if (beat.timing.kind === "offset" && beat.timing.endSec !== null) {
      endSec = beat.timing.endSec;
    } else if (beat.timing.kind === "phrase" && beat.timing.durationSec !== null) {
      endSec = startSec + beat.timing.durationSec;
    } else {
      endSec = starts[index + 1] ?? duration;
    }
    const clampedEnd = clamp(endSec, startSec + 0.1, duration);
    if (clampedEnd <= startSec + 0.1001) {
      diagnostics.push({
        beatId: beat.id,
        code: "beat_duration_clamped",
        message: "Beat timing was clamped to the minimum duration"
      });
    } else if (clampedEnd - startSec < SIZZLE_SHORT_SLICE_SEC) {
      diagnostics.push({
        beatId: beat.id,
        code: "beat_too_short",
        message: `Beat is only ${roundSec(clampedEnd - startSec)}s — may be too fast to read`
      });
    }
    return { startSec: roundSec(startSec), endSec: roundSec(clampedEnd) };
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
