// Pure rules for the Burst Review window: which stills are chosen, where
// the strip says "nothing changed here", and how times are written.
//
// Kept apart from the component so the selection rules can be checked
// against a model without rendering anything.

import type { BurstFrame } from "@pwrsnap/shared";

/** Indexes chosen to keep, as a sorted array (stable for React + equality). */
export type Selection = readonly number[];

function normalize(indexes: Iterable<number>): Selection {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

/** Flip one still. Stills already kept as snaps cannot be chosen again. */
export function toggleFrame(selection: Selection, index: number, kept: ReadonlySet<number>): Selection {
  if (kept.has(index)) return selection;
  return selection.includes(index)
    ? selection.filter((i) => i !== index)
    : normalize([...selection, index]);
}

/**
 * ⇧-click / ⇧-arrow: choose every still from `anchor` to `to` inclusive (in
 * strip order, either direction), on top of what is already chosen. Kept
 * stills inside the range are skipped. An anchor that is not in the strip
 * (the strip changed under it) chooses just `to`.
 */
export function selectRange(
  selection: Selection,
  frames: readonly Pick<BurstFrame, "index">[],
  anchor: number,
  to: number,
  kept: ReadonlySet<number>
): Selection {
  const a = frames.findIndex((f) => f.index === anchor);
  const b = frames.findIndex((f) => f.index === to);
  if (b < 0) return selection;
  const [lo, hi] = a < 0 ? [b, b] : a <= b ? [a, b] : [b, a];
  const add = frames.slice(lo, hi + 1).map((f) => f.index).filter((i) => !kept.has(i));
  return normalize([...selection, ...add]);
}

/** `A`: choose every keepable still, or clear when all of them already are. */
export function toggleAll(
  selection: Selection,
  frames: readonly Pick<BurstFrame, "index">[],
  kept: ReadonlySet<number>
): Selection {
  const keepable = frames.map((f) => f.index).filter((i) => !kept.has(i));
  const all = keepable.every((i) => selection.includes(i));
  return all ? [] : normalize(keepable);
}

/** Drop chosen indexes that are no longer keepable (kept, or gone). */
export function reconcileSelection(
  selection: Selection,
  frames: readonly Pick<BurstFrame, "index">[],
  kept: ReadonlySet<number>
): Selection {
  const present = new Set(frames.map((f) => f.index));
  const next = selection.filter((i) => present.has(i) && !kept.has(i));
  return next.length === selection.length ? selection : next;
}

/**
 * The recorder only writes a still when the screen changed, so a long
 * spacing between neighbours means "nothing moved for this long". The
 * strip marks a spacing past 1.5 frame intervals; the value is the time
 * the screen sat still.
 */
export function stillGaps(
  frames: readonly Pick<BurstFrame, "index" | "offsetMs">[],
  fps: number
): Map<number, number> {
  const interval = 1000 / fps;
  const gaps = new Map<number, number>();
  for (let i = 0; i + 1 < frames.length; i++) {
    const gap = frames[i + 1]!.offsetMs - frames[i]!.offsetMs;
    if (gap > interval * 1.5) gaps.set(frames[i]!.index, gap);
  }
  return gaps;
}

/** `12:03:04.512` in the viewer's local time. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--.---";
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** `+1.300 s` — always three decimals, so columns line up. Same words as
 *  main's label (offsets here are never negative: they count from a still
 *  at or before this one). */
export function formatOffset(ms: number): string {
  return `+${(Math.max(0, Math.round(ms)) / 1000).toFixed(3)} s`;
}

/** `0.8 s` for a still-gap marker. */
export function formatGap(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * The label a kept snap will carry: its own clock time and its offset from
 * the FIRST KEPT still (not the first in the ring), so a reader of the kept
 * set sees the spacing between exactly the frames they were sent. Mirrors
 * main's `captureTimeLabel`.
 */
export function stampPreview(
  frame: Pick<BurstFrame, "capturedAt" | "offsetMs">,
  firstKeptOffsetMs: number
): string {
  return `${formatClock(frame.capturedAt)} (${formatOffset(frame.offsetMs - firstKeptOffsetMs)})`;
}
