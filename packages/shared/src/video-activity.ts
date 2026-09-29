// On-screen activity track for a video capture — how much of the frame
// changed between consecutive samples. Pure; the ffmpeg side that
// produces the samples lives in main (`recording/video-activity.ts`).
//
// Why it exists: to cut the boring parts of a screen recording you need
// to know where nothing happened, and neither a person skimming a
// filmstrip nor an agent that cannot watch the video can find those
// stretches cheaply. One small number per sample answers it for both:
//
//   • the timeline draws it as a thin lane, so long flat stretches are
//     visible at a glance;
//   • agents get it run-length encoded (`videoActivityRuns`) plus the
//     still stretches already found (`videoStillSpans`), so "cut every
//     stretch where nothing changes for more than 5 s" is one read and
//     one write, with no frames to look at.
//
// The measure is the fraction of pixels whose luma moved by more than a
// noise floor between two downscaled grayscale frames. Downscaling to
// ~192 px wide is part of the measure, not just a speed-up: it averages
// a blinking caret or a spinner down to one or two pixels, which is what
// lets the lowest level mean "still" on real recordings — measured on a
// 60 s browser capture, a loading spinner read 0.004–0.009 %, cursor
// movement 0.02–0.05 %, a panel update ~3 % and a page change 40–95 %.

/** Fraction-of-frame thresholds between the four levels. */
export const VIDEO_ACTIVITY_THRESHOLDS = {
  /** Below this: still. A caret blink, a spinner, a clock tick. */
  minor: 0.0002,
  /** Below this: minor. Cursor movement, typing, a toggle. */
  moderate: 0.01,
  /** Below this: moderate — part of the window repainted. At or above:
   *  major — a scroll, a page change, a window switch. */
  major: 0.1
} as const;

export type VideoActivityLevel = 0 | 1 | 2 | 3;

export const VIDEO_ACTIVITY_LEVEL_NAMES: Readonly<Record<VideoActivityLevel, string>> = {
  0: "still",
  1: "minor",
  2: "moderate",
  3: "major"
};

/** Plain-language legend, shipped to agents alongside the track. */
export const VIDEO_ACTIVITY_LEVEL_LEGEND: Readonly<Record<VideoActivityLevel, string>> = {
  0: "still — nothing visible changed (caret blinks and spinners count as still)",
  1: "minor — cursor movement, typing, small UI toggles",
  2: "moderate — part of the window repainted",
  3: "major — scroll, navigation, window switch, most of the frame changed"
};

/** One sample per `1 / sampleHz` seconds. `magnitudes[i]` covers
 *  `[i / sampleHz, (i + 1) / sampleHz)`: the change between the frame
 *  shown at its start and the frame shown at its end. */
export type VideoActivityTrack = {
  sampleHz: number;
  /** 0 = no pixel changed. 1–255 = changed fraction on a log scale from
   *  1e-5 (1) to the whole frame (255) — see `encodeActivityMagnitude`. */
  magnitudes: readonly number[];
};

const LOG_FLOOR = -5;

/** Changed fraction → one byte. Log scale because the interesting
 *  range spans five decades: one pixel of a spinner to the whole frame. */
export function encodeActivityMagnitude(fraction: number): number {
  if (!(fraction > 0)) return 0;
  const f = Math.min(1, fraction);
  const scaled = 1 + ((Math.log10(f) - LOG_FLOOR) / -LOG_FLOOR) * 254;
  return Math.min(255, Math.max(1, Math.round(scaled)));
}

export function decodeActivityMagnitude(magnitude: number): number {
  if (!(magnitude > 0)) return 0;
  const m = Math.min(255, magnitude);
  return 10 ** (LOG_FLOOR + ((m - 1) / 254) * -LOG_FLOOR);
}

export function activityLevelOfFraction(fraction: number): VideoActivityLevel {
  if (fraction >= VIDEO_ACTIVITY_THRESHOLDS.major) return 3;
  if (fraction >= VIDEO_ACTIVITY_THRESHOLDS.moderate) return 2;
  if (fraction >= VIDEO_ACTIVITY_THRESHOLDS.minor) return 1;
  return 0;
}

export function activityLevelOfMagnitude(magnitude: number): VideoActivityLevel {
  return activityLevelOfFraction(decodeActivityMagnitude(magnitude));
}

/** One character per sample, `0`–`3`. The densest honest form of the
 *  track: 60 s at 5 Hz is 300 characters. */
export function videoActivityLevelString(track: VideoActivityTrack): string {
  let out = "";
  for (const m of track.magnitudes) out += String(activityLevelOfMagnitude(m));
  return out;
}

export type VideoActivityRun = { start: number; end: number; level: VideoActivityLevel };

/**
 * Run-length encoding of the level track. When there are more than
 * `maxRuns` runs, samples are pooled into wider buckets (the busiest
 * level in a bucket wins, so a brief burst is never averaged away)
 * until the encoding fits; `resolutionSec` reports the bucket used.
 */
