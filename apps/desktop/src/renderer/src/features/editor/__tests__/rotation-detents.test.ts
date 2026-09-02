// The feel of the rotate gesture, pinned as arithmetic.
//
// The ask: "if you are whipping it around it whips... but if you slow
// down near a detent it grabs and holds for a smidge". Those are two
// separable behaviours — a speed gate on capture and a hysteresis gap
// on release — and each is checked here independently, plus the
// interaction between them.

import { describe, expect, test } from "vitest";
import {
  applyRotationDetents,
  resolveHeldRotation,
  createRotationDetentState,
  nearestDetent,
  DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS,
  DETENT_CAPTURE_RAD,
  DETENT_RELEASE_RAD,
  DETENT_STEP_RAD,
  type RotationDetentState
} from "../rotation-detents";

const deg = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Drive a sequence of {angle, time} samples through the machine and
 *  return the applied angles — the shape a real drag takes. */
function drive(
  samples: ReadonlyArray<{ rad: number; atMs: number }>,
  initial: RotationDetentState = createRotationDetentState()
): { rads: number[]; state: RotationDetentState } {
  let state = initial;
  const rads: number[] = [];
  for (const s of samples) {
    const out = applyRotationDetents(s.rad, s.atMs, state);
    rads.push(out.rad);
    state = out.state;
  }
  return { rads, state };
}

/** A steady sweep from `fromDeg` to `toDeg` at `degPerSec`, sampled at
 *  60 Hz — the shape a real pointer drag arrives in. */
function sweep(
  fromDeg: number,
  toDegrees: number,
  degPerSec: number,
  startMs = 1000
): Array<{ rad: number; atMs: number }> {
  const frameMs = 1000 / 60;
  const perFrame = (degPerSec * frameMs) / 1000;
  const samples: Array<{ rad: number; atMs: number }> = [];
  const steps = Math.ceil(Math.abs(toDegrees - fromDeg) / perFrame);
  const dir = Math.sign(toDegrees - fromDeg);
  for (let i = 0; i <= steps; i += 1) {
    const d = fromDeg + dir * Math.min(perFrame * i, Math.abs(toDegrees - fromDeg));
    samples.push({ rad: deg(d), atMs: startMs + i * frameMs });
  }
  return samples;
}

describe("nearestDetent", () => {
  test("snaps to the 45° ladder the user asked for", () => {
    for (const [inputDeg, expectedDeg] of [
      [0, 0], [2, 0], [-2, 0], [43, 45], [50, 45], [88, 90], [170, 180], [200, 180]
    ] as ReadonlyArray<readonly [number, number]>) {
      expect(toDeg(nearestDetent(deg(inputDeg)))).toBeCloseTo(expectedDeg, 6);
    }
  });

  test("keeps working past a full turn — angles accumulate, they don't wrap", () => {
    // geometryFromDrag builds `preRotation + delta`, so a layer spun
    // twice around carries ~4π. Normalizing here would fight that.
    expect(toDeg(nearestDetent(deg(363)))).toBeCloseTo(360, 6);
    expect(toDeg(nearestDetent(deg(407)))).toBeCloseTo(405, 6);
    expect(toDeg(nearestDetent(deg(-88)))).toBeCloseTo(-90, 6);
  });
});

describe("the whip — fast drags pass straight through every detent", () => {
  test("a 720°/s spin is never snapped", () => {
    const samples = sweep(0, 200, 720);
    const { rads } = drive(samples);
    // Every applied angle equals the raw one it came from.
    rads.forEach((rad, i) => expect(rad).toBeCloseTo(samples[i]!.rad, 9));
  });

  test("the speed gate sits between a deliberate rotation and a flick", () => {
    // Guards the constant against being retuned into uselessness at
    // either end: 90°/s must be capturable, 400°/s must not.
    const slow = deg(90) / 1000;
    const fast = deg(400) / 1000;
    expect(slow).toBeLessThan(DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS);
    expect(fast).toBeGreaterThan(DETENT_CAPTURE_MAX_SPEED_RAD_PER_MS);
  });
});

describe("the grab — slow drags are captured near a detent", () => {
  test("easing up to 90° snaps exactly to 90°", () => {
    const samples = sweep(70, 88, 60);
    const { rads, state } = drive(samples);
    expect(toDeg(rads[rads.length - 1]!)).toBeCloseTo(90, 6);
    expect(state.heldRad).not.toBeNull();
  });

  test("a slow drag that stays outside the capture window is untouched", () => {
    // 70° → 78° never comes within 5° of 45° or 90°.
    const samples = sweep(70, 78, 60);
    const { rads, state } = drive(samples);
    rads.forEach((rad, i) => expect(rad).toBeCloseTo(samples[i]!.rad, 9));
    expect(state.heldRad).toBeNull();
  });

  test("a gesture that STARTS inside a detent grabs on its first sample", () => {
    // The common case: the layer sits at 0° and the user nudges the
    // handle. There is no previous sample to measure speed from, so
    // the initial zero speed must let the notch hold.
    const { rads, state } = drive([{ rad: deg(2), atMs: 1000 }]);
    expect(toDeg(rads[0]!)).toBeCloseTo(0, 6);
    expect(state.heldRad).toBeCloseTo(0, 6);
  });
});

