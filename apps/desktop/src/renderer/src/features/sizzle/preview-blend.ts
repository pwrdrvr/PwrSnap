// Preview fidelity math (plan §4.7 / PR 7). Pure: which beat the stage
// shows at a scene time, whether the NEXT beat's transition is in
// progress, and the Ken Burns zoom for image beats — each mirroring what
// the export does, so the preview is good enough to judge a timing
// decision (explicitly not pixel parity with ffmpeg).
//
// What the export does, and what is mirrored here:
//
// - A fade-like transition INTO beat N overlaps the `d` seconds BEFORE
//   N's audio start: the planner extends N's visual by `d` at its head
//   (`durationSec = audio + overlap`, sequence-planner.ts) and the
//   composer's xfade sits at `offset = chainEnd − d`. So on the scene axis
//   the incoming beat becomes visible at `N.startSec − d` and is fully in
//   by `N.startSec`; N's video / Ken Burns run from that earlier head.
// - Image beats get zoompan: a linear zoom 1.0 → 1.10 on even inputs and
//   1.10 → 1.0 on odd ones, centered (composer.ts `directionIn`).

import {
  sizzleTransitionDurationSec,
  sizzleTransitionType,
  type SizzleSequencePreviewBeat,
  type SizzleTransition,
  type SizzleTransitionType
} from "@pwrsnap/shared";

export type KenBurnsDirection = "in" | "out";

// NOTE: the zoom RANGE is not a constant here. The stage animates Ken Burns
// with the CSS keyframes `szl-kb-in` / `szl-kb-out` (sizzle.css), which carry
// the 1.0 ↔ 1.10 the composer's zoompan uses. A TS constant would have been a
// second, unenforced copy — the previous one was exercised only by its own
// unit test and could drift from the CSS without failing anything.

/** Even clips zoom in, odd clips zoom out (the composer's input parity). */
export function kenBurnsDirection(index: number): KenBurnsDirection {
  return index % 2 === 0 ? "in" : "out";
}

/** Seconds a fade-like transition INTO a beat overlaps the previous beat:
 *  0 for a cut / none, the transition's duration otherwise. Beat 0 has
 *  nothing before it. Mirrors `transitionOverlapDurationSec` (planner). */
export function transitionOverlapSec(transition: SizzleTransition, index: number): number {
  if (index <= 0) return 0;
  const type = sizzleTransitionType(transition);
  if (type === "cut" || type === "none") return 0;
  return Math.max(0, sizzleTransitionDurationSec(transition));
}

/** The span during which a beat's VISUAL is on stage: its audio window,
 *  extended at the head by the transition into it. Video playback and Ken
 *  Burns progress run over this span, as they do in the export. */
export function beatVisualWindow(
  beat: Pick<SizzleSequencePreviewBeat, "startSec" | "endSec" | "transition">,
  index: number
): { startSec: number; endSec: number } {
  const overlap = transitionOverlapSec(beat.transition, index);
  return { startSec: Math.max(0, beat.startSec - overlap), endSec: beat.endSec };
}

export type StageBlend = {
  /** Index of the INCOMING beat (the one being transitioned into). */
  incomingIndex: number;
  type: SizzleTransitionType;
  durationSec: number;
  /** Scene time the transition window opens (incoming start − duration). */
  startSec: number;
  /** 0 at the window's open, 1 when the incoming beat fully owns the stage. */
  progress: number;
};

export type StageFrame = {
  /** Index of the beat that owns the stage (the outgoing one while a blend
   *  runs); -1 with no beats. */
  activeIndex: number;
  /** Non-null while the next beat's fade-like transition is in progress. */
  blend: StageBlend | null;
};

/** What the stage shows at `timeSec`: the active beat, and — in the last
 *  `d` seconds before a beat with a fade-like transition — that next beat
 *  blending in. A cut has no window; the stage just switches at the start. */
export function stageFrameAt(
  beats: readonly Pick<SizzleSequencePreviewBeat, "startSec" | "endSec" | "transition">[],
  timeSec: number
): StageFrame {
  if (beats.length === 0) return { activeIndex: -1, blend: null };
  let activeIndex = beats.findIndex((b) => timeSec >= b.startSec && timeSec < b.endSec);
  if (activeIndex < 0) activeIndex = timeSec < beats[0]!.startSec ? 0 : beats.length - 1;
  const nextIndex = activeIndex + 1;
  const next = beats[nextIndex];
  if (next === undefined) return { activeIndex, blend: null };
  const d = transitionOverlapSec(next.transition, nextIndex);
  if (d <= 0) return { activeIndex, blend: null };
  const windowStart = next.startSec - d;
  if (timeSec < windowStart) return { activeIndex, blend: null };
  const progress = Math.min(1, Math.max(0, (timeSec - windowStart) / d));
  return {
    activeIndex,
    blend: {
      incomingIndex: nextIndex,
      type: sizzleTransitionType(next.transition),
      durationSec: d,
      startSec: windowStart,
      progress
    }
  };
}
