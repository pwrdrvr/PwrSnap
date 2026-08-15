// Pure trim-range + timecode helpers shared by the Library video stage
// (transport + timeline), the DetailRail export eyebrow, and the
// float-over mini-trim. No React, no DOM — unit-tested in isolation.
//
// Conventions:
//   • All times are seconds (float), matching `VideoRange` /
//     `VideoCaptureMetadata.durationSec` in @pwrsnap/shared.
//   • Persisted ranges are rounded to milliseconds (`roundTime`) so the
//     SQLite export-cache key (exact float equality on start/end) stays
//     stable across drag → persist → read-back → export.
//   • Timecodes render `m:ss.d` (tenths) for the transport and
//     `m:ss` for the compact export eyebrow.

import type { VideoRange } from "@pwrsnap/shared";

/** Smallest range the handles allow, in seconds. Below this an export
 *  would be a single frame and the handles overlap visually. */
export const MIN_RANGE_SEC = 0.1;

/** Frame-step fallback when the source fps is unknown (metadata does
 *  not carry fps today). 30 fps is the ScreenCaptureKit default. */
export const DEFAULT_FRAME_STEP_SEC = 1 / 30;

/** Tolerance for "is this range effectively the whole clip". */
export const FULL_RANGE_EPS_SEC = 0.05;

export function roundTime(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

export function clampTime(sec: number, durationSec: number): number {
  if (!Number.isFinite(sec)) return 0;
  return Math.min(Math.max(sec, 0), Math.max(durationSec, 0));
}

/** Clamp a range into `[0, duration]` and enforce `end - start >=
 *  MIN_RANGE_SEC` (when the clip is long enough to allow it). Never
 *  swaps start/end — a moving `in` handle stops at `out - MIN`. */
export function clampRange(range: VideoRange, durationSec: number): VideoRange {
  const d = Math.max(durationSec, 0);
  const minGap = Math.min(MIN_RANGE_SEC, d);
  let start = clampTime(range.start, d);
  let end = clampTime(range.end, d);
  if (end < start) end = start;
  if (end - start < minGap) {
    // Prefer pushing end out; if there's no room, pull start in.
    if (start + minGap <= d) end = start + minGap;
    else {
      end = d;
      start = Math.max(0, d - minGap);
    }
  }
  return { start: roundTime(start), end: roundTime(end) };
}

export function isFullRange(range: VideoRange, durationSec: number): boolean {
  return range.start <= FULL_RANGE_EPS_SEC && range.end >= durationSec - FULL_RANGE_EPS_SEC;
}

export function fullRange(durationSec: number): VideoRange {
  return { start: 0, end: roundTime(Math.max(durationSec, 0)) };
}

export function rangeDuration(range: VideoRange): number {
  return Math.max(0, range.end - range.start);
}

/** `m:ss.d` — `0:03.4`, `1:02.0`, `12:00.5`. Tenths are floored so
 *  a playhead at 3.49 s reads `0:03.4`, never a value ahead of time. */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  const tenths = Math.floor(s * 10 + 1e-6);
  const minutes = Math.floor(tenths / 600);
  const rem = tenths - minutes * 600;
  const whole = Math.floor(rem / 10);
  const tenth = rem - whole * 10;
  return `${minutes}:${String(whole).padStart(2, "0")}.${tenth}`;
}

/** `m:ss` — used in the compact export eyebrow (`EXPORT · 0:03–0:11`).
 *  Rounds to the nearest second. */
export function formatTimecodeShort(sec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  const minutes = Math.floor(s / 60);
  const whole = s - minutes * 60;
  return `${minutes}:${String(whole).padStart(2, "0")}`;
}

/** Span label — `7.8 s` when fractional, `8 s` when whole. */
export function formatSpan(sec: number, decimals: 0 | 1 = 1): string {
  const s = Math.max(0, Number.isFinite(sec) ? sec : 0);
  if (decimals === 0) return `${Math.round(s)} s`;
  const tenths = Math.round(s * 10) / 10;
  return Number.isInteger(tenths) ? `${tenths} s` : `${tenths.toFixed(1)} s`;
}

/** `TRIM 0:03.4 – 0:11.2 · 7.8 s` (eyebrow under the timeline). */
export function trimLabel(range: VideoRange): string {
  return `TRIM ${formatTimecode(range.start)} – ${formatTimecode(range.end)} · ${formatSpan(
    rangeDuration(range)
  )}`;
}

/** Export eyebrow: `EXPORT` for the full clip, otherwise
 *  `EXPORT · 0:03–0:11 (8 s)`. */
export function exportEyebrowLabel(range: VideoRange | null, durationSec: number): string {
  if (range === null || isFullRange(range, durationSec)) return "EXPORT";
  return `EXPORT · ${formatTimecodeShort(range.start)}–${formatTimecodeShort(range.end)} (${formatSpan(
    rangeDuration(range),
    0
  )})`;
}

export function secToPx(sec: number, durationSec: number, widthPx: number): number {
  if (durationSec <= 0 || widthPx <= 0) return 0;
  return (clampTime(sec, durationSec) / durationSec) * widthPx;
}

export function pxToSec(px: number, durationSec: number, widthPx: number): number {
  if (durationSec <= 0 || widthPx <= 0) return 0;
  return clampTime((px / widthPx) * durationSec, durationSec);
}

export type TickMark = { sec: number; major: boolean; label: string | null };

/**
 * Tick marks along the timeline. Minor ticks every `minor` seconds,
 * major (labeled) ticks every `major` seconds, chosen so labels never
 * crowd: at least ~48 px between labels. Always includes 0.
 */
export function tickMarks(durationSec: number, widthPx: number): TickMark[] {
  if (durationSec <= 0 || widthPx <= 0) return [];
  const pxPerSec = widthPx / durationSec;
  // (minor, major) ladders, coarsening as the strip gets denser.
  const ladders: ReadonlyArray<readonly [number, number]> = [
    [1, 5],
    [1, 10],
    [5, 30],
    [10, 60],
    [30, 300],
    [60, 600]
  ];
  let minor = 60;
  let major = 600;
  for (const [mi, ma] of ladders) {
    if (ma * pxPerSec >= 48 && mi * pxPerSec >= 4) {
      minor = mi;
      major = ma;
      break;
    }
  }
  const out: TickMark[] = [];
  const count = Math.floor(durationSec / minor + 1e-6);
  for (let i = 0; i <= count; i += 1) {
    const sec = i * minor;
    const isMajor = Math.abs((sec / major) - Math.round(sec / major)) < 1e-6;
    out.push({ sec, major: isMajor, label: isMajor ? formatTimecodeShort(sec) : null });
  }
  return out;
}

/** Nudge a time by whole frames / seconds and clamp. */
export function stepTime(
  currentSec: number,
  amountSec: number,
  durationSec: number
): number {
  return roundTime(clampTime(currentSec + amountSec, durationSec));
}
