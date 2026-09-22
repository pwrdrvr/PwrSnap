// Unit coverage for the video-fit playback state.
//
// This used to be exercised only through the per-scene preview stage's
// <video> element. That stage is gone (the reel player is the one player),
// and the logic is a pure function — so it is tested directly here, which
// covers more of it than the DOM route did.

import { describe, expect, test } from "vitest";
import type { CaptureRecord, SizzleSequenceBeat, SizzleSequencePreviewBeat } from "@pwrsnap/shared";
import { cutFollowSeekSec, sequencePreviewVideoState } from "../sequence-plan";

const previewBeat = (patch: Partial<SizzleSequencePreviewBeat> = {}): SizzleSequencePreviewBeat =>
  ({
    beatId: "b1",
    captureId: "cap_v",
    startSec: 0,
    endSec: 4,
    timing: { kind: "auto" },
    transition: "cut",
    videoFit: "smart-fit",
    ...patch
  }) as SizzleSequencePreviewBeat;

const sceneBeat = (patch: Partial<SizzleSequenceBeat> = {}): SizzleSequenceBeat => ({
  id: "b1",
  captureId: "cap_v",
  timing: { kind: "auto" },
  mediaTrim: null,
  transition: "cut",
  videoFit: "smart-fit",
  ...patch
});

const video = (durationSec = 10): CaptureRecord =>
  ({
    id: "cap_v",
    kind: "video",
    legacy_src_path: "/tmp/v.mp4",
    video: { defaultRange: { start: 0, end: durationSec }, durationSec }
  }) as unknown as CaptureRecord;
const image = (): CaptureRecord => ({ id: "cap_i", kind: "image" }) as unknown as CaptureRecord;

describe("sequencePreviewVideoState", () => {
  test("an image capture has no video state at all", () => {
    expect(
      sequencePreviewVideoState({
        beat: previewBeat(),
        sceneBeat: sceneBeat(),
        capture: image(),
        timelineTimeSec: 1
      })
    ).toBeNull();
  });

  test("plays forward from the clip's TRIM start, not the file's start", () => {
    const state = sequencePreviewVideoState({
      beat: previewBeat({ startSec: 2, endSec: 6 }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 3, endSec: 7 }, videoFit: "trim" }),
      capture: video(),
      timelineTimeSec: 3 // 1 s into the clip
    });
    expect(state?.sourceTimeSec).toBeCloseTo(4, 3); // trim start 3 + 1 s elapsed
    expect(state?.shouldPlay).toBe(true);
  });

  test("loop wraps back to the trim start when the clip outlasts its source", () => {
    // 2 s of source under a 6 s clip: at 5 s elapsed the source is at 1 s.
    const state = sequencePreviewVideoState({
      beat: previewBeat({ startSec: 0, endSec: 6 }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 2 }, videoFit: "loop" }),
      capture: video(),
      timelineTimeSec: 5
    });
    expect(state?.sourceTimeSec).toBeCloseTo(1, 3);
  });

  test("ping-pong runs backwards through its second half", () => {
    const at = (timelineTimeSec: number) =>
      sequencePreviewVideoState({
        beat: previewBeat({ startSec: 0, endSec: 8 }),
        sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 2 }, videoFit: "ping-pong" }),
        capture: video(),
        timelineTimeSec
      })?.sourceTimeSec;
    expect(at(1)).toBeCloseTo(1, 3); // forward
    expect(at(3)).toBeCloseTo(1, 3); // reversed back to the middle
    expect(at(2)).toBeCloseTo(2, 3); // the turn
  });

  test("speed-to-fit stretches the source across the clip and reports the rate", () => {
    // 2 s of source over a 4 s clip → half speed.
    const state = sequencePreviewVideoState({
      beat: previewBeat({ startSec: 0, endSec: 4 }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 2 }, videoFit: "speed-to-fit" }),
      capture: video(),
      timelineTimeSec: 2
    });
    expect(state?.playbackRate).toBeCloseTo(0.5, 3);
    expect(state?.sourceTimeSec).toBeCloseTo(1, 3);
  });

  test("freeze-end holds the last trimmed frame and stops asking to play", () => {
    const args = {
      beat: previewBeat({ startSec: 0, endSec: 6 }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 2 }, videoFit: "freeze-end" }),
      capture: video()
    };
    const during = sequencePreviewVideoState({ ...args, timelineTimeSec: 1 });
    expect(during?.shouldPlay).toBe(true);
    const after = sequencePreviewVideoState({ ...args, timelineTimeSec: 5 });
    expect(after?.sourceTimeSec).toBeCloseTo(2, 3); // parked on the last frame
    expect(after?.shouldPlay).toBe(false);
  });

  test("with no trim anywhere it falls back to the capture's default range", () => {
    const state = sequencePreviewVideoState({
      beat: previewBeat({ startSec: 0, endSec: 3 }),
      sceneBeat: sceneBeat({ mediaTrim: null, videoFit: "trim" }),
      capture: video(9),
      timelineTimeSec: 1
    });
    expect(state?.sourceTimeSec).toBeCloseTo(1, 3);
  });
});

