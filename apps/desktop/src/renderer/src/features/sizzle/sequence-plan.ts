// Pure sequence-scene model helpers shared by the editor's preview
// plumbing (useSequencePlan), the preview stage, and — next — the
// timeline. Cache keys, the idle (pre-preview) beat placement, and the
// per-beat video playback state. No React.

import {
  distributeSequenceBeatStarts,
  estimateSequenceTimelineDurationSec,
  normalizeSizzleSequenceBeatContinuity,
  resolveSizzleVideoFit,
  sizzleMediaSourceTimeSec,
  sizzleMediaSpans,
  sizzleMediaSpansDurationSec,
  sizzleUsesCaptureCuts,
  type CaptureRecord,
  type SizzleProject,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleSequencePreviewBeat,
  type SizzleSequencePreviewPlan,
  type SizzleSequenceTranscriptPhrase,
  type VideoRange
} from "@pwrsnap/shared";
import { clampTime } from "./sizzle-helpers";

export function fallbackSequenceBeats(scene: SizzleScene): SizzleSequencePreviewBeat[] {
  const beats = normalizeSizzleSequenceBeatContinuity(scene.beats ?? []);
  // Same narration-based estimate the Render button shows, so the strip
  // and the button never claim different lengths for one scene. The old
  // one-second-per-beat placement also clamped `offset` anchors past the
  // clip count down onto a 3s timeline.
  const durationSec = estimateSequenceTimelineDurationSec(scene);
  // Idle (pre-preview) placement: no speech timing here, so only `offset`
  // beats are anchors; `phrase` and `auto` are placed by the SAME shared
  // even-division distributor the main planner uses, so the editor strip and
  // the resolved preview/render never diverge.
  const anchors = beats.map((beat): number | null =>
    beat.timing.kind === "offset" ? clampTime(beat.timing.startSec, durationSec) : null
  );
  const starts = distributeSequenceBeatStarts(anchors, durationSec);
  return beats.map((beat, index) => {
    const startSec = starts[index] ?? 0;
    const configuredEnd =
      beat.timing.kind === "offset" && beat.timing.endSec !== null
        ? beat.timing.endSec
        : null;
    const endSec = configuredEnd ?? starts[index + 1] ?? durationSec;
    return {
      beatId: beat.id,
      captureId: beat.captureId,
      startSec,
      endSec: Math.min(durationSec, Math.max(startSec + 0.1, clampTime(endSec, durationSec))),
      timing: beat.timing,
      transition: index === 0 ? scene.transition : beat.transition,
      videoFit: beat.videoFit
    };
  });
}

export function sequencePreviewPlanKey(scene: SizzleScene): string {
  return JSON.stringify({
    scriptLine: scene.scriptLine,
    durationOverrideSec: scene.durationOverrideSec,
    transition: scene.transition,
    beats: normalizeSizzleSequenceBeatContinuity(scene.beats ?? []).map((beat) => ({
      id: beat.id,
      captureId: beat.captureId,
      timing: beat.timing,
      mediaTrim: beat.mediaTrim,
      transition: beat.transition,
      videoFit: beat.videoFit,
      // Only the opt-out changes the plan; leaving the default out keeps
      // every existing key what it was.
      ...(sizzleUsesCaptureCuts(beat) ? {} : { useCaptureCuts: false })
    }))
  });
}

export function sequenceTranscriptKey(scene: SizzleScene): string {
  return JSON.stringify({
    scriptLine: scene.scriptLine
  });
}

/** Cache key for a scene's MEASURED voiceover duration. Narration length
 *  is a function of the script text AND the synthesis settings, so
 *  rewriting the script or switching voice / model / provider invalidates
 *  the measurement. Without this the Render button would keep reporting
 *  the old length — and report it as exact, which is precisely the
 *  confidently-wrong number the `~` prefix exists to avoid. Mirrors the
 *  tuple `cacheAttemptKey` uses for the on-open narration fetch. */
export function sceneVoiceoverKey(
  scene: SizzleScene,
  tts: Pick<SizzleProject, "ttsProvider" | "ttsModel" | "voice">
): string {
  return `${tts.ttsProvider}:${tts.ttsModel}:${tts.voice}:${scene.scriptLine}`;
}

export type CachedSequencePreviewPlan = {
  key: string;
  transcriptKey: string;
  plan: SizzleSequencePreviewPlan;
};

export type SequencePreviewVideoState = {
  beatId: string;
  sourceTimeSec: number;
  playbackRate: number;
  shouldPlay: boolean;
  /** True when the clip skips Library cuts, so a video element playing
   *  straight through the source has to be re-seeked at each one. */
  hasCuts: boolean;
  /** The source spans the clip plays (one span when uncut). */
  spans: VideoRange[];
};

export type CachedSequenceTranscriptPhrases = {
  key: string;
  phrases: SizzleSequenceTranscriptPhrase[];
};

