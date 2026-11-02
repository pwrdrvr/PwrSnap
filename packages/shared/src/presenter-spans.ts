// A recording's presenter can change over time. The recording carries one
// presenter (`video.avatar`) and a list of SPANS, each a stretch of source
// time with its own presenter. Wherever no span covers the moment, the
// recording's presenter shows.
//
// Spans are kept apart from the edit's segments on purpose. The person
// gives a PIECE its own presenter (the stretch between two splits), and
// the span stores that piece's times. Splitting inside it later leaves
// both halves with that presenter; joining two pieces leaves each half
// with what it had. Nothing about the trim, the cuts or the agents' edit
// tools has to know presenters exist.
//
// Everything here is in source seconds, the same clock as the segments,
// the camera track and the composition in main, so no consumer converts.

import type { AvatarStyle, PresenterSpan } from "./camera";
import { PRESENTER_SPANS_MAX } from "./camera";

/** Spans shorter than this are dropped, the edit model's minimum. */
const MIN_SPAN_SEC = 0.1;
const EPS = 0.0005;

/** The span showing at `t` (a boundary belongs to the span after it). */
export function presenterSpanAt(spans: readonly PresenterSpan[] | undefined, t: number): PresenterSpan | null {
  if (!spans) return null;
  for (const span of spans) if (t >= span.start - EPS && t < span.end - EPS) return span;
  return null;
}

/** The stored presenter at `t`: its span's, else the recording's. */
export function storedPresenterAt(
  base: AvatarStyle | null | undefined,
  spans: readonly PresenterSpan[] | undefined,
  t: number
): AvatarStyle | null | undefined {
  return presenterSpanAt(spans, t)?.avatar ?? base;
}

/**
 * Sorted, clamped to `[0, duration]`, overlaps resolved in favour of the
 * later entry in the input (the newest write), slivers dropped, capped.
 */
export function normalizePresenterSpans(
  spans: readonly PresenterSpan[],
  durationSec: number
): PresenterSpan[] {
  let out: PresenterSpan[] = [];
  for (const raw of spans) {
    const start = Math.max(0, Math.min(raw.start, durationSec));
    const end = Math.max(0, Math.min(raw.end, durationSec));
    if (end - start < MIN_SPAN_SEC) continue;
    out = [...subtract(out, start, end), { start, end, avatar: raw.avatar }];
  }
  return out
    .filter((span) => span.end - span.start >= MIN_SPAN_SEC)
    .sort((a, b) => a.start - b.start)
    .slice(0, PRESENTER_SPANS_MAX);
}

/**
 * `range` gets its own presenter (`avatar`), replacing whatever spans
 * covered any of it. `null` gives the range back to the recording's
 * presenter.
 */
export function withPresenterSpan(
  spans: readonly PresenterSpan[] | undefined,
  range: { start: number; end: number },
  avatar: AvatarStyle | null,
  durationSec: number
): PresenterSpan[] {
  const rest = subtract(spans ?? [], range.start, range.end);
  return normalizePresenterSpans(
    avatar === null ? rest : [...rest, { start: range.start, end: range.end, avatar }],
    durationSec
  );
}

/** Every span's presenter run through `edit` — an "all pieces" change. */
export function mapPresenterSpans(
  spans: readonly PresenterSpan[] | undefined,
  edit: (avatar: AvatarStyle) => AvatarStyle
): PresenterSpan[] {
  return (spans ?? []).map((span) => ({ ...span, avatar: edit(span.avatar) }));
}

export function presenterSpansEqual(
  a: readonly PresenterSpan[] | undefined,
  b: readonly PresenterSpan[] | undefined
): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function subtract(spans: readonly PresenterSpan[], start: number, end: number): PresenterSpan[] {
  const out: PresenterSpan[] = [];
  for (const span of spans) {
    if (span.end <= start + EPS || span.start >= end - EPS) {
      out.push(span);
      continue;
    }
    if (span.start < start - EPS) out.push({ ...span, end: start });
    if (span.end > end + EPS) out.push({ ...span, start: end });
  }
  return out;
}
