// Pure scene-list edits shared by the cart commit handlers and the
// in-library `sizzle:toggleScene` flow. A reel is "one scene = one
// voiceover over N clips" by default, so these treat clips (sequence
// beats) as the unit of membership, not scenes.

import {
  newSizzleSequenceBeat,
  newSizzleSequenceScene,
  normalizeSizzleSequenceBeatContinuity,
  sizzleProjectCaptureIds,
  type SizzleScene
} from "@pwrsnap/shared";
import { SIZZLE_LIMITS } from "../handlers/sizzle-validators";

/**
 * A scene may hold at most this many clips. The bus validator rejects
 * an over-cap scene, and the store's sanitizer does NOT — so a commit
 * that ignored the cap would write a project that can never be saved
 * again from the editor (every later `sizzle:update` re-sends the whole
 * scenes array and is rejected). Spill into further scenes instead.
 */
const MAX_CLIPS_PER_SCENE = SIZZLE_LIMITS.sequenceBeatsMax;

function chunked(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push([...ids.slice(i, i + size)]);
  return out;
}

/**
 * The scenes a brand-new reel starts as: one scene holding every
 * capture as a clip, spilling into additional scenes past the per-scene
 * clip cap.
 */
export function newSequenceScenesForCaptures(
  captureIds: readonly string[]
): SizzleScene[] {
  return chunked(captureIds, MAX_CLIPS_PER_SCENE).map((group) =>
    newSizzleSequenceScene(group)
  );
}

/**
 * Merge captures into a reel. New captures join the LAST scene as clips
 * when it is a sequence scene; otherwise (legacy simple-scene reels, or
 * an empty project) they become one new sequence scene. De-dups against
 * every capture already shown anywhere in the reel — a bulk merge, so
 * the user expects "add the ones that aren't already here" rather than
 * silently doubling clips. (Duplicate captures ARE legal in a reel — a
 * user can show the same shot twice — just not via this path.)
 * Returns a copy of `scenes` when nothing new was added.
 */
export function appendCapturesToScenes(
  scenes: readonly SizzleScene[],
  captureIds: readonly string[]
): SizzleScene[] {
  const existing = sizzleProjectCaptureIds(scenes);
  const toAppend: string[] = [];
  for (const id of captureIds) {
    if (existing.has(id)) continue;
    existing.add(id);
    toAppend.push(id);
  }
  if (toAppend.length === 0) return [...scenes];
  const out = [...scenes];
  let rest: readonly string[] = toAppend;
  const last = out[out.length - 1];
  if (last !== undefined && last.kind === "sequence") {
    const existingBeats = last.beats ?? [];
    // Only fill the last scene up to the cap; the remainder spills into
    // new scenes rather than making the project unsavable.
    const room = Math.max(0, MAX_CLIPS_PER_SCENE - existingBeats.length);
    if (room > 0) {
      const fill = rest.slice(0, room);
      rest = rest.slice(room);
      out[out.length - 1] = {
        ...last,
        beats: normalizeSizzleSequenceBeatContinuity([
          ...existingBeats,
          ...fill.map((id) => newSizzleSequenceBeat(id))
        ])
      };
    }
  }
  out.push(...newSequenceScenesForCaptures(rest));
  return out;
}

/**
 * Remove the FIRST appearance of a capture (the in-library toggle is a
 * membership toggle; a deliberate duplicate later in the reel is left
 * alone — same decision the simple-scene toggle made). A simple scene
 * showing it goes away whole; a clip is pulled out of its sequence
 * scene, and a scene left with no clips goes away too. No-op copy when
 * absent.
 */
export function removeCaptureFromScenes(
  scenes: readonly SizzleScene[],
  captureId: string
): SizzleScene[] {
  const out: SizzleScene[] = [];
  let removed = false;
  for (const scene of scenes) {
    if (removed) {
      out.push(scene);
      continue;
    }
    if (scene.kind === "sequence") {
      const beats = scene.beats ?? [];
      const idx = beats.findIndex((beat) => beat.captureId === captureId);
      if (idx < 0) {
        out.push(scene);
        continue;
      }
      removed = true;
      const kept = beats.filter((_, i) => i !== idx);
      if (kept.length === 0) continue;
      out.push({
        ...scene,
        captureId: kept[0]!.captureId,
        beats: normalizeSizzleSequenceBeatContinuity(kept)
      });
      continue;
    }
    if (scene.captureId === captureId) {
      removed = true;
      continue;
    }
    out.push(scene);
  }
  return out;
}
