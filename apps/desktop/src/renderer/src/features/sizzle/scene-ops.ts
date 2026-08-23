// Pure scene-list edits for the Sizzle editor. Every function takes the
// current `SizzleScene[]` and returns the next one (or the same array
// when nothing changed) — the editor wraps them with `onScenes`, which
// owns the optimistic update, the debounced write, and undo history.
// Keeping them here (not inside a component) makes them unit-testable
// and lets the timeline's retime math (PR 5) build on the same shapes.

import {
  countPhraseOccurrences,
  newSizzleSequenceScene,
  normalizeSizzleSequenceBeatContinuity,
  normalizeWord,
  tokenizeWords,
  type SizzleBeatTiming,
  type SizzleScene,
  type SizzleSequenceBeat,
  type SizzleWordTiming
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

// ── Multi-scene operations (plan PR 8) ───────────────────────────────────
// Structural edits that must keep anchors honest. Phrase anchors store
// text + occurrence; when scenes merge or split, the occurrence is counted
// against a DIFFERENT transcript, so it is re-counted over the text that
// precedes the clip. Offsets are absolute seconds on the scene axis, so a
// merge shifts them by the previous scene's length and a split rebases
// them to the new scene's zero. Nothing here fabricates word times: a
// split needs the scene's resolved words.

/** Pseudo-words over plain text — enough for the shared phrase matcher to
 *  COUNT occurrences (it reads `word` / `normalized` only). Times are 0. */
export function pseudoWordsFromText(text: string): SizzleWordTiming[] {
  return tokenizeWords(text).map((token, index) => ({
    index,
    word: token.word,
    normalized: token.normalized,
    startSec: 0,
    endSec: 0
  }));
}

/** A phrase for "the first words of `text`": grows from the first word
 *  until unique within `preceding + text`, up to five words; the occurrence
 *  is 1 + the count in `preceding`. Null when `text` has no words. */
function leadingPhraseAnchor(precedingText: string, text: string): SizzleBeatTiming | null {
  const lead = tokenizeWords(text);
  if (lead.length === 0) return null;
  const all = pseudoWordsFromText(`${precedingText} ${text}`);
  const before = pseudoWordsFromText(precedingText);
  let phrase = lead[0]!.word;
  for (let n = 1; n <= Math.min(5, lead.length); n += 1) {
    phrase = lead.slice(0, n).map((t) => t.word).join(" ");
    if (countPhraseOccurrences(all, phrase) <= 1) break;
  }
  return {
    kind: "phrase",
    phrase,
    occurrence: countPhraseOccurrences(before, phrase) + 1,
    offsetSec: 0,
    durationSec: null
  };
}

function shiftTiming(timing: SizzleBeatTiming, bySec: number): SizzleBeatTiming {
  if (timing.kind !== "offset") return timing;
  return {
    kind: "offset",
    startSec: round3(Math.max(0, timing.startSec + bySec)),
    endSec: timing.endSec === null ? null : round3(Math.max(0, timing.endSec + bySec))
  };
}

function bumpOccurrence(timing: SizzleBeatTiming, by: number): SizzleBeatTiming {
  if (timing.kind !== "phrase" || by === 0) return timing;
  return { ...timing, occurrence: Math.max(1, (timing.occurrence ?? 1) + by) };
}

/**
 * Merge scene `sceneId` into the scene before it (both sequence scenes).
 * Narration concatenates; the merged-in clips follow the previous scene's
 * clips. The boundary clip (the merged-in scene's first) is pinned to the
 * first words of its narration — the moment the merged narration reaches
 * them — and takes the former scene→scene transition as its clip
 * transition, so the cut looks the same. Phrase occurrences are re-counted
 * past the previous text; offsets shift by `prevDurationSec` (the previous
 * scene's resolved or estimated length — a best effort the user can
 * re-fit). Returns the input when there is nothing to merge into.
 */
export function mergeSceneIntoPrevious(
  scenes: SizzleScene[],
  sceneId: string,
  ctx: { prevDurationSec: number }
): SizzleScene[] {
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index <= 0) return scenes;
  const prev = scenes[index - 1]!;
  const scene = scenes[index]!;
  if (prev.kind !== "sequence" || scene.kind !== "sequence") return scenes;
  const prevText = (prev.narration ?? prev.scriptLine).trim();
  const text = (scene.narration ?? scene.scriptLine).trim();
  const narration = [prevText, text].filter((t) => t.length > 0).join(" ");
  const shiftSec = Math.max(0, ctx.prevDurationSec);
  const moved = (scene.beats ?? []).map((beat, i): SizzleSequenceBeat => {
    const occurrenceBump =
      beat.timing.kind === "phrase" ? countPhraseOccurrences(pseudoWordsFromText(prevText), beat.timing.phrase) : 0;
    let timing = bumpOccurrence(shiftTiming(beat.timing, shiftSec), occurrenceBump);
    if (i === 0) {
      // The boundary: where the merged-in narration begins.
      timing = leadingPhraseAnchor(prevText, text) ?? { kind: "offset", startSec: round3(shiftSec), endSec: null };
    }
    return {
      ...beat,
      timing,
      transition: i === 0 ? scene.transition : beat.transition
    };
  });
  const merged: SizzleScene = {
    ...prev,
    scriptLine: narration,
    narration,
    beats: normalizeSizzleSequenceBeatContinuity([...(prev.beats ?? []), ...moved])
  };
  return scenes.flatMap((s, i) => (i === index - 1 ? [merged] : i === index ? [] : [s]));
}

