import { describe, expect, test, vi } from "vitest";
import {
  CLIP_HOLD_MS,
  CLIP_THRESHOLD,
  createLevelMeterStore,
  METER_FLOOR_DB,
  meterFraction,
  PEAK_HOLD_MS,
  peakOf,
  toDbfs
} from "../mic-level-meter";

describe("level arithmetic", () => {
  test("the peak is the largest magnitude, either polarity", () => {
    expect(peakOf(new Float32Array([0.1, -0.6, 0.3]))).toBeCloseTo(0.6);
    expect(peakOf(new Float32Array(8))).toBe(0);
  });

  test("dBFS is whole, clamped to the floor and to 0", () => {
    expect(toDbfs(1)).toBe(0);
    expect(toDbfs(0.5)).toBe(-6);
    expect(toDbfs(0.1)).toBe(-20);
    expect(toDbfs(0)).toBe(METER_FLOOR_DB);
    expect(toDbfs(1e-9)).toBe(METER_FLOOR_DB);
    // A float pipeline can overshoot; the meter cannot read above full scale.
    expect(toDbfs(1.4)).toBe(0);
  });

  test("the bar runs from the floor to 0 dB", () => {
    expect(meterFraction(METER_FLOOR_DB)).toBe(0);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(-18)).toBeCloseTo(0.7);
    expect(meterFraction(-80)).toBe(0);
  });
});

describe("createLevelMeterStore", () => {
  test("the peak holds above a falling level, then falls back", () => {
    const store = createLevelMeterStore();
    store.push(0.5, 0); // −6 dB
    store.push(0.1, 100); // −20 dB
    expect(store.get()).toEqual({ levelDb: -20, peakDb: -6, clipping: false });
    store.push(0.1, PEAK_HOLD_MS - 1);
    expect(store.get().peakDb).toBe(-6);
    store.push(0.1, PEAK_HOLD_MS);
    expect(store.get().peakDb).toBe(-20);
  });

  test("a louder moment re-arms the hold at once", () => {
    const store = createLevelMeterStore();
    store.push(0.1, 0);
    store.push(0.5, 50);
    expect(store.get().peakDb).toBe(-6);
  });

  // The shout that clipped is usually over before anyone looks, so CLIP
  // has to outlive it.
  test("clipping latches, then clears after the hold", () => {
    const store = createLevelMeterStore();
    store.push(CLIP_THRESHOLD, 0);
    expect(store.get().clipping).toBe(true);
    store.push(0.05, CLIP_HOLD_MS - 1);
    expect(store.get().clipping).toBe(true);
    store.push(0.05, CLIP_HOLD_MS);
    expect(store.get().clipping).toBe(false);
  });

  test("a hot signal just under the rail is not clipping", () => {
    const store = createLevelMeterStore();
    store.push(0.95, 0);
    expect(store.get()).toMatchObject({ levelDb: 0, clipping: false });
  });

  test("subscribers hear only changes, and reset returns to silence", () => {
    const store = createLevelMeterStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.push(0.5, 0);
    store.push(0.5, 10);
    store.push(0.5001, 20); // still −6 dB
    expect(listener).toHaveBeenCalledTimes(1);
    store.reset();
    expect(store.get()).toEqual({ levelDb: METER_FLOOR_DB, peakDb: METER_FLOOR_DB, clipping: false });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.push(0.5, 30);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
