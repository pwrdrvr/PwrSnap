// Click a word → a `phrase` anchor (plan §4.3). Pure.
//
// Writing `{ kind: "phrase", phrase: "<that one word>" }` is wrong for
// common words — "the" resolves to occurrence 1 forever. So: start with
// words[i], extend RIGHTWARD until the phrase is unique in the transcript
// or reaches MAX_ANCHOR_WORDS, and set `occurrence` from the ordinal of
// the match that starts at i. Uniqueness is judged by the SAME matcher the
// planner resolves with (`findPhraseOccurrences`, shared), so what the
// ribbon writes is exactly what `resolvePhraseTiming` will find.
//
// `offsetSec` is the residual past the word's start. A click snaps to the
// word (0); a drag (plan §4.4) stores the nearest word + residual so a
// clip can sit between words. Either way the anchor follows the words
// across a re-synthesis.

import {
  findPhraseOccurrences,
  type SizzleBeatTiming,
  type SizzleWordTiming
} from "@pwrsnap/shared";

export const MAX_ANCHOR_WORDS = 5;

export type PhraseAnchorTiming = Extract<SizzleBeatTiming, { kind: "phrase" }>;

export function anchorTimingForWord(
  words: readonly SizzleWordTiming[],
  wordIndex: number,
  offsetSec = 0
): PhraseAnchorTiming {
  const first = words[wordIndex];
  if (first === undefined) {
    throw new RangeError(`anchorTimingForWord: no word at index ${wordIndex}`);
  }
  let chosen: { phrase: string; occurrence: number } | null = null;
  for (let n = 1; n <= MAX_ANCHOR_WORDS && wordIndex + n <= words.length; n += 1) {
    const phrase = words
      .slice(wordIndex, wordIndex + n)
      .map((w) => w.word)
      .join(" ");
    const starts = findPhraseOccurrences(words, phrase);
    const ordinal = starts.indexOf(wordIndex);
    // The phrase must match at its own position (a pathological token
    // could fail to round-trip through normalization); otherwise extend.
    if (ordinal === -1) continue;
    chosen = { phrase, occurrence: ordinal + 1 };
    if (starts.length === 1) break; // unique — stop extending
  }
  if (chosen === null) {
    // Every prefix failed to match at its own position — fall back to the
    // bare word with occurrence 1 so the planner at least has something
    // to try; it degrades to auto with a warning if it cannot resolve.
    chosen = { phrase: first.word, occurrence: 1 };
  }
  return {
    kind: "phrase",
    phrase: chosen.phrase,
    occurrence: chosen.occurrence,
    offsetSec: roundSec(offsetSec),
    durationSec: null
  };
}

/** The word whose start is nearest to `sec` (scene-local), plus the
 *  residual — what a drag stores so the drop position is not quantized. */
export function nearestWordAnchor(
  words: readonly SizzleWordTiming[],
  sec: number
): { wordIndex: number; offsetSec: number } | null {
  if (words.length === 0) return null;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  words.forEach((w, i) => {
    const d = Math.abs(w.startSec - sec);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return { wordIndex: best, offsetSec: roundSec(sec - words[best]!.startSec) };
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
