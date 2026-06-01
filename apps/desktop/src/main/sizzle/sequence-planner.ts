import type {
  CaptureRecord,
  SizzleMediaTrim,
  SizzleScene,
  SizzleSequencePreviewBeat,
  SizzleSequenceBeat,
  SizzleSpeechTiming,
  SizzleTransition
} from "@pwrsnap/shared";
import {
  distributeSequenceBeatStarts,
  normalizeSizzleSequenceBeatContinuity,
  sizzleTransitionDurationSec,
  sizzleTransitionType
} from "@pwrsnap/shared";

/** Even-division slice shorter than this (seconds) earns a "too fast to
 *  read" warning (R10; confirmed 2026-05-31). */
const SHORT_SLICE_SEC = 0.4;
import type { SceneInput } from "./composer";
import { mediaTrimWasClamped, normalizeVideoMediaTrim } from "./media-trim";
import { resolvePhraseTiming } from "./speech-timing";
import { resolveVideoFit, type VideoFitDecision } from "./video-fit";

export type SequencePlannerDiagnostic = {
  beatId: string;
  code: string;
  message: string;
};

export type SequenceRenderPlan = {
  sceneInputs: SceneInput[];
  diagnostics: SequencePlannerDiagnostic[];
  beatPlans: SequenceRenderBeatPlan[];
};

export type SequenceTimelinePlan = {
  durationSec: number;
  diagnostics: SequencePlannerDiagnostic[];
  beatPlans: SizzleSequencePreviewBeat[];
};

export type SequenceRenderBeatPlan = SizzleSequencePreviewBeat & {
  fit?: VideoFitDecision;
};

export type SequencePlannerRequest = {
  scene: SizzleScene;
  capturesById: Map<string, CaptureRecord>;
  imagePathByCaptureId: Map<string, string>;
  narrationAudioPath: string;
  speechTiming: SizzleSpeechTiming;
};

export type SequenceMediaDiagnosticsRequest = {
  scene: SizzleScene;
  capturesById: Map<string, CaptureRecord>;
  timeline: SequenceTimelinePlan;
};

export function planSequenceScene(req: SequencePlannerRequest): SequenceRenderPlan {
  const timeline = planSequenceTimeline(req.scene, req.speechTiming);
  const diagnostics: SequencePlannerDiagnostic[] = [...timeline.diagnostics];
  const beats = normalizeSizzleSequenceBeatContinuity(req.scene.beats ?? []);
  const sceneInputs: SceneInput[] = [];
  const beatPlans: SequenceRenderBeatPlan[] = [];

  beats.forEach((beat, index) => {
    const capture = req.capturesById.get(beat.captureId);
    if (capture === undefined) {
      throw new SequencePlannerError(
        "capture_missing",
        `Beat ${index + 1}: capture ${beat.captureId} not found`
      );
    }
    const window = timeline.beatPlans[index]!;
    const transition: SizzleTransition = window.transition;
    const audioDurationSec = Math.max(0.1, window.endSec - window.startSec);
    const transitionOverlapSec =
      index > 0 ? transitionOverlapDurationSec(transition) : 0;
    const durationSec = audioDurationSec + transitionOverlapSec;
    let fit: VideoFitDecision | undefined;

    if (capture.kind === "video") {
      if (capture.legacy_src_path === null || capture.video === undefined || capture.video === null) {
        throw new SequencePlannerError(
          "video_source_missing",
          `Beat ${index + 1}: video capture ${beat.captureId} has no source file`
        );
      }
      const mediaPlan = planVideoBeatMedia(beat, capture, durationSec);
      const trim = mediaPlan.trim;
      fit = mediaPlan.fit;
      diagnostics.push(...mediaPlan.diagnostics);
      sceneInputs.push({
        kind: "video",
        videoPath: capture.legacy_src_path,
        startSec: trim.startSec,
        trimDurationSec: fit.inputDurationSec,
        durationSec,
        audioPath: req.narrationAudioPath,
        audioStartSec: window.startSec,
        audioDurationSec,
        transition,
        videoFit: {
          mode: fit.renderMode,
          playbackRate: fit.playbackRate
        }
      });
    } else {
      const imagePath = req.imagePathByCaptureId.get(beat.captureId);
      if (imagePath === undefined) {
        throw new SequencePlannerError(
          "image_missing",
          `Beat ${index + 1}: rendered image for ${beat.captureId} is missing`
        );
      }
      sceneInputs.push({
        kind: "image",
        imagePath,
        durationSec,
        audioPath: req.narrationAudioPath,
        audioStartSec: window.startSec,
        audioDurationSec,
        transition
      });
    }

    const beatPlan: SequenceRenderBeatPlan = { ...window };
    if (fit !== undefined) beatPlan.fit = fit;
    beatPlans.push(beatPlan);
  });

  return { sceneInputs, diagnostics, beatPlans };
}

