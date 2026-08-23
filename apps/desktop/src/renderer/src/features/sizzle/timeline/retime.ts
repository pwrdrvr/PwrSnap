// Drag → timing math for the sizzle timeline (plan §4.4, "pin only what
// you touch"). Pure: no React, no DOM.
//
// In the sequence model a clip is a START anchor, and a non-final clip runs
// until the next clip's start (continuity). So "move clip N" and "drag the
// boundary between N−1 and N" are the SAME operation — pin N's start — and
// a drag never touches a neighbour: anchored neighbours keep their time,
// auto neighbours re-flow (`distributeSequenceBeatStarts`, the planner's
// own distributor). The only end a user can set directly is the final
// clip's. Clip 0 is pinned at 0 and cannot be dragged off it.
//
// A drop is never quantized: with a transcript the clip anchors to the
// nearest word PLUS the residual (`offsetSec = dropSec − word.startSec`, the
// field `resolvePhraseTiming` already applies), so a clip can sit between
// two words at 4× zoom without jumping back on release. Without a
// transcript it is an `offset` — the fallback, never the first choice.

import {
  distributeSequenceBeatStarts,
  normalizeSizzleSequenceBeatContinuity,
  type SizzleBeatTiming,
  type SizzleSequenceBeat,
  type SizzleWordTiming
} from "@pwrsnap/shared";
import { MIN_RANGE_SEC } from "../../shared/video-range";
import { anchorTimingForWord, nearestWordAnchor } from "./anchor";
import type { TimelineSceneRegion } from "./timeline-model";

export type DragKind = "start" | "end";

export type DragBounds = { minSec: number; maxSec: number };

/** What a finished drag hands the editor (scene-local seconds). */
export type TimelineDragCommit = {
  sceneId: string;
  beatId: string;
  index: number;
  kind: DragKind;
  /** The dropped start (`kind: "start"`) or end (`kind: "end"`). */
  sec: number;
  /** The clip's window BEFORE the drag, for the parts that stay put. */
  clipStartSec: number;
  clipEndSec: number;
};

/** Scene-local range clip `index`'s start may take. Every clip — the auto
 *  clips that re-flow on either side included — keeps `MIN_RANGE_SEC`: the
 *  previous ANCHOR (clip 0 counts, pinned at 0) and the next anchor (or the
 *  scene end) bound it, less one slice per clip in between. */
export function clipStartDragBounds(scene: TimelineSceneRegion, index: number): DragBounds {
  const clips = scene.clips;
  let prevIndex = 0;
  for (let i = index - 1; i > 0; i -= 1) {
    if (clips[i]!.anchored) {
      prevIndex = i;
      break;
    }
  }
  let nextIndex = clips.length;
  for (let i = index + 1; i < clips.length; i += 1) {
    if (clips[i]!.anchored) {
      nextIndex = i;
      break;
    }
  }
  const prevTime = clips[prevIndex]?.localStartSec ?? 0;
  const nextTime = nextIndex < clips.length ? clips[nextIndex]!.localStartSec : scene.durationSec;
  const minSec = prevTime + (index - prevIndex) * MIN_RANGE_SEC;
  const maxSec = nextTime - (nextIndex - index) * MIN_RANGE_SEC;
  return { minSec, maxSec: Math.max(minSec, maxSec) };
}

/** The final clip's end may move between its start + `MIN_RANGE_SEC` and
 *  the scene end. */
export function finalEndDragBounds(scene: TimelineSceneRegion): DragBounds {
  const last = scene.clips.at(-1);
  const minSec = (last?.localStartSec ?? 0) + MIN_RANGE_SEC;
  return { minSec, maxSec: Math.max(minSec, scene.durationSec) };
}

export function clampToBounds(sec: number, bounds: DragBounds): number {
  return Math.min(bounds.maxSec, Math.max(bounds.minSec, sec));
}