export function videoActivityRuns(
  track: VideoActivityTrack,
  options: { maxRuns?: number } = {}
): { resolutionSec: number; runs: VideoActivityRun[] } {
  const maxRuns = Math.max(1, options.maxRuns ?? 200);
  const levels = track.magnitudes.map(activityLevelOfMagnitude);
  const period = 1 / track.sampleHz;
  let bucket = 1;
  for (;;) {
    const runs = rle(levels, bucket, period);
    if (runs.length <= maxRuns || bucket >= levels.length) {
      return { resolutionSec: round3(bucket * period), runs };
    }
    bucket *= 2;
  }
}

function rle(levels: readonly VideoActivityLevel[], bucket: number, period: number): VideoActivityRun[] {
  const runs: VideoActivityRun[] = [];
  for (let i = 0; i < levels.length; i += bucket) {
    let level: VideoActivityLevel = 0;
    for (let k = i; k < Math.min(i + bucket, levels.length); k += 1) {
      if (levels[k]! > level) level = levels[k]!;
    }
    const start = round3(i * period);
    const end = round3(Math.min(i + bucket, levels.length) * period);
    const prev = runs[runs.length - 1];
    if (prev !== undefined && prev.level === level) prev.end = end;
    else runs.push({ start, end, level });
  }
  return runs;
}

export type VideoStillSpanOptions = {
  /** Only stretches at least this long count. Default 3 s. */
  minStillSec?: number | undefined;
  /** Highest level that still counts as "nothing happening". Default 0
   *  (strict). 1 also ignores cursor movement and typing. */
  maxLevel?: VideoActivityLevel | undefined;
};

/** Stretches where the level never rose above `maxLevel` for at least
 *  `minStillSec`. Times are source seconds. */
export function videoStillSpans(
  track: VideoActivityTrack,
  options: VideoStillSpanOptions = {}
): Array<{ start: number; end: number }> {
  const minStill = Math.max(0, options.minStillSec ?? 3);
  const maxLevel = options.maxLevel ?? 0;
  const period = 1 / track.sampleHz;
  const out: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;
  const close = (endIndex: number): void => {
    if (runStart === null) return;
    const start = runStart * period;
    const end = endIndex * period;
    if (end - start >= minStill - 1e-9) out.push({ start: round3(start), end: round3(end) });
    runStart = null;
  };
  track.magnitudes.forEach((m, i) => {
    if (activityLevelOfMagnitude(m) <= maxLevel) {
      if (runStart === null) runStart = i;
    } else {
      close(i);
    }
  });
  close(track.magnitudes.length);
  return out;
}

/**
 * The cuts that remove every still stretch, each shrunk by `paddingSec`
 * where it meets a change, so the edit keeps a beat of the still screen
 * around every jump instead of snapping from one change straight into
 * the next. A stretch that opens the recording is cut from 0 and one
 * that closes it runs to `durationSec` — there is no change on the far
 * side to lead into. A stretch too short to survive the padding is
 * skipped.
 *
 * `durationSec` matters because the persisted duration is wall-clock
 * recording time and runs a little past the last decoded frame; without
 * it a trailing still stretch would leave that sliver kept.
 */
export function videoStillCuts(
  track: VideoActivityTrack,
  options: VideoStillSpanOptions & {
    paddingSec?: number | undefined;
    durationSec?: number | undefined;
  } = {}
): Array<{ start: number; end: number }> {
  const padding = Math.max(0, options.paddingSec ?? 0.5);
  const trackEnd = track.magnitudes.length / track.sampleHz;
  const clipEnd = Math.max(trackEnd, options.durationSec ?? trackEnd);
  return videoStillSpans(track, options)
    .map((span) => ({
      start: span.start <= 1e-9 ? 0 : round3(span.start + padding),
      end: span.end >= trackEnd - 1e-9 ? clipEnd : round3(span.end - padding)
    }))
    .filter((cut) => cut.end - cut.start >= 0.1);
}

function round3(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

// ── agent-facing wording ────────────────────────────────────────────

/** Shared wording for the two video tools and the in-app chat's pair
 *  (`library-tool-allowlist.ts`), so both surfaces teach agents the
 *  same model. */
export const VIDEO_EDIT_MODEL_GUIDANCE =
  "A video's edit is a list of KEPT spans in source seconds — the original recording's timeline, which never shifts when something is cut. " +
  "Gaps between kept spans are cut from exports; the recording itself is never modified and the user can undo any edit in PwrSnap.";

export const VIDEO_ACTIVITY_GUIDANCE =
  "Activity levels per sample: 0 still (nothing visible changed; caret blinks and spinners count as still), 1 minor (cursor movement, typing), 2 moderate (part of the window repainted), 3 major (scroll, navigation, window switch). " +
  "stillSpans lists stretches of level 0 (or 0–1 with treatMinorAsStill) lasting at least minStillSec — the usual candidates to cut. No frames need to be viewed.";
