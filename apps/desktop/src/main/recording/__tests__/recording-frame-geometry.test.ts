// The recording frame's geometry, and the one property that matters
// most: on a platform that cannot hide a window from its own recorder,
// no part of the frame may be inside the recorded rect. That branch is
// the reason this module is pure — macOS CI would never run it.

import { describe, expect, test } from "vitest";
import {
  RECORDING_FRAME_BAND_PX,
  planRecordingFrame,
  recordingFramePhaseFor
} from "../recording-frame-geometry";

const PRIMARY = { bounds: { x: 0, y: 0, width: 1440, height: 900 } };
/** A second display up and to the left — the arrangement that catches a
 *  missing (or doubled) origin translation. */
const SECONDARY = { bounds: { x: -1920, y: -180, width: 1920, height: 1080 } };

const BAND = RECORDING_FRAME_BAND_PX;

describe("planRecordingFrame", () => {
  test("a region with room on every side gets the full band", () => {
    const plan = planRecordingFrame({
      rect: { x: 300, y: 200, w: 640, h: 400 },
      display: PRIMARY,
      platform: "darwin"
    });

    expect(plan).not.toBeNull();
    expect(plan?.bounds).toEqual({
      x: 300 - BAND,
      y: 200 - BAND,
      width: 640 + BAND * 2,
      height: 400 + BAND * 2
    });
    expect(plan?.inset).toEqual({ left: BAND, top: BAND, right: BAND, bottom: BAND });
  });

  test("the mode is the platform split, and nothing else changes with it", () => {
    const rect = { x: 300, y: 200, w: 640, h: 400 };
    const mac = planRecordingFrame({ rect, display: PRIMARY, platform: "darwin" });
    const win = planRecordingFrame({ rect, display: PRIMARY, platform: "win32" });
    const linux = planRecordingFrame({ rect, display: PRIMARY, platform: "linux" });

    expect(mac?.mode).toBe("straddle");
    expect(win?.mode).toBe("outset");
    expect(linux?.mode).toBe("outset");
    // Same window, same insets — only the posture the renderer paints in
    // differs, so a platform bug cannot move the frame off the rect.
    expect(win?.bounds).toEqual(mac?.bounds);
    expect(win?.inset).toEqual(mac?.inset);
    expect(linux?.bounds).toEqual(mac?.bounds);
  });

  test("a display-local rect is translated to global exactly once", () => {
    const plan = planRecordingFrame({
      rect: { x: 100, y: 50, w: 400, h: 300 },
      display: SECONDARY,
      platform: "darwin"
    });

    expect(plan?.bounds).toEqual({
      x: -1920 + 100 - BAND,
      y: -180 + 50 - BAND,
      width: 400 + BAND * 2,
      height: 300 + BAND * 2
    });
    expect(plan?.inset).toEqual({ left: BAND, top: BAND, right: BAND, bottom: BAND });
  });

  test("a region flush against a display edge loses the band on that side only", () => {
    const plan = planRecordingFrame({
      rect: { x: 0, y: 300, w: 500, h: 400 },
      display: PRIMARY,
      platform: "win32"
    });

    expect(plan?.inset).toEqual({ left: 0, top: BAND, right: BAND, bottom: BAND });
    // Clamped to the display rather than spilling onto a neighbour.
    expect(plan?.bounds.x).toBe(0);
  });

  test("a region in the bottom-right corner is clamped on both trailing sides", () => {
    const plan = planRecordingFrame({
      rect: { x: 1440 - 400, y: 900 - 300, w: 400, h: 300 },
      display: PRIMARY,
      platform: "darwin"
    });

    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.inset).toEqual({ left: BAND, top: BAND, right: 0, bottom: 0 });
    expect(plan.bounds.x + plan.bounds.width).toBe(1440);
    expect(plan.bounds.y + plan.bounds.height).toBe(900);
  });

  describe("full-display recording", () => {
    // `subjectToPhysicalRect` emits a zero rect for a display subject —
    // the recorder reads its own display dimensions. A zero rect here
    // means "the whole display", NOT "nothing to frame".
    const ZERO_RECT = { x: 0, y: 0, w: 0, h: 0 };

    test("macOS hugs the display bounds with no inset", () => {
      const plan = planRecordingFrame({
        rect: ZERO_RECT,
        display: PRIMARY,
        platform: "darwin"
      });

      expect(plan?.mode).toBe("straddle");
      expect(plan?.bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
      expect(plan?.inset).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    });

    test("Windows and Linux draw nothing — there is no legal pixel", () => {
      // Every side is clamped away, so the only place left to paint is
      // inside the capture. gdigrab would bake it into every frame.
      expect(
        planRecordingFrame({ rect: ZERO_RECT, display: PRIMARY, platform: "win32" })
      ).toBeNull();
      expect(
        planRecordingFrame({ rect: ZERO_RECT, display: PRIMARY, platform: "linux" })
      ).toBeNull();
    });

    test("an explicit full-display rect is treated the same as a zero rect", () => {
      const explicit = planRecordingFrame({
        rect: { x: 0, y: 0, w: 1440, h: 900 },
        display: PRIMARY,
        platform: "win32"
      });
      expect(explicit).toBeNull();
    });
  });

  test("a rect too small to frame is refused on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(
        planRecordingFrame({ rect: { x: 10, y: 10, w: 12, h: 400 }, display: PRIMARY, platform })
      ).toBeNull();
      expect(
        planRecordingFrame({ rect: { x: 10, y: 10, w: 400, h: 4 }, display: PRIMARY, platform })
      ).toBeNull();
    }
  });

  test("fractional rects are rounded, so the window never lands on a half pixel", () => {
    const plan = planRecordingFrame({
      rect: { x: 100.4, y: 200.6, w: 300.5, h: 220.2 },
      display: PRIMARY,
      platform: "darwin"
    });

    expect(plan?.bounds).toEqual({
      x: 100 - BAND,
      y: 201 - BAND,
      width: 301 + BAND * 2,
      height: 220 + BAND * 2
    });
    for (const value of Object.values(plan?.inset ?? {})) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  test("every outset plan leaves at least one side to paint on", () => {
    // The invariant behind the null above, stated directly: an outset
    // plan that came back non-null always has somewhere outside the rect
    // to put ink.
    const cases = [
      { x: 0, y: 0, w: 1440, h: 400 },
      { x: 0, y: 0, w: 400, h: 900 },
      { x: 0, y: 500, w: 1440, h: 400 },
      { x: 1040, y: 0, w: 400, h: 900 }
    ];
    for (const rect of cases) {
      const plan = planRecordingFrame({ rect, display: PRIMARY, platform: "win32" });
      expect(plan).not.toBeNull();
      const { left, top, right, bottom } = plan?.inset ?? { left: 0, top: 0, right: 0, bottom: 0 };
      expect(left + top + right + bottom).toBeGreaterThan(0);
    }
  });
});

describe("recordingFramePhaseFor", () => {
  test("the lead-in phases collapse to one arming state", () => {
    expect(recordingFramePhaseFor("preflight")).toBe("arming");
    expect(recordingFramePhaseFor("countdown")).toBe("arming");
    expect(recordingFramePhaseFor("starting")).toBe("arming");
  });

  test("recording is its own state and the tail phases share one", () => {
    expect(recordingFramePhaseFor("recording")).toBe("recording");
    expect(recordingFramePhaseFor("stopping")).toBe("stopping");
    expect(recordingFramePhaseFor("processing")).toBe("stopping");
  });

  test("terminal phases draw nothing", () => {
    // `failed` included deliberately: the HUD becomes an actionable
    // failure card, and a frame still hugging a rect nothing is being
    // written to would be a lie.
    expect(recordingFramePhaseFor("idle")).toBeNull();
    expect(recordingFramePhaseFor("ready")).toBeNull();
    expect(recordingFramePhaseFor("failed")).toBeNull();
  });
});
