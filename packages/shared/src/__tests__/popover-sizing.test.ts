import { describe, expect, test } from "vitest";
import {
  FLOAT_OVER_WIDTH_COMPACT_DIP,
  FLOAT_OVER_WIDTH_REGULAR_DIP,
  TRAY_WIDTH_COMPACT_DIP,
  TRAY_WIDTH_REGULAR_DIP,
  floatOverRailFits,
  popoverDensityForWorkArea,
  popoverWidthCss,
  popoverWidthDip
} from "../popover-sizing";

describe("responsive popover sizing", () => {
  test("roomy work areas preserve the shipped widths", () => {
    expect(popoverDensityForWorkArea({ widthDip: 1440, heightDip: 900 })).toBe("regular");
    expect(
      popoverWidthDip({ kind: "tray", workAreaWidthDip: 1440, workAreaHeightDip: 900 })
    ).toBe(TRAY_WIDTH_REGULAR_DIP);
    expect(
      popoverWidthDip({ kind: "float-over", workAreaWidthDip: 1440, workAreaHeightDip: 900 })
    ).toBe(FLOAT_OVER_WIDTH_REGULAR_DIP);
  });

  test.each([
    [1366, 728],
    [1280, 680],
    [526, 690]
  ])("%sx%s work areas use compact widths", (widthDip, heightDip) => {
    expect(popoverDensityForWorkArea({ widthDip, heightDip })).toBe("compact");
    expect(popoverWidthDip({ kind: "tray", workAreaWidthDip: widthDip, workAreaHeightDip: heightDip })).toBe(
      TRAY_WIDTH_COMPACT_DIP
    );
    expect(
      popoverWidthDip({ kind: "float-over", workAreaWidthDip: widthDip, workAreaHeightDip: heightDip })
    ).toBe(FLOAT_OVER_WIDTH_COMPACT_DIP);
  });

  test("the recent rail drops out before it crowds a narrow work area", () => {
    expect(floatOverRailFits(526)).toBe(false);
    expect(floatOverRailFits(699)).toBe(false);
    expect(floatOverRailFits(700)).toBe(true);
    expect(floatOverRailFits(null)).toBe(true);
  });

  test("unknown dimensions fall back safely and tiny widths still fit", () => {
    expect(popoverDensityForWorkArea({ widthDip: 0, heightDip: Number.NaN })).toBe("regular");
    expect(
      popoverWidthDip({ kind: "tray", workAreaWidthDip: null, workAreaHeightDip: undefined })
    ).toBe(TRAY_WIDTH_REGULAR_DIP);
    expect(popoverWidthDip({ kind: "tray", workAreaWidthDip: 300, workAreaHeightDip: 900 })).toBe(292);
    expect(
      popoverWidthDip({ kind: "float-over", workAreaWidthDip: 300, workAreaHeightDip: 900 })
    ).toBe(252);
  });

  test("CSS widths convert through zoom without exceeding the DIP target", () => {
    const css = popoverWidthCss({
      kind: "float-over",
      workAreaWidthDip: 526,
      workAreaHeightDip: 690,
      zoomFactor: 1.25
    });
    expect(css).toBe(256);
    expect(Math.ceil(css * 1.25)).toBe(FLOAT_OVER_WIDTH_COMPACT_DIP);
  });
});
