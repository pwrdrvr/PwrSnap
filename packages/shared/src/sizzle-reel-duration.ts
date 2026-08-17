/**
 * Reel-length arithmetic, shared between the render path (main) and the
 * composer UI (renderer).
 *
 * ## Why a reel's length is only partly knowable before rendering
 *
 * A scene whose audio resolves to `voiceover` runs as long as the
 * synthesized narration runs — `resolveVoiceoverSceneDurationSec` takes
 * the measured TTS length as an INPUT. There is no way to know that
 * number without doing the TTS, and doing TTS just to price a label
 * would make opening a reel do speech work.
 *
 * So the estimate is honest about its own precision. Every scene
 * resolves to `{ durationSec, exact }`:
 *
 *   • `exact: true`  — the duration is fully determined by data the
 *     caller already has (a cached sequence plan from a preview the user
 *     already ran, a measured TTS duration, a video trim, an explicit
 *     duration override on a non-voiceover scene).
 *   • `exact: false` — the duration is a placeholder standing in for a
 *     narration length nobody has measured yet.
 *
 * Callers surface the difference (the composer prefixes an estimated
 * total with `~`) rather than showing a confident wrong number.
 */

import type { SizzleAudioSource, SizzleScene, SizzleTransition } from "./protocol";
import {
  normalizeSizzleSequenceBeatContinuity,
  resolveSizzleAudioSource,
  sizzleTransitionDurationSec,
  sizzleTransitionType
} from "./protocol";
import { normalizeVideoMediaTrim } from "./sizzle-media-trim";

/**
 * Slack appended to a voiceover scene so narration doesn't butt into the
 * next cut. Part of the render contract — the composer sizes per-scene
 * audio as `measured + this`.
 */
export const SIZZLE_VOICEOVER_TAIL_PAD_SEC = 0.35;

/**
 * Visual length of an image scene when nothing else determines it (no
 * duration override, no narration). Also the placeholder for an image
 * scene whose narration has not been synthesized yet.
 */
export const SIZZLE_IMAGE_SCENE_DEFAULT_SEC = 3.0;

/**
 * Length of a sequence scene's fallback timeline, per beat, before a
 * preview has produced a real plan. Matches the editor's idle beat strip
 * (`fallbackSequenceBeats`), so the strip and the estimate agree.
 */
export const SIZZLE_SEQUENCE_FALLBACK_SEC_PER_BEAT = 1;

export function resolveVoiceoverSceneDurationSec(args: {
  durationOverrideSec: number | null;
  voiceoverDurationSec: number;
  defaultVisualDurationSec: number;
}): number {
  const minNarrationDurationSec =
    args.voiceoverDurationSec + SIZZLE_VOICEOVER_TAIL_PAD_SEC;
  if (args.durationOverrideSec !== null && args.durationOverrideSec > 0) {
    return Math.max(args.durationOverrideSec, minNarrationDurationSec);
  }
  return Math.max(args.defaultVisualDurationSec, minNarrationDurationSec);
}

export type SizzleSceneDurationEstimate = {
  durationSec: number;
  /** False when `durationSec` stands in for an unmeasured narration. */
  exact: boolean;
};

/**
 * What the caller knows about one scene beyond the scene record itself.
 * Everything is optional — a missing field just pushes the scene onto
 * the estimated branch rather than failing.
 */
export type SizzleSceneDurationContext = {
  /** `null` when the capture record has not loaded (or is missing). */
  capture: {
    kind: "image" | "video";
    video?:
      | { durationSec: number; defaultRange: { start: number; end: number } }
      | null
      | undefined;
  } | null;
  /**
   * Duration of a sequence scene's plan, from a preview the user already
   * ran THIS session and whose plan key still matches the scene. Exact.
   */
  sequencePlanDurationSec?: number | undefined;
  /**
   * Measured TTS length for a simple voiceover scene, from a preview the
   * user already ran. Exact.
   */
  voiceoverDurationSec?: number | undefined;
};

/**
 * Length one scene contributes to the reel, before transition overlap.
 *
 * Mirrors `prepareSceneInput` in the render handler (simple scenes) and
 * `planSequenceTimeline` (sequence scenes). A sequence scene's beats are
 * padded by their own transition overlaps inside the planner, so they sum
 * back to the plan's timeline duration once the internal xfades subtract
 * — which is why a sequence scene is a single unit here.
 */
