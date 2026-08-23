// The word ribbon: the narration's words positioned at their SPOKEN times
// on the same axis as the clips. Clicking a word anchors the selected
// clip (or the clip covering that moment) to it. Anchored words are
// underlined in accent with the clip's index badge.
//
// Labels follow a density rule of their own: a word draws its label only
// where it fits before its neighbour on one of three stagger rows; the
// rest are ticks. Anchored words are placed FIRST so an anchor is never
// reduced to a tick. Zoom in to see more.
//
// An ESTIMATED scene has no transcript yet, and nothing is fabricated —
// the lane is empty except for the "Synthesize narration" affordance.

import type { ReactElement } from "react";
import type { TimelineModel, TimelineSceneRegion, TimelineWord } from "./timeline-model";

/** Stagger rows available to labels. Six, not three: a 43 s narration is
 *  ~120 words, and at three rows most of them collapsed into ticks that the
 *  operator described — accurately — as unreadable. The lane is sized to
 *  match in timeline.css. */
export const RIBBON_ROWS = 6;
/** Vertical pitch between stagger rows, in px. */
export const RIBBON_ROW_PITCH_PX = 13;
/** Rough Geist 12 px glyph advance; the real width is measured by layout,
 *  this only decides which labels are attempted. */
const PX_PER_CHAR = 7.1;
const BADGE_PX = 18;
const LABEL_GAP_PX = 8;

export type PlacedWord =
  | { word: TimelineWord; x: number; row: number; tick: false }
  | { word: TimelineWord; x: number; tick: true };

/** Pure: which words get a label, on which row, at which x. A label that
 *  would run past `maxPx` (the lanes' right edge) is a tick instead — an
 *  overflowing label widens the scroll area and puts a scrollbar on a
 *  reel that fits. */
export function layoutRibbonWords(
  words: readonly TimelineWord[],
  pxPerSec: number,
  anchored: ReadonlySet<number>,
  maxPx: number = Number.POSITIVE_INFINITY
): PlacedWord[] {
  const occupied: Array<Array<[number, number]>> = Array.from({ length: RIBBON_ROWS }, () => []);
  const fits = (row: number, x0: number, x1: number): boolean =>
    occupied[row]!.every(([a, b]) => x1 <= a || x0 >= b);
  const place = (word: TimelineWord): PlacedWord => {
    const x0 = word.absStartSec * pxPerSec;
    const x1 = x0 + PX_PER_CHAR * word.word.length + (anchored.has(word.index) ? BADGE_PX : 0) + LABEL_GAP_PX;
    if (x1 > maxPx) return { word, x: x0, tick: true };
    for (let row = 0; row < RIBBON_ROWS; row += 1) {
      if (fits(row, x0, x1)) {
        occupied[row]!.push([x0, x1]);
        return { word, x: x0, row, tick: false };
      }
    }
    return { word, x: x0, tick: true };
  };
  const out: PlacedWord[] = new Array(words.length);
  words.forEach((w, i) => {
    if (anchored.has(w.index)) out[i] = place(w);
  });
  words.forEach((w, i) => {
    if (!anchored.has(w.index)) out[i] = place(w);
  });
  return out;
}

