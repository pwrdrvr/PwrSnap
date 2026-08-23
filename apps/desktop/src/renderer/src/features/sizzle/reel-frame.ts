// What the REEL shows at a project-axis time. Pure: no React, no DOM.
//
// The per-scene stage (`preview-blend.ts`) answers this within one scene.
// The reel player needs it across the whole project, and the two axes
// model transition overlap differently — that difference is the entire
// reason this module exists, so it is worth stating precisely:
//
//   • WITHIN a scene, `planSequenceTimeline` hands back AUDIO windows.
//     Beat N's window starts when its narration slice starts; the export
//     makes the picture arrive `d` seconds EARLY (the composer chains
//     every input with xfade, and `sequence-planner` pads the beat's
//     visual by `transitionOverlapSec`). So the blend runs over
//     [start − d, start).
//
//   • ACROSS scenes, `layoutSizzleScenes` has ALREADY pulled the incoming
//     scene back by `d` (`startSec = chainEndSec − overlapSec`). The
//     overlap is baked into the axis, so the blend runs over
//     [start, start + d). Subtracting `d` again here would start the
//     dissolve a full transition early — the bug this comment exists to
//     prevent.
//
// Both cases are real on one reel: clip→clip transitions inside a
// sequence scene, and scene→scene transitions between them (the only
// kind a reel of legacy one-capture scenes has at all).

import { sizzleTransitionType, type SizzleTransitionType } from "@pwrsnap/shared";
import { transitionOverlapSec } from "./preview-blend";
import type { TimelineClip, TimelineModel } from "./timeline/timeline-model";

export type ReelClip = {
  clip: TimelineClip;
  sceneId: string;
  sceneIndex: number;
  /** Position in the flattened reel, not within its scene. */
  reelIndex: number;
  /** Project-axis window of this clip's own slot. */
  startSec: number;
  endSec: number;
  /** True when this is a scene's first clip, i.e. the transition into it
   *  is a SCENE transition whose overlap is already on the axis. */
  sceneBoundary: boolean;
  type: SizzleTransitionType;
  /** Seconds the transition into this clip runs; 0 for a cut. */
  transitionSec: number;
  /** Project-axis instant the dissolve into this clip begins. */
  blendStartSec: number;
};

/** Every clip of every scene, ordered, on one project axis. */
export function flattenReelClips(model: TimelineModel): ReelClip[] {
  const out: ReelClip[] = [];
  for (const scene of model.scenes) {
    scene.clips.forEach((clip, indexInScene) => {
      const sceneBoundary = indexInScene === 0;
      const reelIndex = out.length;
      // The very first clip of the reel has nothing to blend from.
      const transitionSec = reelIndex === 0 ? 0 : transitionOverlapSec(clip.transition, 1);
      out.push({
        clip,
        sceneId: scene.sceneId,
        sceneIndex: scene.index,
        reelIndex,
        startSec: clip.startSec,
        endSec: clip.endSec,
        sceneBoundary,
        type: sizzleTransitionType(clip.transition),
        transitionSec,
        // See the header: the axis already carries the scene overlap.
        blendStartSec: sceneBoundary ? clip.startSec : clip.startSec - transitionSec
      });
    });
  }
  return out;
}

export type ReelBlend = {
  incomingIndex: number;
  type: SizzleTransitionType;
  durationSec: number;
  startSec: number;
  /** 0 when the dissolve opens, 1 when the incoming clip owns the stage. */
  progress: number;
};

export type ReelFrame = {
  /** Index into the flattened list of the clip that owns the stage (the
   *  OUTGOING one while a blend runs); -1 when the reel has no clips. */
  activeIndex: number;
  blend: ReelBlend | null;
};

