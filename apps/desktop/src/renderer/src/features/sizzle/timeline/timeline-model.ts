// The timeline's view model: every scene as a region on ONE project time
// axis, every clip as a window on it, and the transcript's words at
// absolute times. Pure — no React, no DOM.
//
// This is the single place the two exactness states (plan §4.1) are
// decided. A scene is RESOLVED when real speech timing is available —
// a plan from a preview this session, or words + a measured duration
// from the speech-timing cache on open — and ESTIMATED otherwise. The
// resolved windows come from the SAME planner main uses for the export
// (`planSequenceTimeline`, shared), so the editor never draws a clip at
// a time the render would not cut it.

import {
  layoutSizzleScenes,
  planSequenceTimeline,
  type SequencePlannerDiagnostic,
  type SizzleBeatTiming,
  type SizzleScene,
  type SizzleSceneDurationContext,
  type SizzleSequencePreviewBeat,
  type SizzleSequencePreviewPlan,
  type SizzleTransition,
  type SizzleVideoFitPolicy,
  type SizzleWordTiming
} from "@pwrsnap/shared";
import { fallbackSequenceBeats } from "../sequence-plan";

export type TimelineExactness = "resolved" | "estimated";

export type TimelineClip = {
  beatId: string;
  captureId: string;
  sceneId: string;
  /** Index within its scene. */
  index: number;
  /** Project-axis window. */
  startSec: number;
  endSec: number;
  /** Scene-axis window (what the planner and `seekPreview` speak). */
  localStartSec: number;
  localEndSec: number;
  durationSec: number;
  exact: boolean;
  /** Has a concrete position from its own timing (an `offset`, or a
   *  `phrase` that resolved). Auto clips re-flow around anchored ones. */
  anchored: boolean;
  /** A `phrase` anchor on a scene whose transcript is not available yet
   *  (estimated) or that did not resolve — it is placed as auto. */
  pendingAnchor: boolean;
  unresolved: boolean;
  tooShort: boolean;
  timing: SizzleBeatTiming;
  /** Transition INTO this clip (the scene's own transition for clip 0). */
  transition: SizzleTransition;
  videoFit: SizzleVideoFitPolicy;
};

export type TimelineWord = SizzleWordTiming & {
  absStartSec: number;
  absEndSec: number;
};

export type TimelineSceneRegion = {
  sceneId: string;
  index: number;
  kind: "sequence" | "simple";
  startSec: number;
  endSec: number;
  durationSec: number;
  exact: boolean;
  exactness: TimelineExactness;
  /** Transition INTO this scene (ignored on scene 0). */
  transition: SizzleTransition;
  clips: TimelineClip[];
  /** Transcript words at absolute times; empty when estimated. */
  words: TimelineWord[];
  diagnostics: SequencePlannerDiagnostic[];
};

export type TimelineModel = {
  totalSec: number;
  /** False when ANY scene is estimated. */
  exact: boolean;
  scenes: TimelineSceneRegion[];
};

/** What the editor knows about one scene beyond the scene record. */
export type TimelineSceneSource = {
  /** A plan from a preview run this session whose key still matches. */
  plan?: SizzleSequencePreviewPlan | undefined;
  /** Transcript words (plan, or the speech-timing cache on open); null
   *  until the narration has been synthesized — nothing is fabricated. */
  words: SizzleWordTiming[] | null;
  /** Duration context for the shared estimator — the SAME object the
   *  Render label uses, so region lengths and the label agree. */
  context: SizzleSceneDurationContext;
};

