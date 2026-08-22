// Pure scene-list edits for the Sizzle editor. Every function takes the
// current `SizzleScene[]` and returns the next one (or the same array
// when nothing changed) — the editor wraps them with `onScenes`, which
// owns the optimistic update, the debounced write, and undo history.
// Keeping them here (not inside a component) makes them unit-testable
// and lets the timeline's retime math (PR 5) build on the same shapes.

import {
  newSizzleSequenceScene,
  normalizeSizzleSequenceBeatContinuity,
  type SizzleScene,
  type SizzleSequenceBeat
} from "@pwrsnap/shared";

export function removeSceneById(scenes: SizzleScene[], id: string): SizzleScene[] {
  return scenes.filter((s) => s.id !== id);
}

/** Swap a scene with its neighbour. Out-of-range moves return the input. */
export function moveSceneBy(scenes: SizzleScene[], idx: number, delta: number): SizzleScene[] {
  const next = [...scenes];
  const target = idx + delta;
  if (target < 0 || target >= next.length) return scenes;
  [next[idx], next[target]] = [next[target]!, next[idx]!];
  return next;
}

export function patchScene(
  scenes: SizzleScene[],
  id: string,
  patch: Partial<SizzleScene>
): SizzleScene[] {
  return scenes.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

export function patchSequenceBeat(
  scenes: SizzleScene[],
  sceneId: string,
  beatId: string,
  patch: Partial<SizzleSequenceBeat>
): SizzleScene[] {
  return scenes.map((s) => {
    if (s.id !== sceneId || s.kind !== "sequence" || s.beats === undefined) return s;
    return {
      ...s,
      beats: normalizeSizzleSequenceBeatContinuity(
        s.beats.map((beat) => (beat.id === beatId ? { ...beat, ...patch } : beat))
      )
    };
  });
}

function beatFromScene(scene: SizzleScene): SizzleSequenceBeat {
  return {
    id: `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    captureId: scene.captureId,
    timing: { kind: "auto" },
    mediaTrim: scene.mediaTrim,
    transition: "cut",
    videoFit: "smart-fit"
  };
}

/** Turn a legacy one-capture scene into a sequence scene with one clip. */
export function convertSceneToSequence(scenes: SizzleScene[], sceneId: string): SizzleScene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId || scene.kind === "sequence") return scene;
    return {
      ...scene,
      kind: "sequence",
      narration: scene.scriptLine,
      scriptLine: scene.scriptLine,
      audioSource: "voiceover",
      beats: normalizeSizzleSequenceBeatContinuity([beatFromScene(scene)])
    };
  });
}

/**
 * The inverse of the one-scene default: every clip becomes its own
 * scene (one voiceover segment each). The first keeps this scene's id
 * and narration so preview caches + undo stay anchored; the rest are
 * fresh sequence scenes with empty narration, crossfading in. Clip
 * timing resets to `auto` (a lone clip has nothing to anchor to);
 * trims and fit policies travel with the clip.
 */
export function splitSceneIntoScenes(scenes: SizzleScene[], sceneId: string): SizzleScene[] {
  return scenes.flatMap((scene) => {
    if (scene.id !== sceneId || scene.kind !== "sequence") return [scene];
    const beats = scene.beats ?? [];
    if (beats.length <= 1) return [scene];
    return beats.map((beat, index): SizzleScene => {
      const lone: SizzleSequenceBeat = { ...beat, timing: { kind: "auto" } };
      if (index === 0) {
        return { ...scene, captureId: beat.captureId, beats: [lone] };
      }
      const fresh = newSizzleSequenceScene([beat.captureId]);
      return { ...fresh, beats: [lone] };
    });
  });
}

/**
 * Move a beat from one index to another (drag-drop or the ↑/↓ arrows). A
 * splice-and-insert, not a pairwise swap, so dragging across several beats
 * shifts the rest sensibly. `auto` beats need no timing fixup;
 * normalizeSizzleSequenceBeatContinuity re-applies the non-final-end rule
 * after the move. `changed` is false for a self-drop or an out-of-range
 * index, so the caller can skip preview invalidation.
 */
export function reorderSequenceBeatIn(
  scenes: SizzleScene[],
  sceneId: string,
  from: number,
  to: number
): { scenes: SizzleScene[]; changed: boolean } {
  if (from === to) return { scenes, changed: false };
  let changed = false;
  const next = scenes.map((scene) => {
    if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
    if (from < 0 || from >= scene.beats.length || to < 0 || to >= scene.beats.length) return scene;
    const beats = [...scene.beats];
    const [moved] = beats.splice(from, 1);
    if (moved === undefined) return scene;
    beats.splice(to, 0, moved);
    changed = true;
    return { ...scene, beats: normalizeSizzleSequenceBeatContinuity(beats) };
  });
  return { scenes: changed ? next : scenes, changed };
}

/** Remove a clip from a sequence scene. A scene keeps at least one clip. */
export function removeSequenceBeatFrom(
  scenes: SizzleScene[],
  sceneId: string,
  beatId: string
): SizzleScene[] {
  return scenes.map((scene) => {
    if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
    if (scene.beats.length <= 1) return scene;
    return {
      ...scene,
      beats: normalizeSizzleSequenceBeatContinuity(
        scene.beats.filter((beat) => beat.id !== beatId)
      )
    };
  });
}
