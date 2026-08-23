// Phrase → transcript matching for Sizzle `phrase` beat anchors.
//
// Lives in @pwrsnap/shared so the main-process planner (render + preview)
// and the renderer's timeline resolve a phrase against the SAME words with
// the SAME fuzzy rules — if the two ever disagreed, a clip would sit at
// one time in the editor and another in the export. Pure: no I/O, no
// Node, no DOM.
//
// Matching is tolerant of the ways a transcript and a typed phrase drift:
// case, punctuation, diacritics (normalized away), and contractions —
// "it's" in the script matches "it is" in the transcript and vice versa,
// via compacted per-token variants compared as a single string.

import type { SizzleResolvedPhraseTiming, SizzleSpeechTiming, SizzleWordTiming } from "./protocol";

export type SizzlePhraseQuery = {
  phrase: string;
  occurrence?: number | null;
  offsetSec?: number;
  durationSec?: number | null;
};

export type SizzleWordToken = { word: string; normalized: string };

export function normalizeWord(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

export function tokenizeWords(text: string): SizzleWordToken[] {
  return [...text.matchAll(/[\p{L}\p{N}'’]+/gu)]
    .map((match) => {
      const word = match[0];
      return { word, normalized: normalizeWord(word) };
    })
    .filter((word) => word.normalized.length > 0);
}

/**
 * Find the `occurrence`-th (1-based, default 1) match of `phrase` in the
 * timing's words and return its window, shifted by `offsetSec` and
 * optionally given an explicit `durationSec`. Null when the phrase does
 * not occur that many times — the planner then degrades the beat to auto.
 */
export function resolvePhraseTiming(
  timing: {
    words: ReadonlyArray<SizzleWordTiming>;
    quality: SizzleSpeechTiming["quality"];
    warnings: SizzleSpeechTiming["warnings"];
  },
  args: SizzlePhraseQuery
): SizzleResolvedPhraseTiming | null {
  const phraseTokens = tokenizeWords(args.phrase);
  if (phraseTokens.length === 0) return null;
  const phraseNormalized = phraseTokens.map((token) => token.normalized);
  const phraseCompacts = compactVariantsForTokens(phraseTokens);
  const maxPhraseCompactLength = Math.max(...Array.from(phraseCompacts).map((variant) => variant.length));
  const wantedOccurrence = args.occurrence ?? 1;
  let seen = 0;
  for (let i = 0; i < timing.words.length; i++) {
    const matchedWordCount = matchPhraseAt({
      words: timing.words,
      startIndex: i,
      phraseNormalized,
      phraseCompacts,
      maxPhraseCompactLength
    });
    if (matchedWordCount === 0) continue;
    seen++;
    if (seen !== wantedOccurrence) continue;
    const first = timing.words[i]!;
    const last = timing.words[i + matchedWordCount - 1]!;
    const startSec = Math.max(0, first.startSec + (args.offsetSec ?? 0));
    const naturalEndSec = Math.max(startSec + 0.01, last.endSec + (args.offsetSec ?? 0));
    const endSec =
      typeof args.durationSec === "number" && Number.isFinite(args.durationSec) && args.durationSec > 0
        ? startSec + args.durationSec
        : naturalEndSec;
    return {
      startSec: roundSec(startSec),
      endSec: roundSec(endSec),
      quality: timing.quality,
      wordStartIndex: first.index,
      wordEndIndex: last.index,
      matchedText: timing.words.slice(i, i + matchedWordCount).map((word) => word.word).join(" "),
      warnings: timing.warnings
    };
  }
  return null;
}

/**
 * Every word index at which `phrase` matches, under the same matching
 * rules `resolvePhraseTiming` uses (so `occurrence` = position in this
 * list + 1). The word ribbon uses this to pick a phrase long enough to be
 * unique (plan §4.3) so an anchor never silently binds to the wrong "the".
 */
export function findPhraseOccurrences(
  words: ReadonlyArray<SizzleWordTiming>,
  phrase: string
): number[] {
  const phraseTokens = tokenizeWords(phrase);
  if (phraseTokens.length === 0) return [];
  const phraseNormalized = phraseTokens.map((token) => token.normalized);
  const phraseCompacts = compactVariantsForTokens(phraseTokens);
  const maxPhraseCompactLength = Math.max(...Array.from(phraseCompacts).map((variant) => variant.length));
  const starts: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (matchPhraseAt({ words, startIndex: i, phraseNormalized, phraseCompacts, maxPhraseCompactLength }) > 0) {
      starts.push(i);
    }
  }
  return starts;
}

/** How many times `phrase` occurs in the words. */
export function countPhraseOccurrences(
  words: ReadonlyArray<SizzleWordTiming>,
  phrase: string
): number {
  return findPhraseOccurrences(words, phrase).length;
}

function matchPhraseAt(args: {
  words: ReadonlyArray<SizzleWordTiming>;
  startIndex: number;
  phraseNormalized: string[];
  phraseCompacts: Set<string>;
  maxPhraseCompactLength: number;
}): number {
  let exact = true;
  for (let j = 0; j < args.phraseNormalized.length; j++) {
    if (args.words[args.startIndex + j]?.normalized !== args.phraseNormalized[j]) {
      exact = false;
      break;
    }
  }
  if (exact) return args.phraseNormalized.length;

  let candidateCompacts = new Set([""]);
  for (let endIndex = args.startIndex; endIndex < args.words.length; endIndex++) {
    const word = args.words[endIndex]!;
    const wordCompacts = compactVariantsForTokens([
      { word: word.word, normalized: word.normalized }
    ]);
    const next = new Set<string>();
    for (const prefix of candidateCompacts) {
      for (const compact of wordCompacts) {
        const value = prefix + compact;
        if (value.length <= args.maxPhraseCompactLength) next.add(value);
      }
    }
    if (next.size === 0) break;
    candidateCompacts = next;
    if ([...candidateCompacts].some((candidate) => args.phraseCompacts.has(candidate))) {
      return endIndex - args.startIndex + 1;
    }
  }
  return 0;
}

function compactVariantsForTokens(tokens: SizzleWordToken[]): Set<string> {
  let variants = new Set([""]);
  for (const token of tokens) {
    const next = new Set<string>();
    for (const prefix of variants) {
      for (const expansion of contractionTokenVariants(token)) {
        next.add(prefix + expansion.join(""));
      }
    }
    variants = next;
  }
  return variants;
}

function contractionTokenVariants(token: SizzleWordToken): string[][] {
  const variants: string[][] = [[token.normalized]];
  const raw = token.word.normalize("NFKD").toLocaleLowerCase("en-US");
  const add = (parts: string[]): void => {
    const normalized = parts.map((part) => normalizeWord(part)).filter((part) => part.length > 0);
    if (normalized.length === 0) return;
    if (!variants.some((variant) => variant.join("\0") === normalized.join("\0"))) {
      variants.push(normalized);
    }
  };

  if (/^[\p{L}\p{N}]+[’']s$/u.test(raw)) {
    const base = raw.replace(/[’']s$/u, "");
    add([base, "is"]);
    add([base, "has"]);
  }
  if (/^[\p{L}\p{N}]+[’']re$/u.test(raw)) add([raw.replace(/[’']re$/u, ""), "are"]);
  if (/^[\p{L}\p{N}]+[’']ve$/u.test(raw)) add([raw.replace(/[’']ve$/u, ""), "have"]);
  if (/^[\p{L}\p{N}]+[’']ll$/u.test(raw)) add([raw.replace(/[’']ll$/u, ""), "will"]);
  if (/^[\p{L}\p{N}]+[’']m$/u.test(raw)) add([raw.replace(/[’']m$/u, ""), "am"]);
  if (/^[\p{L}\p{N}]+[’']d$/u.test(raw)) {
    const base = raw.replace(/[’']d$/u, "");
    add([base, "had"]);
    add([base, "would"]);
  }

  if (token.normalized === "its") {
    add(["it", "is"]);
    add(["it", "has"]);
  }
  if (token.normalized === "im") add(["i", "am"]);
  if (token.normalized === "youre") add(["you", "are"]);
  if (token.normalized === "theyre") add(["they", "are"]);
  if (token.normalized === "weve") add(["we", "have"]);
  if (token.normalized === "youve") add(["you", "have"]);
  if (token.normalized === "ive") add(["i", "have"]);

  return variants;
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