describe("sequencePreviewVideoState with Library cuts", () => {
  // A 20 s take cut to 0–2, 8–11, 16–20 in the Library (9 s kept).
  const cutVideo = (): CaptureRecord =>
    ({
      id: "cap_v",
      kind: "video",
      legacy_src_path: "/tmp/v.mp4",
      video: {
        durationSec: 20,
        defaultRange: { start: 0, end: 20 },
        segments: [
          { start: 0, end: 2 },
          { start: 8, end: 11 },
          { start: 16, end: 20 }
        ]
      }
    }) as unknown as CaptureRecord;
  const at = (timelineTimeSec: number, beat: Partial<SizzleSequenceBeat> = {}) =>
    sequencePreviewVideoState({
      beat: previewBeat({ startSec: 0, endSec: 9 }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 20 }, videoFit: "trim", ...beat }),
      capture: cutVideo(),
      timelineTimeSec
    });

  test("walks the kept spans, skipping what the Library cut", () => {
    expect(at(1)?.sourceTimeSec).toBeCloseTo(1, 6);
    expect(at(2.5)?.sourceTimeSec).toBeCloseTo(8.5, 6); // 0.5 s into part two
    expect(at(6)?.sourceTimeSec).toBeCloseTo(17, 6); // 1 s into part three
    expect(at(1)?.hasCuts).toBe(true);
  });

  test("an opted-out clip plays straight through its trim", () => {
    expect(at(2.5, { useCaptureCuts: false })?.sourceTimeSec).toBeCloseTo(2.5, 6);
    expect(at(2.5, { useCaptureCuts: false })?.hasCuts).toBe(false);
  });

  test("a plan made before the recut is re-derived, not trusted", () => {
    // The plan fit 20 s of footage by speeding it up; the capture now keeps 9 s.
    const state = sequencePreviewVideoState({
      beat: previewBeat({
        startSec: 0,
        endSec: 9,
        fit: { renderMode: "speed-to-fit", inputDurationSec: 20, playbackRate: 2.2, sourceDurationSec: 20 }
      }),
      sceneBeat: sceneBeat({ mediaTrim: { startSec: 0, endSec: 20 }, videoFit: "smart-fit" }),
      capture: cutVideo(),
      timelineTimeSec: 1
    });
    expect(state?.playbackRate).toBeCloseTo(1, 6);
  });
});

describe("cutFollowSeekSec", () => {
  const SPANS = [
    { start: 0, end: 2 },
    { start: 8, end: 11 },
    { start: 16, end: 20 }
  ];

  test("leaves an element alone inside the head's span, drift and all", () => {
    expect(cutFollowSeekSec(SPANS, 9, 9.4)).toBeNull();
    expect(cutFollowSeekSec(SPANS, 9.4, 8.9)).toBeNull();
  });

  test("jumps an element that ran into a cut to the next kept span", () => {
    expect(cutFollowSeekSec(SPANS, 1.95, 2.05)).toBe(8);
  });

  test("sends a lagging element to where the head crossed to", () => {
    expect(cutFollowSeekSec(SPANS, 8.05, 1.98)).toBe(8.05);
  });

  test("does not drag an element that is one cut AHEAD back into the old span", () => {
    // The element jumped the cut a frame before the head reached it.
    expect(cutFollowSeekSec(SPANS, 1.95, 8.02)).toBeNull();
  });

  test("follows the head when a loop wraps back to the first span", () => {
    expect(cutFollowSeekSec(SPANS, 0.1, 19.9)).toBe(0.1);
  });

  test("leaves the element parked on the last kept instant", () => {
    expect(cutFollowSeekSec(SPANS, 20, 20)).toBeNull();
  });
});