/** What the stage shows at `sec` on the project axis. */
export function reelFrameAt(clips: readonly ReelClip[], sec: number): ReelFrame {
  if (clips.length === 0) return { activeIndex: -1, blend: null };
  // The clip whose own slot contains `sec`. Scene overlap means two clips
  // can contain it; the LAST such clip is the incoming one, so scan for
  // the last start at or before `sec` and treat the one before it as
  // still-outgoing while its dissolve runs.
  let index = 0;
  for (let i = 0; i < clips.length; i += 1) {
    if (sec >= clips[i]!.startSec) index = i;
    else break;
  }
  const current = clips[index]!;
  // Inside the dissolve INTO `current`: the previous clip still owns the
  // stage and `current` is blending in on top.
  if (
    index > 0 &&
    current.transitionSec > 0 &&
    sec >= current.blendStartSec &&
    sec < current.blendStartSec + current.transitionSec
  ) {
    const progress = clamp01((sec - current.blendStartSec) / current.transitionSec);
    return {
      activeIndex: index - 1,
      blend: {
        incomingIndex: index,
        type: current.type,
        durationSec: current.transitionSec,
        startSec: current.blendStartSec,
        progress
      }
    };
  }
  // Not blending: `current` owns the stage — unless the NEXT clip's
  // dissolve has already opened (the within-scene case, where the blend
  // starts before the next clip's own slot does).
  const next = clips[index + 1];
  if (
    next !== undefined &&
    next.transitionSec > 0 &&
    sec >= next.blendStartSec &&
    sec < next.startSec
  ) {
    const progress = clamp01((sec - next.blendStartSec) / next.transitionSec);
    return {
      activeIndex: index,
      blend: {
        incomingIndex: index + 1,
        type: next.type,
        durationSec: next.transitionSec,
        startSec: next.blendStartSec,
        progress
      }
    };
  }
  return { activeIndex: index, blend: null };
}

/** Progress (0..1) through a clip's own slot, for Ken Burns. */
export function reelClipProgress(clip: ReelClip, sec: number): number {
  const span = Math.max(0.05, clip.endSec - clip.startSec);
  return clamp01((sec - clip.startSec) / span);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** One scene's slot on the AUDIO timeline. */
export type ReelAudioSlot = { sceneId: string; startSec: number; endSec: number };

/**
 * Where each scene's narration sits in time.
 *
 * This is NOT the video axis. `layoutSizzleScenes` pulls a scene back by its
 * transition overlap because the composer cross-fades the PICTURE; the
 * composer's audio side (`buildAudioConcat`) does no such thing — it trims
 * each narration to its own length and concatenates. So narration runs
 * strictly sequentially while the picture overlaps.
 *
 * Positioning audio on the video axis is what made a scene's first word
 * disappear: at a 0.45 s crossfade the head enters scene N at
 * `prevEnd − 0.45`, so `sec − scene.startSec` seeked 0.45 s INTO that
 * scene's narration and ate the opening word.
 *
 * Consequence worth knowing: with scene transitions the picture runs ahead
 * of the narration by the accumulated overlap, exactly as the export does
 * today (and why `-shortest` clips the tail there). Fixing the planner's
 * scene-boundary head extension collapses the two axes back together and
 * this drift disappears on its own.
 */
export function reelAudioTimeline(model: TimelineModel): ReelAudioSlot[] {
  let offsetSec = 0;
  return model.scenes.map((scene) => {
    const slot = { sceneId: scene.sceneId, startSec: offsetSec, endSec: offsetSec + scene.durationSec };
    offsetSec = slot.endSec;
    return slot;
  });
}

/** The narration slot playing at `sec`, with the offset into it. */
export function reelAudioAt(
  slots: readonly ReelAudioSlot[],
  sec: number
): { sceneId: string; localSec: number } | null {
  if (slots.length === 0) return null;
  const slot = slots.find((s) => sec >= s.startSec && sec < s.endSec) ?? slots.at(-1)!;
  return { sceneId: slot.sceneId, localSec: Math.max(0, Math.min(slot.endSec - slot.startSec, sec - slot.startSec)) };
}