describe("the hold — hysteresis keeps a captured detent stuck", () => {
  test("jitter inside the release window stays snapped", () => {
    const captured = drive(sweep(70, 88, 60)).state;
    // Wiggle around 90° by less than the release window.
    const { rads } = drive(
      [
        { rad: deg(93), atMs: 5000 },
        { rad: deg(87), atMs: 5016 },
        { rad: deg(96), atMs: 5032 }
      ],
      captured
    );
    rads.forEach((rad) => expect(toDeg(rad)).toBeCloseTo(90, 6));
  });

  test("pulling clearly past the release window lets go", () => {
    const captured = drive(sweep(70, 88, 60)).state;
    const { rads, state } = drive([{ rad: deg(105), atMs: 5000 }], captured);
    expect(toDeg(rads[0]!)).toBeCloseTo(105, 6);
    expect(state.heldRad).toBeNull();
  });

  test("release is harder than capture — that gap IS the hold", () => {
    // The property, independent of the tuning: an angle that could
    // never have captured the detent can still be held by it.
    expect(DETENT_RELEASE_RAD).toBeGreaterThan(DETENT_CAPTURE_RAD);
    const captured = drive([{ rad: 0, atMs: 1000 }]).state;
    const between = (DETENT_CAPTURE_RAD + DETENT_RELEASE_RAD) / 2;
    const { rads } = drive([{ rad: between, atMs: 1016 }], captured);
    expect(rads[0]).toBeCloseTo(0, 9);
  });

  test("a held detent survives a whip-speed sample for a frame, then frees", () => {
    // "Holds for a smidge": release is distance-only, so the first
    // fast frame away from a notch is still snapped and the next one
    // — now clear of the release window — is free.
    const captured = drive([{ rad: 0, atMs: 1000 }]).state;
    const first = applyRotationDetents(deg(6), 1016, captured);
    expect(toDeg(first.rad)).toBeCloseTo(0, 6);
    const second = applyRotationDetents(deg(40), 1032, first.state);
    expect(toDeg(second.rad)).toBeCloseTo(40, 6);
    expect(second.state.heldRad).toBeNull();
  });
});

describe("release commits what the last frame painted", () => {
  // resolveHeldRotation is what pointerup uses. Feeding the machine a
  // fresh sample there would read as zero speed — the pointer has
  // stopped by definition — and capture a whip that happened to end
  // near a notch, moving the layer AFTER the user let go.

  test("a free drag commits its raw angle even though releasing looks motionless", () => {
    const whipped = drive(sweep(0, 89, 900)).state;
    expect(whipped.heldRad).toBeNull();
    expect(toDeg(resolveHeldRotation(deg(89), whipped))).toBeCloseTo(89, 6);
  });

  test("a held drag commits the detent", () => {
    const captured = drive(sweep(70, 88, 60)).state;
    expect(toDeg(resolveHeldRotation(deg(88), captured))).toBeCloseTo(90, 6);
  });

  test("a pointer that drifted clear of its notch before releasing commits the raw angle", () => {
    const captured = drive(sweep(70, 88, 60)).state;
    expect(toDeg(resolveHeldRotation(deg(105), captured))).toBeCloseTo(105, 6);
  });

  test("resolving never mutates the state it is given", () => {
    const captured = drive(sweep(70, 88, 60)).state;
    const snapshot = { ...captured };
    resolveHeldRotation(deg(105), captured);
    expect(captured).toEqual(snapshot);
  });
});

describe("state machine hygiene", () => {
  test("a fresh state holds nothing and assumes no motion", () => {
    const s = createRotationDetentState();
    expect(s.heldRad).toBeNull();
    expect(s.speedRadPerMs).toBe(0);
    expect(s.lastRawRad).toBeNull();
  });

  test("slowing down mid-spin makes the next detent available immediately", () => {
    // The behaviour the instantaneous (un-smoothed) gate exists for: a
    // fast approach followed by a genuinely slow frame must be able to
    // capture. A smoothed speed carries the whip forward and swallows
    // the deceleration.
    const whipped = drive([
      { rad: deg(0), atMs: 1000 },
      { rad: deg(40), atMs: 1016 },
      // Lands 6° short of 90° — outside the capture window, and at
      // ~2750°/s far outside the gate.
      { rad: deg(84), atMs: 1032 }
    ]).state;
    expect(whipped.heldRad).toBeNull();
    // One deliberate frame — 2° in 16ms ≈ 125°/s — brings it inside
    // 90°'s window at a capturable speed.
    const eased = applyRotationDetents(deg(86), 1048, whipped);
    expect(toDeg(eased.rad)).toBeCloseTo(90, 6);
  });

  test("a non-advancing clock carries the previous speed instead of dividing by zero", () => {
    const whipping = drive(sweep(0, 120, 720)).state;
    expect(Number.isFinite(whipping.speedRadPerMs)).toBe(true);
    const out = applyRotationDetents(deg(120), whipping.lastAtMs!, whipping);
    expect(Number.isFinite(out.state.speedRadPerMs)).toBe(true);
    expect(out.state.speedRadPerMs).toBeCloseTo(whipping.speedRadPerMs, 12);
    // ...and the carried speed still reads as a whip, so the replayed
    // sample cannot spuriously capture.
    expect(out.state.heldRad).toBeNull();
  });

  test("the step covers every angle the request named", () => {
    for (const d of [0, 45, 90, 180, 270, 360]) {
      expect(Math.abs(deg(d) % DETENT_STEP_RAD)).toBeLessThan(1e-9);
    }
  });
});
