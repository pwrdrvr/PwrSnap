// When a frame of a recording was on screen, as a wall-clock instant.
//
// A recording's `captured_at` is stamped when the take is persisted, just
// after Stop — the END of the clip, not its start (see
// `persistStoppedRecording`). Source time runs from the start, so the frame
// at `timeSec` was on screen `durationSec - timeSec` before `captured_at`.
// Pure; an unparseable `captured_at` falls back to it unchanged rather than
// inventing a time.

export function frameStillCapturedAt(
  capturedAtIso: string,
  durationSec: number,
  timeSec: number
): string {
  const endMs = Date.parse(capturedAtIso);
  if (!Number.isFinite(endMs)) return capturedAtIso;
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const t = Math.min(Math.max(Number.isFinite(timeSec) ? timeSec : 0, 0), duration);
  return new Date(Math.round(endMs - (duration - t) * 1000)).toISOString();
}
