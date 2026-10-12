// The microphone picker's level meter, as numbers.
//
// The chip's seven-segment meter answers "is anything arriving?". This one
// answers "is the gain right?", which needs three things the chip cannot
// show: a level in dBFS, a peak that stays put long enough to read, and a
// clip indicator that is still lit after the shout that caused it.
//
// Why a store and not React state
// ───────────────────────────────
// The monitor lives in RegionSelector, a 3,000-line component. Publishing a
// dB reading through its state would re-render the whole selector overlay on
// every change, and speech changes the reading most ticks. Instead the
// monitor pushes each sample window here, and only the meter that is on
// screen subscribes (`useSyncExternalStore`). Readings are whole dB, and a
// subscriber is told only when one of them changes.

/** Bottom of the scale. Anything quieter reads as silence. */
export const METER_FLOOR_DB = -60;
/**
 * A sample at or above this magnitude counts as clipped. 0.989 is −0.1 dBFS:
 * a float pipeline can carry a sample past 1.0, but a converter that has
 * hit its rail delivers a run of samples pinned just below it, never above.
 */
export const CLIP_THRESHOLD = 0.989;
/** How long the peak marker holds before it falls back to the level. */
export const PEAK_HOLD_MS = 1_500;
/** How long CLIP stays lit after the last clipped window. */
export const CLIP_HOLD_MS = 2_000;

export type LevelReading = {
  /** This window's peak, in whole dBFS. `METER_FLOOR_DB` at silence. */
  readonly levelDb: number;
  /** The highest `levelDb` of the last `PEAK_HOLD_MS`. */
  readonly peakDb: number;
  /** A clipped sample arrived within the last `CLIP_HOLD_MS`. */
  readonly clipping: boolean;
};

export const SILENT_READING: LevelReading = {
  levelDb: METER_FLOOR_DB,
  peakDb: METER_FLOOR_DB,
  clipping: false
};

/** Largest absolute sample in the window. */
export function peakOf(buffer: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const magnitude = Math.abs(buffer[i]!);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Amplitude → whole dBFS, clamped to [`METER_FLOOR_DB`, 0]. */
export function toDbfs(amplitude: number): number {
  if (!(amplitude > 0)) return METER_FLOOR_DB;
  // `|| 0`: a hair under full scale rounds to −0, which would read "−0 dB".
  const db = Math.round(20 * Math.log10(amplitude)) || 0;
  return Math.max(METER_FLOOR_DB, Math.min(0, db));
}

/** A reading's position on the bar, 0..1. */
export function meterFraction(db: number): number {
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

export type LevelMeterStore = {
  readonly get: () => LevelReading;
  readonly subscribe: (listener: () => void) => () => void;
  /** Feed one sample window's peak. `now` is injectable for tests. */
  readonly push: (peak: number, now: number) => void;
  /** Back to silence, e.g. when the device closes. */
  readonly reset: () => void;
};

export function createLevelMeterStore(): LevelMeterStore {
  let reading: LevelReading = SILENT_READING;
  let heldDb = METER_FLOOR_DB;
  let heldAt = Number.NEGATIVE_INFINITY;
  let clippedAt = Number.NEGATIVE_INFINITY;
  const listeners = new Set<() => void>();

  const publish = (next: LevelReading): void => {
    if (
      next.levelDb === reading.levelDb &&
      next.peakDb === reading.peakDb &&
      next.clipping === reading.clipping
    ) {
      return;
    }
    reading = next;
    for (const listener of listeners) listener();
  };

  return {
    get: () => reading,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (peak, now) => {
      const levelDb = toDbfs(peak);
      // A new high, or an old one that has been held long enough, resets
      // the hold. Between those the marker stays where the loudest moment
      // put it, which is what lets someone read "−7" off a single syllable.
      if (levelDb >= heldDb || now - heldAt >= PEAK_HOLD_MS) {
        heldDb = levelDb;
        heldAt = now;
      }
      if (peak >= CLIP_THRESHOLD) clippedAt = now;
      publish({ levelDb, peakDb: heldDb, clipping: now - clippedAt < CLIP_HOLD_MS });
    },
    reset: () => {
      heldDb = METER_FLOOR_DB;
      heldAt = Number.NEGATIVE_INFINITY;
      clippedAt = Number.NEGATIVE_INFINITY;
      publish(SILENT_READING);
    }
  };
}
