// Rotation detents for the transform-handles rotate drag.
//
// The gesture should feel like a physical knob with notches. Whip the
// handle around and it spins freely past every notch; ease toward one
// and it grabs, holds while you wiggle, and lets go once you clearly
// pull away. Two independent mechanisms produce that:
//
//   1. A SPEED GATE decides whether a notch may capture at all. Below
//      `DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS` the drag is "deliberate"
//      and a nearby detent grabs it; above, the drag is a whip and
//      every detent is ignored. This is what keeps a fast spin from
//      stuttering through eight notches per revolution. The gate reads
//      the LATEST sample, so easing off mid-spin makes the next notch
//      available on the very next frame — smoothing the speed would
//      carry the whip forward and swallow exactly the deceleration the
//      user means as "let me line this up".
//
//   2. HYSTERESIS decides when a captured notch lets go. Capture needs
//      the angle within `DETENT_CAPTURE_RAD`; release needs it beyond
//      the WIDER `DETENT_RELEASE_RAD`. The gap between the two is the
//      "holds for a smidge" — once grabbed, small jitter (and the first
//      frame or two of a deliberate pull-away) stays snapped.
//
// Note that release is distance-only, with no speed escape hatch. That
// is deliberate: a fast pull away from a held detent covers the release
// window within a frame or two anyway, and the brief resistance before
// it does is exactly the notch "letting go" rather than evaporating the
// instant the pointer twitches.
//
// Angles are absolute accumulated radians, NOT wrapped to [0, 2π) —
// `geometryFromDrag` builds them as `preRotation + delta`, so a layer
// dragged twice around carries ~4π. Snapping to a multiple of the step
// works on any winding, so nothing here needs to normalize (and
// normalizing would fight the caller's accumulation).
//
// Pure + state-in/state-out so the whole feel is unit-testable without
// a pointer: see __tests__/rotation-detents.test.ts.

/** Detent spacing. 45° gives 0 / 45 / 90 / 135 / 180 / …, which covers
 *  every angle a user asks for by name. */
export const DETENT_STEP_RAD = Math.PI / 4;

/** How near a detent a DELIBERATE drag must come to be captured. ~5°,
 *  which at a typical rotate-handle radius is a few pixels of arc —
 *  close enough that you have to mean it. */
export const DETENT_CAPTURE_RAD = (5 * Math.PI) / 180;

/** How far a CAPTURED drag must travel to break free. Wider than the
 *  capture window; the difference is the hysteresis that makes a notch
 *  hold. */
export const DETENT_RELEASE_RAD = (9 * Math.PI) / 180;

/** Above this angular speed no detent may capture — the whip. 180°/s.
 *  A comfortable "I am lining this up" rotation runs well under it; a
 *  flick runs several times over. */
export const DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS = Math.PI / 1000;

export interface RotationDetentState {
  /** Previous raw (un-snapped) angle, for the speed sample. */
  readonly lastRawRad: number | null;
  /** Timestamp of that sample, in ms on any monotonic clock. */
  readonly lastAtMs: number | null;
  /** Angular speed of the most recent sample, rad/ms. Deliberately
   *  INSTANTANEOUS rather than smoothed: an EMA carries a whip's speed
   *  forward for several frames after the user has already slowed
   *  down, which is precisely when a detent should become available.
   *  Measured over a whole frame, a single sample is already an
   *  average, and a lone anomalously-slow frame mid-whip costs at most
   *  one frame of snap before the next fast sample clears the release
   *  window. */
  readonly speedRadPerMs: number;
  /** The detent currently holding the drag, or null when free. */
  readonly heldRad: number | null;
}

/** Fresh state for one rotate gesture. Callers reset on pointerdown so
 *  a new drag never inherits the previous one's held notch or speed. */
export function createRotationDetentState(): RotationDetentState {
  return { lastRawRad: null, lastAtMs: null, speedRadPerMs: 0, heldRad: null };
}

/** Nearest detent to `rad`. Exported for tests + callers that want to
 *  reason about the ladder without running the state machine. */
export function nearestDetent(rad: number): number {
  return Math.round(rad / DETENT_STEP_RAD) * DETENT_STEP_RAD;
}

/** Resolve the angle to COMMIT at the end of a gesture, without
 *  advancing the machine.
 *
 *  Pointerup must not run `applyRotationDetents`: the pointer has by
 *  definition stopped, so that sample's speed is zero, and a whip that
 *  happened to end near a notch would be captured by it — the layer
 *  visibly jumping to the detent AFTER the user let go. Releasing
 *  applies only the hold that was already in effect, so what the last
 *  frame painted is what gets written.
 *
 *  The release check still runs, so a pointer that drifted clear of a
 *  held notch between the last move and the release commits the raw
 *  angle. */
export function resolveHeldRotation(
  rawRad: number,
  state: RotationDetentState
): number {
  if (state.heldRad === null) return rawRad;
  return Math.abs(rawRad - state.heldRad) <= DETENT_RELEASE_RAD
    ? state.heldRad
    : rawRad;
}

/** Feed one pointer sample through the detent machine.
 *
 *  `rawRad` is the angle the drag geometry produced with no snapping;
 *  `atMs` is a monotonic timestamp (`performance.now()` in the editor,
 *  explicit values in tests). Returns the angle to actually apply plus
 *  the next state — the caller keeps the state in a ref for the life of
 *  the gesture.
 *
 *  The FIRST sample of a gesture has no previous angle to difference
 *  against, so it carries the state's initial zero speed: a drag that
 *  begins already inside a detent's capture window grabs immediately,
 *  which is what you want when the layer is sitting at 0° and you nudge
 *  the handle. */
export function applyRotationDetents(
  rawRad: number,
  atMs: number,
  state: RotationDetentState
): { rad: number; state: RotationDetentState } {
  // Speed sample. A non-advancing clock (two events in the same
  // millisecond, or a replayed timestamp) carries the previous value
  // rather than dividing by zero.
  let speedRadPerMs = state.speedRadPerMs;
  if (state.lastRawRad !== null && state.lastAtMs !== null) {
    const dtMs = atMs - state.lastAtMs;
    if (dtMs > 0) speedRadPerMs = Math.abs(rawRad - state.lastRawRad) / dtMs;
  }

  const next = (heldRad: number | null): RotationDetentState => ({
    lastRawRad: rawRad,
    lastAtMs: atMs,
    speedRadPerMs,
    heldRad
  });

  // Already held: stay snapped until the raw angle clears the wider
  // release window.
  if (state.heldRad !== null) {
    if (Math.abs(rawRad - state.heldRad) <= DETENT_RELEASE_RAD) {
      return { rad: state.heldRad, state: next(state.heldRad) };
    }
    return { rad: rawRad, state: next(null) };
  }

  // Free: a detent may capture only if the drag is slow enough AND the
  // angle is inside the (narrower) capture window.
  if (speedRadPerMs <= DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS) {
    const detent = nearestDetent(rawRad);
    if (Math.abs(rawRad - detent) <= DETENT_CAPTURE_RAD) {
      return { rad: detent, state: next(detent) };
    }
  }
  return { rad: rawRad, state: next(null) };
}
