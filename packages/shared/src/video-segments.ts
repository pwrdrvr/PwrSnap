// Kept-segment model for a video capture's edit. Pure — shared by main
// (persistence, export, the agent tools), the renderer (timeline,
// playback skipping) and their tests.
//
// A video's edit is an ordered list of KEPT spans in SOURCE time:
//
//     [0 ────── 3.2]  [8.0 ───── 12.5][12.5 ── 20]
//                   ^cut           ^split       ^outer trim to the end
//
//   • Everything outside the list is removed from the export. The space
//     before the first span and after the last is the ordinary in/out
//     trim; a gap between two spans is a CUT.
//   • Two spans may TOUCH (`a.end === b.start`). That is a split with
//     both sides kept: it changes nothing about the export, but it is a
//     boundary the user placed and can cut either side of, so it is
//     persisted rather than merged away.
//   • The timeline never ripples. Every time here is a source time, so
//     the filmstrip, the waveform and the activity lane keep lining up
//     with the recording and a cut is visible as a hatched span in place.
//
// `defaultRange` on `VideoCaptureMetadata` stays the OUTER range (first
// start → last end) so every consumer that only understands one range —
// the sizzle scene seed, older callers of `video:setDefaultRange` — keeps
// working, just without the cuts.
//
// Values are never rounded here. A persisted full-clip span keeps the
// recorder's exact float end, which the export cache key and the
// native-loop check in the stage both compare against; callers that
// produce new times from pointer positions round them themselves.

import type { VideoRange } from "./protocol";

/** Shortest span the model keeps, in seconds. Matches the renderer's
 *  `MIN_RANGE_SEC` and main's `MIN_VIDEO_RANGE_SEC`. */
export const VIDEO_SEGMENT_MIN_SEC = 0.1;

/** Two boundaries closer than this are the same boundary. Half a
 *  millisecond: below the ms rounding every UI path applies, above
 *  float noise. */
export const VIDEO_SEGMENT_EPS_SEC = 0.0005;

/** Tolerance for "this edit is effectively the whole clip" (labels). */
export const VIDEO_FULL_CLIP_EPS_SEC = 0.05;

/** Hard cap on persisted spans. A human never gets near it; it bounds
 *  what a tool call can make the exporter's filter graph carry. */
export const VIDEO_SEGMENTS_MAX = 200;

function minSpan(durationSec: number): number {
  return Math.min(VIDEO_SEGMENT_MIN_SEC, Math.max(durationSec, 0));
}

function clampSec(sec: number, durationSec: number): number {
  return Math.min(Math.max(sec, 0), Math.max(durationSec, 0));
}

/**
 * Canonical form: finite, clamped to `[0, duration]`, sorted, overlaps
 * merged, near-touching boundaries snapped to exactly equal, spans
 * shorter than the minimum dropped, at most `VIDEO_SEGMENTS_MAX` spans.
 *
 * May return `[]` — callers decide whether an empty edit is an error
 * (the bus) or means "the whole clip" (`videoSegmentsOrFull`).
 */
export function normalizeVideoSegments(
  input: readonly VideoRange[],
  durationSec: number
): VideoRange[] {
  const d = Math.max(durationSec, 0);
  const min = minSpan(d);
  const clamped = input
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ start: clampSec(s.start, d), end: clampSec(s.end, d) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: VideoRange[] = [];
  for (const seg of clamped) {
    const prev = out[out.length - 1];
    if (prev !== undefined && seg.start < prev.end - VIDEO_SEGMENT_EPS_SEC) {
      // Overlap — one continuous kept span.
      prev.end = Math.max(prev.end, seg.end);
      continue;
    }
    if (prev !== undefined && seg.start - prev.end <= VIDEO_SEGMENT_EPS_SEC) {
      // Touching — keep the split, but make it exact so every later
      // comparison can use `===`.
      out.push({ start: prev.end, end: Math.max(seg.end, prev.end) });
      continue;
    }
    out.push({ start: seg.start, end: seg.end });
  }
  return out.filter((s) => s.end - s.start >= min - 1e-9).slice(0, VIDEO_SEGMENTS_MAX);
}

/** The normalized edit, or the whole clip when nothing survives. */
export function videoSegmentsOrFull(
  input: readonly VideoRange[] | null | undefined,
  durationSec: number
): VideoRange[] {
  const normalized = input === null || input === undefined ? [] : normalizeVideoSegments(input, durationSec);
  return normalized.length > 0 ? normalized : [{ start: 0, end: Math.max(durationSec, 0) }];
}

/** First start → last end. `segments` must be non-empty. */
export function videoSegmentsOuterRange(segments: readonly VideoRange[]): VideoRange {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined) return { start: 0, end: 0 };
  return { start: first.start, end: last.end };
}

/**
 * What actually exports: touching spans merged into continuous runs.
 * A split with both sides kept disappears here, which is what keeps a
 * split-only edit on the single-range export path and its cache key.
 */
