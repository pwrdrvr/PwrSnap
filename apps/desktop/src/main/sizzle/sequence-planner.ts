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
  mediaTrimWasClamped,
  normalizeSizzleSequenceBeatContinuity,
  normalizeVideoMediaTrim,
  sizzleTransitionDurationSec,
  sizzleTransitionType
} from "@pwrsnap/shared";

import type { SceneInput } from "./composer";
import { resolveVideoFit, type VideoFitDecision } from "./video-fit";
// The timeline half of planning (narration timing + beats → windows) lives
// in @pwrsnap/shared so the renderer's timeline draws the SAME windows the
// export cuts. Re-exported so main-process importers and tests keep their
// path; the media half (trim + fit per beat, which needs capture records)
// stays here.
import {
  planSequenceTimeline,
  SequencePlannerError,
  type SequencePlannerDiagnostic,
  type SequenceTimelinePlan
} from "@pwrsnap/shared";
export { planSequenceTimeline, SequencePlannerError };
export type { SequencePlannerDiagnostic, SequenceTimelinePlan };

export type SequenceRenderPlan = {
  sceneInputs: SceneInput[];
  diagnostics: SequencePlannerDiagnostic[];
  beatPlans: SequenceRenderBeatPlan[];
};

export type SequenceRenderBeatPlan = SizzleSequencePreviewBeat & {
  fit?: VideoFitDecision | null;
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

export type SequencePreviewMediaPlan = {
  beatPlans: SizzleSequencePreviewBeat[];
  diagnostics: SequencePlannerDiagnostic[];
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
    let videoMediaPlan:
      | { trim: SizzleMediaTrim; fit: VideoFitDecision }
      | undefined;

    if (capture.kind === "video") {
      if (capture.legacy_src_path === null || capture.video === undefined || capture.video === null) {
        throw new SequencePlannerError(
          "video_source_missing",
          `Beat ${index + 1}: video capture ${beat.captureId} has no source file`
        );
      }
      const mediaPlan = planVideoBeatMedia(beat, capture, durationSec);
      const trim = mediaPlan.trim;
      const fit = mediaPlan.fit;
      videoMediaPlan = { trim, fit };
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

    const beatPlan: SequenceRenderBeatPlan = {
      beatId: window.beatId,
      captureId: window.captureId,
      startSec: window.startSec,
      endSec: window.endSec,
      timing: window.timing,
      transition: window.transition,
      videoFit: window.videoFit
    };
    if (window.mediaTrim !== undefined) beatPlan.mediaTrim = window.mediaTrim;
    if (videoMediaPlan !== undefined) {
      beatPlan.mediaTrim = videoMediaPlan.trim;
      beatPlan.fit = videoMediaPlan.fit;
    }
    beatPlans.push(beatPlan);
  });

  return { sceneInputs, diagnostics, beatPlans };
}

export function planSequenceMediaDiagnostics(
  req: SequenceMediaDiagnosticsRequest
): SequencePlannerDiagnostic[] {
  return planSequencePreviewMedia(req).diagnostics;
}

export function planSequencePreviewMedia(
  req: SequenceMediaDiagnosticsRequest
): SequencePreviewMediaPlan {
  const beats = normalizeSizzleSequenceBeatContinuity(req.scene.beats ?? []);
  const diagnostics: SequencePlannerDiagnostic[] = [];
  const beatPlans = req.timeline.beatPlans.map((beatPlan) => ({ ...beatPlan }));
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
    const mediaPlan = planVideoBeatMedia(beat, capture, durationSec);
    diagnostics.push(...mediaPlan.diagnostics);
    beatPlans[index] = {
      ...beatPlans[index]!,
      mediaTrim: mediaPlan.trim,
      fit: mediaPlan.fit
    };
  });
  return { beatPlans, diagnostics };
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

function transitionOverlapDurationSec(transition: SizzleTransition): number {
  const type = sizzleTransitionType(transition);
  if (type === "none" || type === "cut") return 0;
  return sizzleTransitionDurationSec(transition);
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