/** Bar count for the idle (pre-preview) waveform placeholder. */
export const SEQUENCE_WAVE_BARS = 52;

/** How many cached narration audios to fetch+decode at once when
 *  populating sequence waveforms in the background on reel open. Bounds
 *  the burst of IPC payloads + wavesurfer decodes so a many-scene reel
 *  doesn't jank the editor on load. */
export const WAVEFORM_LOAD_CONCURRENCY = 3;

export function sequencePreviewVideoState(args: {
  beat: SizzleSequencePreviewBeat;
  sceneBeat: SizzleSequenceBeat;
  capture: CaptureRecord;
  timelineTimeSec: number;
}): SequencePreviewVideoState | null {
  const { beat, sceneBeat, capture, timelineTimeSec } = args;
  if (capture.kind !== "video" || capture.video === undefined || capture.video === null) {
    return null;
  }
  const trim = beat.mediaTrim ?? sceneBeat.mediaTrim ?? {
    startSec: capture.video.defaultRange.start,
    endSec: capture.video.defaultRange.end
  };
  // The same spans the export plays: the trim minus the capture's Library
  // cuts, read live from the record so a cut made while the reel is open
  // shows up on the next frame.
  const spans = sizzleMediaSpans({
    trim,
    segments: capture.video.segments,
    useCaptureCuts: sizzleUsesCaptureCuts(sceneBeat)
  });
  const sourceDurationSec = Math.max(0.05, sizzleMediaSpansDurationSec(spans));
  const targetDurationSec = Math.max(0.05, beat.endSec - beat.startSec);
  // A resolved plan's fit is only good for the footage it was planned
  // against; one made before the capture was (re)cut is re-derived here.
  const planned = beat.fit ?? null;
  const fit =
    planned !== null &&
    (planned.sourceDurationSec === undefined ||
      Math.abs(planned.sourceDurationSec - sourceDurationSec) < 0.01)
      ? planned
      : resolveSizzleVideoFit({
          policy: sceneBeat.videoFit,
          sourceDurationSec,
          targetDurationSec
        });
  const elapsedSec = Math.max(0, timelineTimeSec - beat.startSec);
  const inputDurationSec = Math.max(0.05, fit.inputDurationSec);
  let sourceOffsetSec: number;

  if (fit.renderMode === "speed-to-fit") {
    sourceOffsetSec = Math.min(inputDurationSec, elapsedSec * fit.playbackRate);
  } else if (fit.renderMode === "loop") {
    sourceOffsetSec = elapsedSec % inputDurationSec;
  } else if (fit.renderMode === "ping-pong") {
    const pairDurationSec = inputDurationSec * 2;
    const phaseSec = elapsedSec % pairDurationSec;
    sourceOffsetSec =
      phaseSec <= inputDurationSec ? phaseSec : pairDurationSec - phaseSec;
  } else {
    sourceOffsetSec = Math.min(inputDurationSec, elapsedSec);
  }

  return {
    beatId: beat.beatId,
    sourceTimeSec: sizzleMediaSourceTimeSec(spans, sourceOffsetSec),
    playbackRate: fit.playbackRate,
    shouldPlay: !(fit.renderMode === "freeze-end" && elapsedSec >= inputDurationSec),
    hasCuts: spans.length > 1,
    spans
  };
}

/** How close to the end of its span the head may be while the element
 *  has already jumped the cut ahead of it. */
const CUT_LEAD_SEC = 0.25;

/**
 * Where a video element playing a cut clip should be sent, or `null` to
 * leave it playing. Seeks only at span boundaries — within a kept span
 * the element is left to play on its own clock, exactly as an uncut clip
 * is, so ordinary drift between it and the head never turns into a
 * stream of seeks.
 *
 *   • The element ran into a cut → jump to the next kept span.
 *   • The element is in a different span than the head → go where the
 *     head says (it crossed a cut first, or the reel looped) — unless
 *     the element is simply one cut AHEAD of a head about to follow it.
 */
export function cutFollowSeekSec(
  spans: readonly VideoRange[],
  expectedSec: number,
  elementSec: number
): number | null {
  const expected = spanIndexAt(spans, expectedSec);
  if (expected === -1) return null;
  const at = spanIndexAt(spans, elementSec);
  if (at === -1) {
    const next = spans.findIndex((span) => elementSec < span.start);
    return next === -1 ? null : spans[next]!.start;
  }
  if (at === expected) return null;
  if (at === expected + 1 && spans[expected]!.end - expectedSec < CUT_LEAD_SEC) return null;
  return expectedSec;
}

/** Index of the span holding `sec` (its end counts, for the last span's
 *  final instant); -1 in a cut or outside the clip. */
function spanIndexAt(spans: readonly VideoRange[], sec: number): number {
  const EPS = 0.001;
  return spans.findIndex((span, i) =>
    sec >= span.start - EPS && (sec < span.end || (i === spans.length - 1 && sec <= span.end + EPS))
  );
}
