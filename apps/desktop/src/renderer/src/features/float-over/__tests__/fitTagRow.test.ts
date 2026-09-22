import { describe, expect, test } from "vitest";
import { fitTagChips } from "../fitTagRow";

// The float-over's tag row is 366px wide with a 4px gap; the "+N" chip is
// 30px and the input's min-width is 60px. Each width below also pays the
// function's 1px rounding slack.
const ROW = { rowWidth: 366, gap: 4, moreWidth: 30, inputMinWidth: 60 };

describe("fitTagChips", () => {
  test("an unmeasured row shows every chip rather than collapsing blind", () => {
    expect(fitTagChips([80, 80, 80], { ...ROW, rowWidth: 0 })).toBe(3);
  });

  test("chips that fit on one line with the input all show", () => {
    expect(fitTagChips([60, 90], ROW)).toBe(2);
  });

  // The case that shifted the toast: two accepted tags and two suggestions
  // wrap to a second line. Two lines is the row's reserved height, so all
  // four stay visible.
  test("a second line is inside the row's height", () => {
    expect(fitTagChips([67, 103, 109, 121], ROW)).toBe(4);
  });

  test("chips that would need a third line collapse, leaving room for +N and the input", () => {
    // Line 1: 150 + 150. Line 2 must hold the next chips, "+N" and the
    // 60px input: 150 + 30 + 60 + gaps fits, a second 150 does not.
    expect(fitTagChips([150, 150, 150, 150, 150], ROW)).toBe(3);
  });

  test("the input alone forcing a third line is enough to collapse", () => {
    // 180 + 180 fill line 1, 180 + 180 fill line 2; the input has nowhere
    // to go, so the last chip gives way to "+1" and the input.
    expect(fitTagChips([180, 180, 180, 180], ROW)).toBe(3);
  });

  test("a chip wider than the row takes a line of its own", () => {
    expect(fitTagChips([500, 40], ROW)).toBe(2);
    expect(fitTagChips([500, 500, 40], ROW)).toBe(1);
  });
});
