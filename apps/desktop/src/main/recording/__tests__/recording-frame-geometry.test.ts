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

/**
 * Measured on the reporter's machine (macOS 26, Electron 41.10.7): a
 * 30px menu bar and an 89px Dock. Both are carved out of `workArea`,
 * and on macOS `workArea` is exactly `NSScreen.visibleFrame` — the
 * box AppKit will move a window into if we ask for anything outside
 * it. See the `window server` describe block at the bottom.
 */
const MENU_BAR_PX = 30;
const DOCK_PX = 89;

const PRIMARY = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: MENU_BAR_PX, width: 1440, height: 900 - MENU_BAR_PX - DOCK_PX }
};
/** A second display up and to the left — the arrangement that catches a
 *  missing (or doubled) origin translation. Its `workArea` is its full
 *  bounds, which is what macOS reports for a secondary display when
 *  "Displays have separate Spaces" is off and the Dock lives elsewhere;
 *  that keeps the translation tests about translation alone. */
const SECONDARY = {
  bounds: { x: -1920, y: -180, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -180, width: 1920, height: 1080 }
};
/** The same second display WITH its own menu bar — "Displays have
 *  separate Spaces" on, which is the macOS default. */
const SECONDARY_WITH_MENU_BAR = {
  bounds: { x: -1920, y: -180, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -180 + MENU_BAR_PX, width: 1920, height: 1080 - MENU_BAR_PX }
};

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
    // win32: no window-server constraint to dodge, so the band is
    // clamped to the display itself and the trailing insets go to zero.
    const plan = planRecordingFrame({
      rect: { x: 1440 - 400, y: 900 - 300, w: 400, h: 300 },
      display: PRIMARY,
      platform: "win32"
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

    test("macOS keeps the window inside the work area and lets the insets go negative", () => {
      // The whole display is recorded, but the menu bar and the Dock are
      // places a window CANNOT be — ask and AppKit moves the window
      // rather than refusing. So the window covers the work area, and
      // the frame's own box is described relative to it: the top and
      // bottom edges sit outside the window and are clipped, which is
      // the only honest answer. What must NOT happen is the whole frame
      // sliding down by the menu bar height, which is what shipped.
      const plan = planRecordingFrame({
        rect: ZERO_RECT,
        display: PRIMARY,
        platform: "darwin"
      });

      expect(plan?.mode).toBe("straddle");
      expect(plan?.bounds).toEqual({
        x: 0,
        y: MENU_BAR_PX,
        width: 1440,
        height: 900 - MENU_BAR_PX - DOCK_PX
      });
      expect(plan?.inset).toEqual({ left: 0, top: -MENU_BAR_PX, right: 0, bottom: -DOCK_PX });
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

/**
 * The regression this block exists for. The frame drew ~26px BELOW the
 * window it was framing and hung off the bottom by the same amount, on
 * a plain single-display Mac — while the picker and the recorded file
 * were both correct.
 *
 * Cause: `BrowserWindow` is not the last word on where a window goes.
 * AppKit runs `-[NSWindow constrainFrameRect:toScreen:]` and moves any
 * window that would sit outside `NSScreen.visibleFrame` — Electron's
 * `display.workArea`. Measured on macOS 26 / Electron 41.10.7, a
 * 1440x900-equivalent display with a 30px menu bar and an 89px Dock:
 *
 *   requested y=400 -> y=400  (fits; untouched)
 *   requested y=23  -> y=30   (+7,  pushed below the menu bar)
 *   requested y=4   -> y=30   (+26, pushed below the menu bar)
 *   requested y=0   -> y=30   (+30, pushed below the menu bar)
 *   y=600 h=500     -> y=491  (-109, pulled above the Dock)
 *   x=-50           -> x=0    (pulled onto the screen)
 *
 * Three things make it nasty, and each one is a reason a test here is
 * the only place it can be caught:
 *
 *   - The height is NEVER adjusted, only the origin. So the window
 *     keeps its size and slides — exactly "shifted down, hanging off
 *     the bottom by the same amount".
 *   - `getBounds()` straight after the constructor reports what we
 *     ASKED for. The move lands on `show()`, and `recording-frame.ts`
 *     records the constructor bounds as placed and never re-asserts
 *     them. Nothing in main can see the difference.
 *   - No window level escapes it. floating, status, pop-up-menu and
 *     screen-saver were all measured; all four were moved.
 *
 * The fix is to never ask: clamp to the work area on macOS so the
 * window always fits where AppKit is willing to put it, and let the
 * insets carry the difference so the frame still lands on the rect.
 */
describe("the window server moves a window it does not like — do not give it one", () => {
  /** What the renderer reconstructs from the window plus the insets. */
  function drawnRect(plan: NonNullable<ReturnType<typeof planRecordingFrame>>) {
    return {
      x: plan.bounds.x + plan.inset.left,
      y: plan.bounds.y + plan.inset.top,
      w: plan.bounds.width - plan.inset.left - plan.inset.right,
      h: plan.bounds.height - plan.inset.top - plan.inset.bottom
    };
  }

  test("a window flush under the menu bar is framed on the rect, not below it", () => {
    // The reported case, and the common one: a maximized/zoomed macOS
    // window sits at exactly the top of the work area, so the band
    // above it lands under the menu bar.
    const rect = { x: 120, y: MENU_BAR_PX, w: 1200, h: 700 };
    const plan = planRecordingFrame({ rect, display: PRIMARY, platform: "darwin" });

    expect(plan).not.toBeNull();
    if (plan === null) return;
    // Never above the work area — anything less and AppKit slides the
    // whole window down by the difference.
    expect(plan.bounds.y).toBeGreaterThanOrEqual(PRIMARY.workArea.y);
    // ...and the frame still draws on the rect, with a thinner band.
    expect(drawnRect(plan)).toEqual(rect);
    expect(plan.inset.top).toBe(0);
    expect(plan.inset.left).toBe(BAND);
  });

  test("a region near the Dock keeps its anchor by shrinking, not sliding", () => {
    const workAreaBottom = PRIMARY.workArea.y + PRIMARY.workArea.height;
    const rect = { x: 300, y: workAreaBottom - 200, w: 500, h: 200 };
    const plan = planRecordingFrame({ rect, display: PRIMARY, platform: "darwin" });

    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.bounds.y + plan.bounds.height).toBeLessThanOrEqual(workAreaBottom);
    expect(drawnRect(plan)).toEqual(rect);
  });

  test("every darwin plan fits inside the work area", () => {
    const workArea = PRIMARY.workArea;
    const cases = [
      { x: 0, y: 0, w: 1440, h: 900 },
      { x: 120, y: MENU_BAR_PX, w: 1200, h: 700 },
      { x: 0, y: 40, w: 400, h: 300 },
      { x: 1040, y: 600, w: 400, h: 300 },
      { x: 300, y: 200, w: 640, h: 400 },
      { x: 700, y: 770, w: 300, h: 120 }
    ];
    for (const rect of cases) {
      const plan = planRecordingFrame({ rect, display: PRIMARY, platform: "darwin" });
      expect(plan, JSON.stringify(rect)).not.toBeNull();
      if (plan === null) continue;
      const label = JSON.stringify(rect);
      expect(plan.bounds.x, label).toBeGreaterThanOrEqual(workArea.x);
      expect(plan.bounds.y, label).toBeGreaterThanOrEqual(workArea.y);
      expect(plan.bounds.x + plan.bounds.width, label).toBeLessThanOrEqual(
        workArea.x + workArea.width
      );
      expect(plan.bounds.y + plan.bounds.height, label).toBeLessThanOrEqual(
        workArea.y + workArea.height
      );
      // The property the whole module exists for: whatever we had to
      // give up, the box the renderer draws is still the recorded rect.
      expect(drawnRect(plan), label).toEqual(rect);
    }
  });

  test("a secondary display is clamped against its OWN menu bar", () => {
    // The origin translation and the clamp have to compose. A clamp
    // written against the primary's work area would put the window on
    // the wrong display entirely.
    const display = SECONDARY_WITH_MENU_BAR;
    const rect = { x: 200, y: MENU_BAR_PX, w: 800, h: 600 };
    const plan = planRecordingFrame({ rect, display, platform: "darwin" });

    expect(plan).not.toBeNull();
    if (plan === null) return;
    expect(plan.bounds.y).toBe(display.workArea.y);
    expect(drawnRect(plan)).toEqual({
      x: display.bounds.x + rect.x,
      y: display.bounds.y + rect.y,
      w: rect.w,
      h: rect.h
    });
  });

  test("Windows and Linux are untouched — they clamp to the display, not the work area", () => {
    // There is no `constrainFrameRect` off macOS, and the outset
    // posture already depends on every pixel of band it can get. A
    // clamp here would cost glow for nothing.
    const rect = { x: 120, y: 0, w: 1200, h: 700 };
    for (const platform of ["win32", "linux"] as const) {
      const plan = planRecordingFrame({ rect, display: PRIMARY, platform });
      expect(plan?.bounds.y, platform).toBe(0);
      expect(plan?.inset.top, platform).toBe(0);
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