/** Live preview while dragging clip `index`'s start to `targetSec`: the
 *  scene's clip starts with that clip anchored there — anchored clips keep
 *  their time, auto clips re-flow — from the SAME distributor the planner
 *  uses, so what the drag shows is what the commit produces. */
export function previewClipStarts(scene: TimelineSceneRegion, index: number, targetSec: number): number[] {
  const anchors = scene.clips.map((clip, i) =>
    i === index ? targetSec : clip.anchored ? clip.localStartSec : null
  );
  return distributeSequenceBeatStarts(anchors, scene.durationSec);
}

/** Commit a start drag: clip `index` pinned at `targetSec`, nothing else
 *  touched. Clip 0 is never moved (the same array comes back). A final
 *  clip's explicit end, if it has one, stays where it was — the user set
 *  it; only the start moved. */
export function applyClipStartDrag(
  beats: SizzleSequenceBeat[],
  index: number,
  targetSec: number,
  ctx: { words: readonly SizzleWordTiming[]; clipEndSec: number }
): SizzleSequenceBeat[] {
  if (index <= 0 || index >= beats.length) return beats;
  const beat = beats[index]!;
  const isFinal = index === beats.length - 1;
  const keepsEnd =
    isFinal &&
    ((beat.timing.kind === "offset" && beat.timing.endSec !== null) ||
      (beat.timing.kind === "phrase" && beat.timing.durationSec !== null));
  let timing = pinTiming(ctx.words, targetSec);
  if (keepsEnd) timing = withEnd(timing, targetSec, ctx.clipEndSec);
  return normalizeSizzleSequenceBeatContinuity(
    beats.map((b, i) => (i === index ? { ...b, timing } : b))
  );
}

/** Commit a final-end drag. An auto final clip first gets pinned at its
 *  current start — it needs a timing to carry an end, and pinning the clip
 *  being dragged is "what you touch". Dragging the end back to the scene
 *  end clears it: the clip runs to the end again (an auto clip is then
 *  left exactly as it was). */
export function applyFinalEndDrag(
  beats: SizzleSequenceBeat[],
  targetEndSec: number,
  ctx: { words: readonly SizzleWordTiming[]; clipStartSec: number; durationSec: number }
): SizzleSequenceBeat[] {
  const index = beats.length - 1;
  if (index < 0) return beats;
  const beat = beats[index]!;
  const atEnd = targetEndSec >= ctx.durationSec - 0.05;
  if (atEnd) {
    if (beat.timing.kind === "auto") return beats;
    const cleared: SizzleBeatTiming =
      beat.timing.kind === "offset"
        ? { ...beat.timing, endSec: null }
        : { ...beat.timing, durationSec: null };
    return beats.map((b, i) => (i === index ? { ...b, timing: cleared } : b));
  }
  // A lone clip (index 0) is pinned at 0 by the planner whatever its
  // timing says; an offset at 0 carries the end without inventing a phrase.
  const base: SizzleBeatTiming =
    beat.timing.kind !== "auto"
      ? beat.timing
      : index === 0
        ? { kind: "offset", startSec: 0, endSec: null }
        : pinTiming(ctx.words, ctx.clipStartSec);
  const timing = withEnd(base, ctx.clipStartSec, targetEndSec);
  return beats.map((b, i) => (i === index ? { ...b, timing } : b));
}

/** Nearest word + residual when there is a transcript; an offset when not. */
function pinTiming(words: readonly SizzleWordTiming[], sec: number): SizzleBeatTiming {
  const near = nearestWordAnchor(words, sec);
  if (near === null) return { kind: "offset", startSec: round3(sec), endSec: null };
  return anchorTimingForWord(words, near.wordIndex, round3(near.offsetSec));
}

function withEnd(timing: SizzleBeatTiming, startSec: number, endSec: number): SizzleBeatTiming {
  const end = Math.max(startSec + MIN_RANGE_SEC, endSec);
  if (timing.kind === "offset") return { ...timing, endSec: round3(end) };
  if (timing.kind === "phrase") return { ...timing, durationSec: round3(end - startSec) };
  return timing;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
