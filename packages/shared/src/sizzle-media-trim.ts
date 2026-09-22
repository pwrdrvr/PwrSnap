import type { SizzleMediaTrim, VideoRange } from "./protocol";
import { subtractVideoSpans, videoCuts, videoKeptDurationSec } from "./video-segments";

export function normalizeVideoMediaTrim(args: {
  trim: SizzleMediaTrim | null;
  defaultRange: { start: number; end: number };
  sourceDurationSec: number;
}): SizzleMediaTrim {
  const sourceDurationSec = Math.max(0.05, args.sourceDurationSec);
  const raw = args.trim ?? {
    startSec: args.defaultRange.start,
    endSec: args.defaultRange.end
  };
  const rawStart = Number.isFinite(raw.startSec) ? raw.startSec : args.defaultRange.start;
  const rawEnd = Number.isFinite(raw.endSec) ? raw.endSec : args.defaultRange.end;
  const latestStart = Math.max(0, sourceDurationSec - 0.05);
  const startSec = clamp(rawStart, 0, latestStart);
  const endSec = clamp(rawEnd, startSec + 0.05, sourceDurationSec);
  return {
    startSec: roundSec(startSec),
    endSec: roundSec(endSec)
  };
}

export function mediaTrimWasClamped(
  requested: SizzleMediaTrim | null,
  normalized: SizzleMediaTrim
): boolean {
  return (
    requested !== null &&
    (normalized.startSec !== requested.startSec || normalized.endSec !== requested.endSec)
  );
}

// ── Library cuts inside a clip ─────────────────────────────────────
//
// A video clip in a reel plays its own trim window (`mediaTrim`, source
// seconds). When the capture has been cut in the Library, the clip plays
// that window with the capture's INTERIOR cuts taken out — the same
// footage the Library's own export keeps.
//
// Only interior cuts apply. The clip's trim stays the sole authority over
// where it starts and ends, exactly as before cuts existed, so a reel is
// not re-trimmed behind its back when someone later moves the Library's
// in/out handles, and a capture with no cuts plays one span equal to the
// trim — the render it always had.
//
// The cuts are read from the capture at plan time, not copied into the
// clip: cut idle time in the Library and every reel using that capture
// tightens up on its next preview or render. A clip that wants the
// removed footage back opts out with `useCaptureCuts: false`.

/**
 * Whether a clip skips its capture's Library cuts. Absent means yes:
 * cutting a recording in the Library is a statement about the footage,
 * and a reel should inherit it without being told. The opt-out exists for
 * the clip that needs more picture than the edit keeps — a voiceover
 * longer than the cut clip would otherwise freeze or loop it.
 */
export function sizzleUsesCaptureCuts(clip: { useCaptureCuts?: boolean | undefined }): boolean {
  return clip.useCaptureCuts !== false;
}

/**
 * The source spans a video clip plays: `trim` minus the capture's
 * interior cuts, in order. One span equal to the trim when the clip opts
 * out, the capture has no cuts, or no cut overlaps the window. When the
 * cuts would remove the WHOLE window the window plays uncut — a clip
 * never renders as nothing.
 */
export function sizzleMediaSpans(args: {
  trim: SizzleMediaTrim;
  segments: readonly VideoRange[] | null | undefined;
  useCaptureCuts: boolean;
}): VideoRange[] {
  const window: VideoRange = { start: args.trim.startSec, end: args.trim.endSec };
  if (!args.useCaptureCuts || args.segments === null || args.segments === undefined) return [window];
  const cuts = videoCuts(args.segments, 0, { outer: false }).filter(
    (cut) => cut.end > window.start && cut.start < window.end
  );
  if (cuts.length === 0) return [window];
  const kept = subtractVideoSpans([window], cuts, window.end);
  return kept.length > 0 ? kept : [window];
}

/** True when `spans` skip anything — more than one span. */
export function sizzleMediaSpansHaveCuts(spans: readonly VideoRange[]): boolean {
  return spans.length > 1;
}

/** Seconds of picture the spans play. */
export function sizzleMediaSpansDurationSec(spans: readonly VideoRange[]): number {
  return videoKeptDurationSec(spans);
}

/**
 * The first `sec` seconds of the edit, as spans. A fit that plays less
 * than the whole clip (`trim`, `freeze-end`) decodes only this much.
 */
export function sizzleMediaSpansPrefix(spans: readonly VideoRange[], sec: number): VideoRange[] {
  const out: VideoRange[] = [];
  let remaining = Math.max(0, sec);
  for (const span of spans) {
    if (remaining <= 0) break;
    const length = span.end - span.start;
    if (length <= remaining) {
      out.push({ start: span.start, end: span.end });
      remaining -= length;
    } else {
      out.push({ start: span.start, end: span.start + remaining });
      remaining = 0;
    }
  }
  return out.length > 0 ? out : spans.slice(0, 1).map((s) => ({ ...s }));
}

/**
 * Source time for an offset into the edit: `offsetSec` seconds of KEPT
 * picture after the first span starts. Clamped to the edit, so an offset
 * past the end lands on the last kept instant.
 */
export function sizzleMediaSourceTimeSec(spans: readonly VideoRange[], offsetSec: number): number {
  let remaining = Math.max(0, offsetSec);
  for (const span of spans) {
    const length = span.end - span.start;
    if (remaining < length) return span.start + remaining;
    remaining -= length;
  }
  return spans[spans.length - 1]?.end ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundSec(value: number): number {
  return Math.round(value * 1000) / 1000;
}