export function planSequenceTimeline(
  scene: SizzleScene,
  speechTiming: SizzleSpeechTiming
): SequenceTimelinePlan {
  if (scene.kind !== "sequence" || scene.beats === undefined || scene.beats.length === 0) {
    throw new SequencePlannerError("not_sequence", "Scene is not a sequence scene");
  }
  const diagnostics: SequencePlannerDiagnostic[] = [];
  const timelineDurationSec =
    scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
      ? scene.durationOverrideSec
      : speechTiming.durationSec;
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

export function planSequenceMediaDiagnostics(
  req: SequenceMediaDiagnosticsRequest
): SequencePlannerDiagnostic[] {
  const beats = normalizeSizzleSequenceBeatContinuity(req.scene.beats ?? []);
  const diagnostics: SequencePlannerDiagnostic[] = [];
  beats.forEach((beat, index) => {
    const capture = req.capturesById.get(beat.captureId);
    if (capture?.kind !== "video" || capture.video === null || capture.video === undefined) return;
    const window = req.timeline.beatPlans[index];
    if (window === undefined) return;
    const transition: SizzleTransition = window.transition;
    const audioDurationSec = Math.max(0.1, window.endSec - window.startSec);
    const transitionOverlapSec =
      index > 0 ? transitionOverlapDurationSec(transition) : 0;
    const durationSec = audioDurationSec + transitionOverlapSec;
    diagnostics.push(...planVideoBeatMedia(beat, capture, durationSec).diagnostics);
  });
  return diagnostics;
}

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

function planVideoBeatMedia(
  beat: SizzleSequenceBeat,
  capture: CaptureRecord,
  targetDurationSec: number
): {
  trim: SizzleMediaTrim;
  fit: VideoFitDecision;
  diagnostics: SequencePlannerDiagnostic[];
} {
  if (capture.video === null || capture.video === undefined) {
    throw new SequencePlannerError(
      "video_source_missing",
      `Video capture ${beat.captureId} has no metadata`
    );
  }
  const diagnostics: SequencePlannerDiagnostic[] = [];
  const trim = normalizeVideoMediaTrim({
    trim: beat.mediaTrim,
    defaultRange: capture.video.defaultRange,
    sourceDurationSec: capture.video.durationSec
  });
  if (mediaTrimWasClamped(beat.mediaTrim, trim)) {
    diagnostics.push({
      beatId: beat.id,
      code: "media_trim_clamped",
      message: `Media trim was clamped to the ${roundSec(capture.video.durationSec)}s source duration`
    });
  }
  const sourceDurationSec = Math.max(0.05, trim.endSec - trim.startSec);
  const fit = resolveVideoFit({
    policy: beat.videoFit,
    sourceDurationSec,
    targetDurationSec
  });
  for (const warning of fit.warnings) {
    diagnostics.push({ beatId: beat.id, code: "video_fit", message: warning });
  }
  return { trim, fit, diagnostics };
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
    } else if (clampedEnd - startSec < SHORT_SLICE_SEC) {
      diagnostics.push({
        beatId: beat.id,
        code: "beat_too_short",
        message: `Beat is only ${roundSec(clampedEnd - startSec)}s — may be too fast to read`
      });
    }
    return { startSec: roundSec(startSec), endSec: roundSec(clampedEnd) };
  });
}

function transitionOverlapDurationSec(transition: SizzleTransition): number {
  const type = sizzleTransitionType(transition);
  if (type === "none" || type === "cut") return 0;
  return sizzleTransitionDurationSec(transition);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