export function estimateSizzleSceneDurationSec(
  scene: SizzleScene,
  context: SizzleSceneDurationContext
): SizzleSceneDurationEstimate {
  const overrideSec =
    scene.durationOverrideSec !== null && scene.durationOverrideSec > 0
      ? scene.durationOverrideSec
      : null;

  if (scene.kind === "sequence") {
    if (context.sequencePlanDurationSec !== undefined) {
      return { durationSec: context.sequencePlanDurationSec, exact: true };
    }
    // Same idle placement the editor's beat strip uses pre-preview: one
    // second per beat, floored at one second. The real timeline is
    // max(override, narration) and narration is unmeasured here.
    const beatCount = normalizeSizzleSequenceBeatContinuity(scene.beats ?? []).length;
    return {
      durationSec: Math.max(
        SIZZLE_SEQUENCE_FALLBACK_SEC_PER_BEAT,
        overrideSec ?? beatCount * SIZZLE_SEQUENCE_FALLBACK_SEC_PER_BEAT
      ),
      exact: false
    };
  }

  if (context.capture === null) {
    // Capture record still loading (or missing). Its kind decides which
    // duration policy applies at all, so nothing here can be exact.
    return {
      durationSec: overrideSec ?? SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
      exact: false
    };
  }

  const captureKind = context.capture.kind;
  const effectiveAudio: Exclude<SizzleAudioSource, "auto"> = resolveSizzleAudioSource(
    scene.audioSource,
    captureKind,
    scene.scriptLine
  );

  if (captureKind === "video") {
    const video = context.capture.video ?? null;
    if (video === null) {
      // A video row with no stream metadata — the trim is unknown, so
      // even the non-voiceover branches are guesses.
      return {
        durationSec: overrideSec ?? SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
        exact: false
      };
    }
    const trim = normalizeVideoMediaTrim({
      trim: scene.mediaTrim,
      defaultRange: video.defaultRange,
      sourceDurationSec: video.durationSec
    });
    const trimDurationSec = trim.endSec - trim.startSec;
    if (effectiveAudio !== "voiceover") {
      // native / muted: the clip's own length wins unless overridden.
      return { durationSec: overrideSec ?? trimDurationSec, exact: true };
    }
    if (context.voiceoverDurationSec === undefined) {
      // Narration unmeasured. The render extends the scene to fit the
      // voiceover when it overruns, so this is a floor, not a guess at
      // the true length.
      return { durationSec: overrideSec ?? trimDurationSec, exact: false };
    }
    return {
      durationSec: resolveVoiceoverSceneDurationSec({
        durationOverrideSec: scene.durationOverrideSec,
        voiceoverDurationSec: context.voiceoverDurationSec,
        defaultVisualDurationSec: trimDurationSec
      }),
      exact: true
    };
  }

  // Image scene.
  if (effectiveAudio !== "voiceover") {
    return {
      durationSec: overrideSec ?? SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
      exact: true
    };
  }
  if (context.voiceoverDurationSec === undefined) {
    // A still has no intrinsic length, so there is nothing to fall back
    // to but the image default. Under-reports a long narration — hence
    // the estimated flag.
    return {
      durationSec: overrideSec ?? SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
      exact: false
    };
  }
  return {
    durationSec: resolveVoiceoverSceneDurationSec({
      durationOverrideSec: scene.durationOverrideSec,
      voiceoverDurationSec: context.voiceoverDurationSec,
      defaultVisualDurationSec: 0
    }),
    exact: true
  };
}

export type SizzleReelDurationEstimate = {
  /** Total output length in seconds. Zero when there are no scenes. */
  totalSec: number;
  /** False when ANY scene fell back to an estimate. */
  exact: boolean;
  sceneCount: number;
};

/**
 * Total output length of a reel.
 *
 * Scene lengths are summed, then each scene→scene boundary that uses a
 * fade-like transition gives back its overlap — the composer's
 * `buildTransitionChain` splices an `xfade` there, so the chain is
 * shorter than the sum by the fade duration (clamped to the chain length
 * so far and to the incoming scene). Hard cuts concat and lose nothing.
 * The first scene's transition is ignored; nothing precedes it.
 */
export function estimateSizzleReelDurationSec(
  scenes: readonly SizzleScene[],
  contextFor: (scene: SizzleScene) => SizzleSceneDurationContext
): SizzleReelDurationEstimate {
  if (scenes.length === 0) {
    return { totalSec: 0, exact: true, sceneCount: 0 };
  }
  let exact = true;
  let chainEndSec = 0;
  scenes.forEach((scene, index) => {
    const estimate = estimateSizzleSceneDurationSec(scene, contextFor(scene));
    if (!estimate.exact) exact = false;
    if (index === 0) {
      chainEndSec = estimate.durationSec;
      return;
    }
    const overlapSec = Math.min(
      transitionOverlapSec(scene.transition),
      chainEndSec,
      estimate.durationSec
    );
    chainEndSec = chainEndSec + estimate.durationSec - overlapSec;
  });
  return { totalSec: chainEndSec, exact, sceneCount: scenes.length };
}

/**
 * Format seconds as `m:ss` — `0:42`, `1:07`, `12:30`. Rounds to the
 * nearest second rather than truncating: a 41.6 s reel labelled `0:41`
 * that renders to 42 s reads as a bug. Minutes are unbounded (a 90 min
 * reel is `90:00`), and negative / non-finite input clamps to `0:00`.
 */
export function formatSizzleDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "0:00";
  const wholeSec = Math.round(totalSec);
  const minutes = Math.floor(wholeSec / 60);
  const seconds = wholeSec % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function transitionOverlapSec(transition: SizzleTransition): number {
  const type = sizzleTransitionType(transition);
  if (type === "none" || type === "cut") return 0;
  return Math.max(0, sizzleTransitionDurationSec(transition));
}