export function videoExportSpans(segments: readonly VideoRange[]): VideoRange[] {
  const out: VideoRange[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev !== undefined && seg.start - prev.end <= VIDEO_SEGMENT_EPS_SEC) {
      prev.end = Math.max(prev.end, seg.end);
    } else {
      out.push({ start: seg.start, end: seg.end });
    }
  }
  return out;
}

/** Seconds that survive into the export. */
export function videoKeptDurationSec(segments: readonly VideoRange[]): number {
  let total = 0;
  for (const span of videoExportSpans(segments)) total += Math.max(0, span.end - span.start);
  return total;
}

/**
 * The removed spans, in order. `outer: true` (default) includes the
 * trimmed head and tail; `false` returns only the interior cuts.
 */
export function videoCuts(
  segments: readonly VideoRange[],
  durationSec: number,
  options: { outer?: boolean } = {}
): VideoRange[] {
  const includeOuter = options.outer ?? true;
  const spans = videoExportSpans(segments);
  const out: VideoRange[] = [];
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined) {
    return includeOuter && durationSec > 0 ? [{ start: 0, end: durationSec }] : [];
  }
  if (includeOuter && first.start > VIDEO_SEGMENT_EPS_SEC) out.push({ start: 0, end: first.start });
  for (let i = 1; i < spans.length; i += 1) {
    out.push({ start: spans[i - 1]!.end, end: spans[i]!.start });
  }
  if (includeOuter && durationSec - last.end > VIDEO_SEGMENT_EPS_SEC) {
    out.push({ start: last.end, end: durationSec });
  }
  return out;
}

/** True when the edit has at least one interior cut. */
export function videoHasCuts(segments: readonly VideoRange[]): boolean {
  return videoExportSpans(segments).length > 1;
}

/** Whole clip, no cuts (within the label tolerance). */
export function isFullClipEdit(segments: readonly VideoRange[], durationSec: number): boolean {
  const spans = videoExportSpans(segments);
  const only = spans[0];
  return (
    spans.length === 1 &&
    only !== undefined &&
    only.start <= VIDEO_FULL_CLIP_EPS_SEC &&
    only.end >= durationSec - VIDEO_FULL_CLIP_EPS_SEC
  );
}

export function videoSegmentsEqual(a: readonly VideoRange[], b: readonly VideoRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false;
  }
  return true;
}

/** Stable string for a set of export spans — the cache-key component
 *  for multi-span exports and the dependency key for React effects. */