/**
 * Split a RESOLVED sequence scene at `splitSec` (scene-local): the script
 * divides at the boundary of the word spoken there, clips starting before
 * it stay, the rest move to a new scene that cuts in. Phrase occurrences
 * in the new scene drop by their count before the split; offsets rebase
 * to the new zero. Needs the scene's resolved `words` (nothing is
 * fabricated); returns the input when a side would be empty or the
 * split is not inside the narration.
 */
export function splitSceneAtSec(
  scenes: SizzleScene[],
  sceneId: string,
  splitSec: number,
  ctx: { words: readonly SizzleWordTiming[]; clipStartsSec: readonly number[] }
): SizzleScene[] {
  const index = scenes.findIndex((s) => s.id === sceneId);
  if (index < 0) return scenes;
  const scene = scenes[index]!;
  if (scene.kind !== "sequence" || ctx.words.length === 0) return scenes;
  const beats = scene.beats ?? [];
  if (beats.length < 2 || ctx.clipStartsSec.length !== beats.length) return scenes;
  // The first word spoken at or after the split opens the new scene.
  const wordAfter = ctx.words.findIndex((w) => w.startSec >= splitSec);
  if (wordAfter <= 0) return scenes; // at the very start (or past every word): nothing to split off
  const keep = beats.filter((_, i) => ctx.clipStartsSec[i]! < splitSec);
  const move = beats.filter((_, i) => ctx.clipStartsSec[i]! >= splitSec);
  if (keep.length === 0 || move.length === 0) return scenes;
  const text = scene.narration ?? scene.scriptLine;
  const [textA, textB] = splitTextAtWord(text, wordAfter);
  const wordsBefore = ctx.words.slice(0, wordAfter);
  const rebased = move.map((beat, i): SizzleSequenceBeat => {
    if (i === 0) return { ...beat, timing: { kind: "auto" } }; // the new scene's clip 0 is pinned at 0
    const drop = beat.timing.kind === "phrase" ? countPhraseOccurrences(wordsBefore, beat.timing.phrase) : 0;
    return { ...beat, timing: bumpOccurrence(shiftTiming(beat.timing, -splitSec), -drop) };
  });
  const first: SizzleScene = {
    ...scene,
    scriptLine: textA,
    narration: textA,
    beats: normalizeSizzleSequenceBeatContinuity(keep)
  };
  const fresh = newSizzleSequenceScene([], { narration: textB, transition: "cut" });
  const second: SizzleScene = {
    ...fresh,
    captureId: rebased[0]?.captureId ?? "",
    beats: normalizeSizzleSequenceBeatContinuity(rebased)
  };
  return scenes.flatMap((s, i) => (i === index ? [first, second] : [s]));
}

/** Split `text` before its `wordIndex`-th word (the shared tokenizer's
 *  words, so the index lines up with transcript word counts as closely as
 *  a script and its transcript can). Punctuation stays with its word. */
export function splitTextAtWord(text: string, wordIndex: number): [string, string] {
  let seen = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}'’]+/gu)) {
    if (normalizeWord(match[0]).length === 0) continue;
    if (seen === wordIndex) {
      const at = match.index ?? 0;
      return [text.slice(0, at).trimEnd(), text.slice(at).trimStart()];
    }
    seen += 1;
  }
  return [text.trimEnd(), ""];
}

/**
 * Re-fit anchors (plan §4.2): the resolved narration changed length and
 * offset-anchored clips exist — scale every offset by `toSec / fromSec`.
 * Explicit, never automatic; phrase anchors follow the words on their own
 * and auto clips re-flow. Returns the input when nothing is scalable.
 */
export function refitSceneOffsets(
  scenes: SizzleScene[],
  sceneId: string,
  fromSec: number,
  toSec: number
): SizzleScene[] {
  if (!(fromSec > 0) || !(toSec > 0)) return scenes;
  const ratio = toSec / fromSec;
  let changed = false;
  const next = scenes.map((scene) => {
    if (scene.id !== sceneId || scene.kind !== "sequence" || scene.beats === undefined) return scene;
    const beats = scene.beats.map((beat): SizzleSequenceBeat => {
      if (beat.timing.kind !== "offset") return beat;
      changed = true;
      return {
        ...beat,
        timing: {
          kind: "offset",
          startSec: round3(beat.timing.startSec * ratio),
          endSec: beat.timing.endSec === null ? null : round3(beat.timing.endSec * ratio)
        }
      };
    });
    return { ...scene, beats };
  });
  return changed ? next : scenes;
}

/** Any offset-anchored clip in the scene (the only kind re-fit touches). */
export function sceneHasOffsetAnchors(scene: SizzleScene): boolean {
  return scene.kind === "sequence" && (scene.beats ?? []).some((b) => b.timing.kind === "offset");
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