export function WordRibbon({
  model,
  x,
  pxPerSec,
  widthPx,
  visible,
  onClickWord,
  onSynthesize
}: {
  model: TimelineModel;
  x: (sec: number) => number;
  pxPerSec: number;
  /** The lanes' width: no label is drawn past it. */
  widthPx: number;
  /** Project-axis window currently on screen. Layout still runs over EVERY
   *  word — otherwise rows would reshuffle as you scroll — but only the
   *  words inside this window are mounted. A 45 s reel at 8x is ~14,000 px
   *  and several hundred words; without this the DOM carries all of them. */
  visible: { startSec: number; endSec: number };
  /** Click a word: anchor the selected clip (or the clip under that
   *  moment) to it. */
  onClickWord: (scene: TimelineSceneRegion, word: TimelineWord) => void;
  /** The estimated-scene affordance. Synthesizing spends the operator's
   *  TTS credits, so it is ALWAYS an explicit click, never automatic. */
  onSynthesize: (sceneId: string) => void;
}): ReactElement {
  return (
    <div className="szt__lane szt__lane--ribbon" data-testid="sizzle-timeline-ribbon">
      {model.scenes.map((scene) => {
        const left = x(scene.startSec);
        const width = Math.max(0, x(scene.endSec) - left);
        if (!scene.exact || scene.kind !== "sequence") {
          if (scene.kind !== "sequence") return null;
          return (
            <div
              key={scene.sceneId}
              className="szt__ribbon-empty"
              style={{ left: `${left}px`, width: `${width}px` }}
              data-testid={`sizzle-timeline-ribbon-empty-${scene.index}`}
            >
              {width > 300 ? <span className="szt__eyebrow szt__ribbon-hint">No transcript yet</span> : null}
              <button
                type="button"
                className="szt__ribbon-cta"
                onClick={(event) => {
                  event.stopPropagation();
                  onSynthesize(scene.sceneId);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title="Synthesize this scene's narration to get exact timing and anchorable words. Uses your TTS provider."
                data-testid={`sizzle-timeline-synthesize-${scene.index}`}
              >
                Synthesize narration to anchor words
              </button>
            </div>
          );
        }
        const anchoredByWord = new Map<number, number>();
        for (const clip of scene.clips) {
          if (clip.anchored && clip.timing.kind === "phrase") {
            const idx = anchorWordIndexFor(scene, clip.localStartSec, clip.timing.offsetSec);
            if (idx !== null) anchoredByWord.set(idx, clip.index);
          }
        }
        // Unmeasured (0) = no bound yet; the first measured layout applies it.
        const placedAll = layoutRibbonWords(
          scene.words,
          pxPerSec,
          new Set(anchoredByWord.keys()),
          widthPx > 0 ? widthPx : Number.POSITIVE_INFINITY
        );
        // Mount only what is on screen (the layout above already ran over
        // the whole scene, so a word's row is stable while scrolling).
        const placed = placedAll.filter(
          (p) => p.word.absStartSec >= visible.startSec && p.word.absStartSec <= visible.endSec
        );
        return placed.map((p) => {
          const clipIndex = anchoredByWord.get(p.word.index);
          const isAnchor = clipIndex !== undefined;
          if (p.tick) {
            return (
              <button
                key={`${scene.sceneId}:${p.word.index}`}
                type="button"
                className={"szt__wtick" + (isAnchor ? " is-anch" : "")}
                style={{ left: `${p.x}px` }}
                title={p.word.word}
                aria-label={`Anchor to “${p.word.word}”`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClickWord(scene, p.word);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                data-testid={`sizzle-timeline-word-${scene.index}-${p.word.index}`}
                data-tick="true"
              />
            );
          }
          return (
            <button
              key={`${scene.sceneId}:${p.word.index}`}
              type="button"
              className={"szt__word" + (isAnchor ? " is-anch" : "")}
              style={{ left: `${p.x}px`, top: `${4 + p.row * RIBBON_ROW_PITCH_PX}px` }}
              title={isAnchor ? `Clip ${clipIndex + 1} starts here` : `Anchor the selected clip to “${p.word.word}”`}
              onClick={(event) => {
                event.stopPropagation();
                onClickWord(scene, p.word);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              data-testid={`sizzle-timeline-word-${scene.index}-${p.word.index}`}
            >
              {p.word.word}
              {isAnchor ? <span className="szt__badge">{clipIndex + 1}</span> : null}
            </button>
          );
        });
      })}
    </div>
  );
}

/** Which word a resolved phrase anchor sits on: the word whose start is
 *  the clip's start minus its residual offset. */
function anchorWordIndexFor(
  scene: TimelineSceneRegion,
  localStartSec: number,
  offsetSec: number
): number | null {
  const target = localStartSec - offsetSec;
  let best: number | null = null;
  let bestDist = 0.051; // within 50 ms — the planner rounds to 1 ms
  for (const w of scene.words) {
    const d = Math.abs(w.startSec - target);
    if (d < bestDist) {
      bestDist = d;
      best = w.index;
    }
  }
  return best;
}