export function videoSpansKey(spans: readonly VideoRange[]): string {
  return spans.map((s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`).join(",");
}

// ── edits ───────────────────────────────────────────────────────────

/**
 * Move the OUTER range (the in/out handles) and clip the edit to it.
 * The first span's start and the last span's end follow the handles
 * exactly — dragging the in-point left into trimmed or cut material
 * keeps it, because the handle is where the user put it. Spans pushed
 * wholly outside the range are dropped.
 *
 * Callers dragging a handle should apply this to the snapshot taken at
 * drag start, not to the previous frame's result, so dragging back
 * restores what the drag passed over.
 */
export function withVideoOuterRange(
  segments: readonly VideoRange[],
  range: VideoRange,
  durationSec: number
): VideoRange[] {
  const d = Math.max(durationSec, 0);
  const start = clampSec(range.start, d);
  const end = Math.max(start, clampSec(range.end, d));
  const min = minSpan(d);
  const clipped = segments
    .map((s) => ({ start: Math.max(s.start, start), end: Math.min(s.end, end) }))
    .filter((s) => s.end - s.start >= min - 1e-9);
  if (clipped.length === 0) return [{ start, end }];
  clipped[0]!.start = start;
  clipped[clipped.length - 1]!.end = end;
  const normalized = normalizeVideoSegments(clipped, d);
  return normalized.length > 0 ? normalized : [{ start, end }];
}

/**
 * Split the kept span under `t` into two touching spans. No-op (returns
 * the input) when `t` is in a cut, outside the edit, or closer than the
 * minimum span to an existing boundary.
 */
export function splitVideoSegmentsAt(
  segments: readonly VideoRange[],
  t: number
): VideoRange[] {
  const idx = segments.findIndex(
    (s) => t - s.start >= VIDEO_SEGMENT_MIN_SEC && s.end - t >= VIDEO_SEGMENT_MIN_SEC
  );
  if (idx < 0) return [...segments];
  const seg = segments[idx]!;
  return [
    ...segments.slice(0, idx),
    { start: seg.start, end: t },
    { start: t, end: seg.end },
    ...segments.slice(idx + 1)
  ];
}

/** Remove the split at `boundarySec` (two touching spans become one).
 *  No-op when no split sits there. */
export function joinVideoSegmentsAt(
  segments: readonly VideoRange[],
  boundarySec: number
): VideoRange[] {
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1]!;
    const next = segments[i]!;
    if (
      prev.end === next.start &&
      Math.abs(prev.end - boundarySec) <= VIDEO_SEGMENT_EPS_SEC * 2
    ) {
      return [
        ...segments.slice(0, i - 1),
        { start: prev.start, end: next.end },
        ...segments.slice(i + 1)
      ];
    }
  }
  return [...segments];
}

/** One region of the timeline, for hit-testing and per-piece chips. */
export type VideoPiece =
  | { kind: "kept"; index: number; start: number; end: number }
  | { kind: "cut"; where: "head" | "inner" | "tail"; start: number; end: number };

/** Every region of `[0, duration]` in order: kept spans (one per
 *  segment, splits included) and the removed regions between them. */
export function videoPieces(segments: readonly VideoRange[], durationSec: number): VideoPiece[] {
  const out: VideoPiece[] = [];
  let cursor = 0;
  segments.forEach((seg, index) => {
    if (seg.start - cursor > VIDEO_SEGMENT_EPS_SEC) {
      out.push({ kind: "cut", where: index === 0 ? "head" : "inner", start: cursor, end: seg.start });
    }
    out.push({ kind: "kept", index, start: seg.start, end: seg.end });
    cursor = seg.end;
  });
  if (durationSec - cursor > VIDEO_SEGMENT_EPS_SEC) {
    out.push({
      kind: "cut",
      where: segments.length === 0 ? "head" : "tail",
      start: cursor,
      end: durationSec
    });
  }
  return out;
}

/** The piece containing `t` (a boundary belongs to the piece after it;
 *  the clip end belongs to the last piece). */
export function videoPieceAt(
  segments: readonly VideoRange[],
  durationSec: number,
  t: number
): VideoPiece | null {
  const pieces = videoPieces(segments, durationSec);
  for (const piece of pieces) {
    if (t >= piece.start && t < piece.end) return piece;
  }
  return pieces[pieces.length - 1] ?? null;
}

/**
 * Cut or restore one piece:
 *   • a kept span is removed — unless it is the only one left, since an
 *     edit that keeps nothing cannot export (returns the input);
 *   • a removed region is kept again, as its own span, so the
 *     boundaries on either side survive as splits.
 */
export function toggleVideoPiece(
  segments: readonly VideoRange[],
  durationSec: number,
  piece: VideoPiece
): VideoRange[] {
  if (piece.kind === "kept") {
    if (segments.length <= 1) return [...segments];
    return segments.filter((_, i) => i !== piece.index);
  }
  return normalizeVideoSegments(
    [...segments, { start: piece.start, end: piece.end }],
    durationSec
  );
}

/**
 * Remove `cuts` from the edit. A cut inside a kept span splits it; a
 * cut spanning several removes them. Never returns an empty edit — a
 * cut that would remove everything returns the input unchanged. Use
 * `subtractVideoSpans` to tell that case apart.
 */
export function cutVideoSegments(
  segments: readonly VideoRange[],
  cuts: readonly VideoRange[],
  durationSec: number
): VideoRange[] {
  const remaining = subtractVideoSpans(segments, cuts, durationSec);
  return remaining.length > 0 ? remaining : [...segments];
}

/** `cutVideoSegments` without the guard: `[]` when nothing survives. */
export function subtractVideoSpans(
  segments: readonly VideoRange[],
  cuts: readonly VideoRange[],
  durationSec: number
): VideoRange[] {
  let current: VideoRange[] = segments.map((s) => ({ ...s }));
  for (const cut of cuts) {
    if (!(Number.isFinite(cut.start) && Number.isFinite(cut.end)) || cut.end <= cut.start) continue;
    const next: VideoRange[] = [];
    for (const seg of current) {
      if (cut.end <= seg.start || cut.start >= seg.end) {
        next.push(seg);
        continue;
      }
      if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start });
      if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
    }
    current = next;
  }
  return normalizeVideoSegments(current, durationSec);
}

/** The edit as a caller reasons about it — what is kept, what exports,
 *  what is gone, and how long the result runs. */
export function describeVideoEdit(
  captureId: string,
  durationSec: number,
  segments: readonly VideoRange[]
): {
  captureId: string;
  durationSec: number;
  segments: VideoRange[];
  spans: VideoRange[];
  cuts: VideoRange[];
  keptDurationSec: number;
} {
  return {
    captureId,
    durationSec,
    segments: segments.map((s) => ({ start: s.start, end: s.end })),
    spans: videoExportSpans(segments),
    cuts: videoCuts(segments, durationSec),
    keptDurationSec: Math.round(videoKeptDurationSec(segments) * 1000) / 1000
  };
}

/**
 * Where playback of the edit should be at `t`: `t` itself inside a kept
 * span, the start of the next span when `t` is in a cut or the head,
 * `null` past the end of the edit.
 */
export function nextPlayableVideoTime(segments: readonly VideoRange[], t: number): number | null {
  for (const span of videoExportSpans(segments)) {
    if (t < span.start) return span.start;
    if (t < span.end) return t;
  }
  return null;
}
