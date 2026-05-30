import type {
  CaptureRecord,
  SizzleScene,
  SizzleSequenceBeat,
  SizzleSpeechTiming,
  SizzleTransition
} from "@pwrsnap/shared";
import {
  sizzleTransitionDurationSec,
  sizzleTransitionType
} from "@pwrsnap/shared";
import type { SceneInput } from "./composer";
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
  beatPlans: Array<{
    beatId: string;
    startSec: number;
    endSec: number;
    captureId: string;
    fit?: VideoFitDecision;
  }>;
};

export type SequencePlannerRequest = {
  scene: SizzleScene;
  capturesById: Map<string, CaptureRecord>;
  imagePathByCaptureId: Map<string, string>;
  narrationAudioPath: string;
  speechTiming: SizzleSpeechTiming;
};

export function planSequenceScene(req: SequencePlannerRequest): SequenceRenderPlan {
  if (req.scene.kind !== "sequence" || req.scene.beats === undefined || req.scene.beats.length === 0) {
    throw new SequencePlannerError("not_sequence", "Scene is not a sequence scene");
  }
  const diagnostics: SequencePlannerDiagnostic[] = [];
  const timelineDurationSec =
    req.scene.durationOverrideSec !== null && req.scene.durationOverrideSec > 0
      ? req.scene.durationOverrideSec
      : req.speechTiming.durationSec;
  const windows = resolveBeatWindows(
    req.scene.beats,
    req.speechTiming,
    timelineDurationSec,
    diagnostics
  );
  const sceneInputs: SceneInput[] = [];
  const beatPlans: SequenceRenderPlan["beatPlans"] = [];

  req.scene.beats.forEach((beat, index) => {
    const capture = req.capturesById.get(beat.captureId);
    if (capture === undefined) {
      throw new SequencePlannerError(
        "capture_missing",
        `Beat ${index + 1}: capture ${beat.captureId} not found`
      );
    }
    const window = windows[index]!;
    const transition: SizzleTransition = index === 0 ? req.scene.transition : beat.transition;
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
      const trim = beat.mediaTrim ?? {
        startSec: capture.video.defaultRange.start,
        endSec: capture.video.defaultRange.end
      };
      const sourceDurationSec = Math.max(0.05, trim.endSec - trim.startSec);
      fit = resolveVideoFit({
        policy: beat.videoFit,
        sourceDurationSec,
        targetDurationSec: durationSec
      });
      for (const warning of fit.warnings) {
        diagnostics.push({ beatId: beat.id, code: "video_fit", message: warning });
      }
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

    const beatPlan: SequenceRenderPlan["beatPlans"][number] = {
      beatId: beat.id,
      startSec: window.startSec,
      endSec: window.endSec,
      captureId: beat.captureId
    };
    if (fit !== undefined) beatPlan.fit = fit;
    beatPlans.push(beatPlan);
  });

  return { sceneInputs, diagnostics, beatPlans };
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

function resolveBeatWindows(
  beats: SizzleSequenceBeat[],
  speechTiming: SizzleSpeechTiming,
  timelineDurationSec: number,
  diagnostics: SequencePlannerDiagnostic[]
): Array<{ startSec: number; endSec: number }> {
  const duration = Math.max(0.1, timelineDurationSec);
  const phraseScale =
    speechTiming.durationSec > 0 ? duration / speechTiming.durationSec : 1;
  const latestStart = Math.max(0, duration - 0.1);
  const starts = beats.map((beat, index) => {
    if (beat.timing.kind === "offset") return clamp(beat.timing.startSec, 0, latestStart);
    const resolved = resolvePhraseTiming(speechTiming, {
      phrase: beat.timing.phrase,
      occurrence: beat.timing.occurrence,
      offsetSec: beat.timing.offsetSec,
      durationSec: beat.timing.durationSec
    });
    if (resolved !== null) return clamp(resolved.startSec * phraseScale, 0, latestStart);
    diagnostics.push({
      beatId: beat.id,
      code: "phrase_unresolved",
      message: `Could not resolve phrase anchor ${JSON.stringify(beat.timing.phrase)}`
    });
    return (duration / beats.length) * index;
  });

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
