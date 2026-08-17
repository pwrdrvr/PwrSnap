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
  resolveSizzleAudioSource,
  sizzleTransitionDurationSec,
  sizzleTransitionType
} from "./protocol";
import { normalizeVideoMediaTrim } from "./sizzle-media-trim";

/** Floor for an estimated scene, so an empty script still occupies the
 *  timeline rather than reading as a zero-length scene. */
const MIN_ESTIMATED_SCENE_SEC = 1;

/** A sequence scene's narration. `scriptLine` mirrors `narration` for
 *  compatibility, but `narration` is the field of record. */
function sequenceNarration(scene: SizzleScene): string {
  return scene.narration ?? scene.scriptLine;
}

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
 * Assumed narration rate for a script nobody has synthesized yet.
 *
 * Word count is what actually drives narration length, so this is the
 * only signal available before the TTS runs. Calibrated against an
 * observed `tts-1` reel — a 52-token script that synthesized to 19.0s,
 * i.e. ~164 wpm — and rounded down to 160 so the estimate leans long
 * rather than short. It is a rough model, not a measurement: callers get
 * `exact: false` and the composer prefixes the total with `~`.
 *
 * The predecessor here was one second per beat, which measured clip
 * count rather than narration and under-reported that same reel as 3s.
 */
export const SIZZLE_ESTIMATED_NARRATION_WPM = 160;

/**
 * Rough spoken length of a script, in seconds. Zero for empty text, so
 * callers can fall back to a visual default instead of claiming a
 * near-zero scene.
 *
 * Splits on dashes as well as whitespace: "copy-to-clipboard" is one
 * whitespace token but three spoken words, and compound-heavy technical
 * narration is exactly what these reels carry.
 */
export function estimateNarrationDurationSec(text: string): number {
  const tokens = text.trim().split(/[\s—–-]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return 0;
  return (tokens.length / SIZZLE_ESTIMATED_NARRATION_WPM) * 60;
}

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
   * ran THIS session and whose plan key still matches the scene. Exact,
   * and already reflects any duration override.
   */
  sequencePlanDurationSec?: number | undefined;
  /**
   * Measured narration length for a sequence scene, read from the
   * content-addressed TTS cache when the reel opened — so a reel
   * previewed or rendered in ANY past session is exact on open without
   * synthesizing anything. Pre-override, unlike `sequencePlanDurationSec`.
   */
  narrationDurationSec?: number | undefined;
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
    // A cached plan is the whole answer — it already applied the override.
    if (context.sequencePlanDurationSec !== undefined) {
      return { durationSec: context.sequencePlanDurationSec, exact: true };
    }
    // `planSequenceTimeline` treats the override as a FLOOR under the
    // narration, not a replacement for it, so both remaining branches max.
    if (context.narrationDurationSec !== undefined) {
      return {
        durationSec: Math.max(overrideSec ?? 0, context.narrationDurationSec),
        exact: true
      };
    }
    const narration = estimateNarrationDurationSec(sequenceNarration(scene));
    return {
      durationSec: Math.max(overrideSec ?? 0, narration, MIN_ESTIMATED_SCENE_SEC),
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
    const measured = context.voiceoverDurationSec;
    return {
      durationSec: resolveVoiceoverSceneDurationSec({
        durationOverrideSec: scene.durationOverrideSec,
        voiceoverDurationSec: measured ?? estimateNarrationDurationSec(scene.scriptLine),
        defaultVisualDurationSec: trimDurationSec
      }),
      exact: measured !== undefined
    };
  }

  // Image scene.
  if (effectiveAudio !== "voiceover") {
    return {
      durationSec: overrideSec ?? SIZZLE_IMAGE_SCENE_DEFAULT_SEC,
      exact: true
    };
  }
  const measured = context.voiceoverDurationSec;
  return {
    durationSec: resolveVoiceoverSceneDurationSec({
      durationOverrideSec: scene.durationOverrideSec,
      voiceoverDurationSec: measured ?? estimateNarrationDurationSec(scene.scriptLine),
      // A still has no intrinsic length of its own; with an empty script
      // the image default is all that's left to stand on.
      defaultVisualDurationSec:
        measured === undefined && scene.scriptLine.trim().length === 0
          ? SIZZLE_IMAGE_SCENE_DEFAULT_SEC
          : 0
    }),
    exact: measured !== undefined
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
