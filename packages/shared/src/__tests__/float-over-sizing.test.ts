import { describe, expect, test } from "vitest";
import {
  FLOAT_OVER_ANCHOR_MARGIN_DIP,
  FLOAT_OVER_HEIGHT_MAX_DIP,
  FLOAT_OVER_HEIGHT_MIN_DIP,
  floatOverMaxContentHeightCss,
  floatOverMaxContentHeightDip
} from "../float-over-sizing";

describe("float-over content ceiling", () => {
  test("a roomy display gets the constant ceiling", () => {
    // 1440p work area: the display is not the binding constraint.
    expect(floatOverMaxContentHeightDip(1415)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
  });

  test("a short display binds instead, keeping both anchor margins", () => {
    // 1366x768 laptop, ~40px of chrome: 728 - 24 - 24.
    expect(floatOverMaxContentHeightDip(728)).toBe(680);
    expect(680).toBe(728 - FLOAT_OVER_ANCHOR_MARGIN_DIP * 2);
  });

  test("an unknown work area falls back to the constant ceiling alone", () => {
    // The renderer passes null before its window is on a display, and
    // main passes null before the first anchor. Neither may collapse
    // the toast to nothing.
    expect(floatOverMaxContentHeightDip(null)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
    expect(floatOverMaxContentHeightDip(undefined)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
    expect(floatOverMaxContentHeightDip(Number.NaN)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
  });

  test("a zero or negative work area means UNKNOWN, not a 0px display", () => {
    // jsdom reports `screen.availHeight === 0`, and it is a `number` —
    // so a bare isFinite guard admits it, the ceiling becomes -48, the
    // floor takes over, and the toast caps at 160px with its footer
    // unreachable. Absence of information must not constrain anything.
    expect(floatOverMaxContentHeightDip(0)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
    expect(floatOverMaxContentHeightDip(-1)).toBe(FLOAT_OVER_HEIGHT_MAX_DIP);
    expect(floatOverMaxContentHeightCss({ workAreaHeightDip: 0, zoomFactor: 1 })).toBe(
      FLOAT_OVER_HEIGHT_MAX_DIP
    );
  });

  test("the floor wins over an absurdly short work area", () => {
    // Handing main a ceiling below its own floor would just be clamped
    // back up, and the renderer would have scrolled content it did not
    // need to.
    expect(floatOverMaxContentHeightDip(100)).toBe(FLOAT_OVER_HEIGHT_MIN_DIP);
  });

  test("CSS pixels are DIP divided by the zoom factor main multiplies by", () => {
    expect(floatOverMaxContentHeightCss({ workAreaHeightDip: 1415, zoomFactor: 1 })).toBe(800);
    expect(floatOverMaxContentHeightCss({ workAreaHeightDip: 1415, zoomFactor: 2 })).toBe(400);
    expect(floatOverMaxContentHeightCss({ workAreaHeightDip: 1415, zoomFactor: 0.5 })).toBe(1600);
  });

  test("a fractional zoom floors, so main's ceil cannot land over the clamp", () => {
    // main re-derives DIP as ceil(css * zoom). At zoom 1.1 a rounded-up
    // 728 css would come back 801 DIP — one pixel of footer border,
    // clipped.
    const css = floatOverMaxContentHeightCss({ workAreaHeightDip: 1415, zoomFactor: 1.1 });
    expect(css).toBe(727);
    expect(Math.ceil(css * 1.1)).toBeLessThanOrEqual(FLOAT_OVER_HEIGHT_MAX_DIP);
  });

  test("a nonsense zoom factor degrades to 1:1 rather than to zero or Infinity", () => {
    for (const zoomFactor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(floatOverMaxContentHeightCss({ workAreaHeightDip: null, zoomFactor })).toBe(
        FLOAT_OVER_HEIGHT_MAX_DIP
      );
    }
  });

  test("the ceiling cannot be a function of the toast window's own size", () => {
    // The invariant this module exists for, pinned at the signature:
    // there is nowhere to pass a window height. Deriving the cap from
    // the current window (100vh / innerHeight) makes the measured
    // wrapper report min(natural, current window), so main sizes the
    // window to that and the toast can never grow back — strictly
    // worse than the clipping it would be replacing.
    //
    // A weaker but executable form of the same claim: hold the display
    // and zoom fixed, and the answer is a constant.
    const answers = new Set(
      [0, 1, 200, 788, 800, 4000].map(() =>
        floatOverMaxContentHeightCss({ workAreaHeightDip: 728, zoomFactor: 1 })
      )
    );
    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe(728 - FLOAT_OVER_ANCHOR_MARGIN_DIP * 2);
  });
});
