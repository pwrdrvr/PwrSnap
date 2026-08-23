import { describe, expect, test } from "vitest";
import { resolvePhraseTiming, type SizzleWordTiming } from "@pwrsnap/shared";
import { anchorTimingForWord, MAX_ANCHOR_WORDS, nearestWordAnchor } from "../anchor";

// A transcript with deliberate repeats: "the" ×3, "Library" ×2, and the
// two-word run "the Library" ×2 so a single-word extension is not enough.
const SCRIPT =
  "Open the Library to find the capture. The Library keeps every capture, so open the Library again.";
const WORDS: SizzleWordTiming[] = SCRIPT.split(" ").map((word, index) => ({
  index,
  word,
  normalized: word.toLowerCase().replace(/[^a-z0-9]/g, ""),
  startSec: index * 0.4,
  endSec: index * 0.4 + 0.3
}));
const wordIndex = (word: string, nth = 1): number => {
  let seen = 0;
  for (const w of WORDS) {
    if (w.word === word) {
      seen += 1;
      if (seen === nth) return w.index;
    }
  }
  throw new Error(`no ${word}`);
};

describe("anchorTimingForWord", () => {
  test("a unique word anchors as itself, occurrence 1", () => {
    const t = anchorTimingForWord(WORDS, wordIndex("find"));
    expect(t).toEqual({ kind: "phrase", phrase: "find", occurrence: 1, offsetSec: 0, durationSec: null });
  });

  test("a repeated word extends rightward until the phrase is unique", () => {
    // 2nd "the" (index 5) → "the capture." is unique (the other "capture,"
    // is preceded by "every").
    const t = anchorTimingForWord(WORDS, wordIndex("the", 2));
    expect(t.phrase).toBe("the capture.");
    expect(t.occurrence).toBe(1);
  });

  test("when the extension is still ambiguous, occurrence disambiguates", () => {
    // 3rd "the" (index 15) → "the Library" occurs twice (index 1 and 15)
    // → extends: "the Library again." is unique.
    const t = anchorTimingForWord(WORDS, wordIndex("the", 3));
    expect(t.phrase).toBe("the Library again.");
    expect(t.occurrence).toBe(1);
    // 1st "the" (index 1) → "the Library" (×2) → "the Library to" is unique.
    const first = anchorTimingForWord(WORDS, wordIndex("the", 1));
    expect(first.phrase).toBe("the Library to");
    expect(first.occurrence).toBe(1);
  });

  test("never extends past MAX_ANCHOR_WORDS, and then relies on occurrence", () => {
    const repeated = "a b c d e f a b c d e f g".split(" ");
    const words: SizzleWordTiming[] = repeated.map((word, index) => ({
      index,
      word,
      normalized: word,
      startSec: index,
      endSec: index + 0.5
    }));
    // Second "a" (index 6): "a b c d e" occurs twice; the 5-word cap stops
    // the extension, so occurrence 2 picks this one.
    const t = anchorTimingForWord(words, 6);
    expect(t.phrase.split(" ")).toHaveLength(MAX_ANCHOR_WORDS);
    expect(t.occurrence).toBe(2);
  });

  test("round-trips through the planner's matcher: the anchor resolves to the clicked word", () => {
    for (const w of WORDS) {
      const t = anchorTimingForWord(WORDS, w.index);
      const resolved = resolvePhraseTiming(
        { words: WORDS, quality: "precise", warnings: [] },
        { phrase: t.phrase, occurrence: t.occurrence, offsetSec: t.offsetSec, durationSec: t.durationSec }
      );
      expect(resolved, `word ${w.index} "${w.word}"`).not.toBeNull();
      expect(resolved!.wordStartIndex).toBe(w.index);
      expect(resolved!.startSec).toBeCloseTo(w.startSec, 3);
    }
  });

  test("a residual offset rides along (drags store nearest word + residual, not a quantized time)", () => {
    const t = anchorTimingForWord(WORDS, wordIndex("find"), 0.137);
    expect(t.offsetSec).toBe(0.137);
    const resolved = resolvePhraseTiming(
      { words: WORDS, quality: "precise", warnings: [] },
      { phrase: t.phrase, occurrence: t.occurrence, offsetSec: t.offsetSec }
    );
    expect(resolved!.startSec).toBeCloseTo(WORDS[wordIndex("find")]!.startSec + 0.137, 3);
  });

  test("nearestWordAnchor picks the closest word start and keeps the residual", () => {
    // Word 4 starts at 1.6 s; 1.75 s is nearest to it with +0.15 residual.
    expect(nearestWordAnchor(WORDS, 1.75)).toEqual({ wordIndex: 4, offsetSec: 0.15 });
    // 1.85 s is nearer to word 5 (2.0) → −0.15 residual.
    expect(nearestWordAnchor(WORDS, 1.85)).toEqual({ wordIndex: 5, offsetSec: -0.15 });
    expect(nearestWordAnchor([], 1)).toBeNull();
  });
});
