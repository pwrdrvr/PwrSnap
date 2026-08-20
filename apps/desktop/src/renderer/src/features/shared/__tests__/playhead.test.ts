// The out-of-React playhead channel. Small surface, but two properties
// are load-bearing for the video stage: a fresh subscriber is placed
// immediately (so a node that mounts mid-playback isn't stuck at 0
// until the next frame), and an unchanged value is not republished (a
// paused video's rAF-free state must not churn the DOM).

import { describe, expect, test } from "vitest";
import { createPlayheadSource } from "../playhead";

describe("createPlayheadSource", () => {
  test("publishes to every subscriber and remembers the latest value", () => {
    const source = createPlayheadSource(1.5);
    const a: number[] = [];
    const b: number[] = [];
    source.subscribe((s) => a.push(s));
    source.subscribe((s) => b.push(s));
    // Both were placed at the current value on subscribe.
    expect(a).toEqual([1.5]);
    expect(b).toEqual([1.5]);

    source.set(2);
    expect(source.get()).toBe(2);
    expect(a).toEqual([1.5, 2]);
    expect(b).toEqual([1.5, 2]);
  });

  test("an unchanged value is not republished", () => {
    const source = createPlayheadSource(0);
    const seen: number[] = [];
    source.subscribe((s) => seen.push(s));
    source.set(0);
    source.set(0);
    expect(seen).toEqual([0]);
  });

  test("unsubscribing stops delivery without affecting the others", () => {
    const source = createPlayheadSource(0);
    const kept: number[] = [];
    const dropped: number[] = [];
    source.subscribe((s) => kept.push(s));
    const off = source.subscribe((s) => dropped.push(s));
    off();
    source.set(3);
    expect(kept).toEqual([0, 3]);
    expect(dropped).toEqual([0]);
  });
});