export function buildTimelineModel(args: {
  scenes: readonly SizzleScene[];
  sourceFor: (scene: SizzleScene) => TimelineSceneSource;
}): TimelineModel {
  const { scenes, sourceFor } = args;
  const sources = scenes.map((scene) => sourceFor(scene));
  const layout = layoutSizzleScenes(scenes, (scene) => {
    const i = scenes.indexOf(scene);
    return sources[i]!.context;
  });
  const regions = scenes.map((scene, index): TimelineSceneRegion => {
    const placed = layout.scenes[index]!;
    const source = sources[index]!;
    if (scene.kind !== "sequence") {
      // A legacy one-capture scene is a single clip spanning the scene.
      return {
        sceneId: scene.id,
        index,
        kind: "simple",
        startSec: placed.startSec,
        endSec: placed.endSec,
        durationSec: placed.durationSec,
        exact: placed.exact,
        exactness: placed.exact ? "resolved" : "estimated",
        transition: scene.transition,
        clips: [
          {
            beatId: `scene:${scene.id}`,
            captureId: scene.captureId,
            sceneId: scene.id,
            index: 0,
            startSec: placed.startSec,
            endSec: placed.endSec,
            localStartSec: 0,
            localEndSec: placed.durationSec,
            durationSec: placed.durationSec,
            exact: placed.exact,
            anchored: false,
            pendingAnchor: false,
            unresolved: false,
            tooShort: false,
            timing: { kind: "auto" },
            transition: scene.transition,
            videoFit: "smart-fit"
          }
        ],
        words: [],
        diagnostics: []
      };
    }

    const { beats, diagnostics, words, resolved } = sequenceWindows(scene, source, placed.durationSec);
    const unresolvedIds = new Set(
      diagnostics.filter((d) => d.code === "phrase_unresolved").map((d) => d.beatId)
    );
    const tooShortIds = new Set(
      diagnostics.filter((d) => d.code === "beat_too_short").map((d) => d.beatId)
    );
    const clips = beats.map((beat, clipIndex): TimelineClip => {
      const timing = beat.timing;
      const isPhrase = timing.kind === "phrase";
      const unresolved = unresolvedIds.has(beat.beatId);
      const anchored =
        timing.kind === "offset" ? true : isPhrase ? resolved && !unresolved : false;
      return {
        beatId: beat.beatId,
        captureId: beat.captureId,
        sceneId: scene.id,
        index: clipIndex,
        startSec: placed.startSec + beat.startSec,
        endSec: placed.startSec + beat.endSec,
        localStartSec: beat.startSec,
        localEndSec: beat.endSec,
        durationSec: beat.endSec - beat.startSec,
        exact: placed.exact,
        anchored,
        pendingAnchor: isPhrase && !anchored,
        unresolved,
        tooShort: tooShortIds.has(beat.beatId),
        timing,
        transition: beat.transition,
        videoFit: beat.videoFit
      };
    });
    return {
      sceneId: scene.id,
      index,
      kind: "sequence",
      startSec: placed.startSec,
      endSec: placed.endSec,
      durationSec: placed.durationSec,
      exact: placed.exact,
      exactness: placed.exact ? "resolved" : "estimated",
      transition: scene.transition,
      clips,
      words: words.map((w) => ({
        ...w,
        absStartSec: placed.startSec + w.startSec,
        absEndSec: placed.startSec + w.endSec
      })),
      diagnostics
    };
  });
  return { totalSec: layout.totalSec, exact: layout.exact, scenes: regions };
}

function sequenceWindows(
  scene: SizzleScene,
  source: TimelineSceneSource,
  durationSec: number
): {
  beats: SizzleSequencePreviewBeat[];
  diagnostics: SequencePlannerDiagnostic[];
  words: SizzleWordTiming[];
  resolved: boolean;
} {
  const hasBeats = (scene.beats?.length ?? 0) > 0;
  if (!hasBeats) return { beats: [], diagnostics: [], words: [], resolved: false };
  // 1. A plan from this session's preview is the whole answer: it already
  //    applied the override and the planner's media diagnostics.
  if (source.plan !== undefined) {
    return {
      beats: source.plan.beats,
      diagnostics: source.plan.warnings
        .filter((w): w is { beatId: string; code: string; message: string } => w.beatId !== undefined)
        .map((w) => ({ beatId: w.beatId, code: w.code, message: w.message })),
      // `?? []` only for older test fixtures / pre-PR-2 plans; the handler
      // always sends `words` now.
      words: source.plan.words ?? [],
      resolved: true
    };
  }
  // 2. Cached speech timing (words + measured duration, no plan yet): run
  //    the SAME planner the export runs. `quality` is not on the cached
  //    arm; it only annotates phrase resolutions and does not move a clip.
  const narrationDurationSec = source.context.narrationDurationSec;
  if (source.words !== null && narrationDurationSec !== undefined) {
    const plan = planSequenceTimeline(scene, {
      text: scene.narration ?? scene.scriptLine,
      durationSec: narrationDurationSec,
      quality: "precise",
      words: source.words,
      warnings: []
    });
    return {
      beats: plan.beatPlans,
      diagnostics: plan.diagnostics,
      words: source.words,
      resolved: true
    };
  }
  // 3. Nothing measured: the idle placement (offsets anchor, phrase and
  //    auto re-flow) on the word-count estimate. Every label gets a `~`.
  void durationSec;
  return { beats: fallbackSequenceBeats(scene), diagnostics: [], words: [], resolved: false };
}

/** The scene region under a project-axis time, or null past the end. */
export function sceneAt(model: TimelineModel, sec: number): TimelineSceneRegion | null {
  for (const scene of model.scenes) {
    if (sec >= scene.startSec && sec < scene.endSec) return scene;
  }
  return model.scenes.at(-1) ?? null;
}

/** The clip under a project-axis time within its scene. */
export function clipAt(scene: TimelineSceneRegion, sec: number): TimelineClip | null {
  return (
    scene.clips.find((c) => sec >= c.startSec && sec < c.endSec) ?? scene.clips.at(-1) ?? null
  );
}
