import { describe, expect, test } from "vitest";
import { nextGridSelectionId, GRID_NAV_KEYS } from "../grid-nav";

// One day of 10 items, 4 cells per row → visual rows:
//   row0: a b c d
//   row1: e f g h
//   row2: i j
const ONE_DAY = [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]];
const CPR = 4;
const RPP = 2;

describe("nextGridSelectionId — within a single day", () => {
  test("right / left move by one in reading order (wrapping rows)", () => {
    expect(nextGridSelectionId(ONE_DAY, "f", "right", CPR, RPP)).toBe("g");
    expect(nextGridSelectionId(ONE_DAY, "f", "left", CPR, RPP)).toBe("e");
    expect(nextGridSelectionId(ONE_DAY, "d", "right", CPR, RPP)).toBe("e"); // end of row0 → start of row1
  });

  test("down / up move a visual row, same column", () => {
    expect(nextGridSelectionId(ONE_DAY, "b", "down", CPR, RPP)).toBe("f"); // col1 row0 → col1 row1
    expect(nextGridSelectionId(ONE_DAY, "f", "up", CPR, RPP)).toBe("b");
    expect(nextGridSelectionId(ONE_DAY, "d", "down", CPR, RPP)).toBe("h"); // col3
  });

  test("down onto a shorter last row clamps the column", () => {
    // d is col3 of row0; row2 (i j) has no col3 → clamp to j.
    expect(nextGridSelectionId(ONE_DAY, "d", "pagedown", CPR, RPP)).toBe("j");
    // c is col2; row2 has no col2 → clamp to j.
    expect(nextGridSelectionId(ONE_DAY, "g", "down", CPR, RPP)).toBe("j"); // g col2 row1 → row2 clamp → j
  });

  test("up/down clamp at the top/bottom rows", () => {
    expect(nextGridSelectionId(ONE_DAY, "c", "up", CPR, RPP)).toBe("c"); // already top row
    expect(nextGridSelectionId(ONE_DAY, "j", "down", CPR, RPP)).toBe("j"); // already bottom row
  });

  test("left/right clamp at the first/last item", () => {
    expect(nextGridSelectionId(ONE_DAY, "a", "left", CPR, RPP)).toBe("a");
    expect(nextGridSelectionId(ONE_DAY, "j", "right", CPR, RPP)).toBe("j");
  });
});

describe("nextGridSelectionId — across day boundaries (the reported bug)", () => {
  // Mirrors the screenshots: a 2-item day above a 4-item day.
  //   day0 (Jun 21): C D
  //   day1 (Jun 18): E F G H
  const TWO_THEN_FOUR = [
    ["C", "D"],
    ["E", "F", "G", "H"]
  ];

  test("down from the 2nd item of a short row lands in the SAME column below", () => {
    // Was the bug: +cellsPerRow jumped D→H. Should be D (col1) → F (col1).
    expect(nextGridSelectionId(TWO_THEN_FOUR, "D", "down", CPR, RPP)).toBe("F");
    expect(nextGridSelectionId(TWO_THEN_FOUR, "C", "down", CPR, RPP)).toBe("E");
  });

  test("up from a wide row clamps the column to the short row above", () => {
    expect(nextGridSelectionId(TWO_THEN_FOUR, "H", "up", CPR, RPP)).toBe("D"); // col3 → clamp col1
    expect(nextGridSelectionId(TWO_THEN_FOUR, "E", "up", CPR, RPP)).toBe("C");
  });

  test("down from a single-item day moves into the next day's first column", () => {
    // day0 (Jun 23): a single Safari capture; day1: two items.
    const ONE_THEN_TWO = [["safari"], ["pwragent", "electron"]];
    expect(nextGridSelectionId(ONE_THEN_TWO, "safari", "down", CPR, RPP)).toBe("pwragent");
  });
});

describe("nextGridSelectionId — no current selection enters from an end", () => {
  test("forward keys select the first cell", () => {
    for (const dir of ["right", "down", "pagedown"] as const) {
      expect(nextGridSelectionId(ONE_DAY, null, dir, CPR, RPP)).toBe("a");
    }
  });
  test("backward keys select the last cell", () => {
    for (const dir of ["left", "up", "pageup"] as const) {
      expect(nextGridSelectionId(ONE_DAY, null, dir, CPR, RPP)).toBe("j");
    }
  });
  test("a stale selection (not present) is treated as no selection", () => {
    expect(nextGridSelectionId(ONE_DAY, "gone", "right", CPR, RPP)).toBe("a");
  });
});

describe("nextGridSelectionId — degenerate inputs", () => {
  test("empty grid returns null", () => {
    expect(nextGridSelectionId([], "a", "right", CPR, RPP)).toBeNull();
    expect(nextGridSelectionId([[]], "a", "right", CPR, RPP)).toBeNull();
  });
  test("cellsPerRow / rowsPerPage below 1 are floored to 1", () => {
    // cpr→1: every item is its own row, so ↓ is just the next item.
    expect(nextGridSelectionId(ONE_DAY, "a", "down", 0, 0)).toBe("b");
  });
});

describe("GRID_NAV_KEYS map", () => {
  test("maps the six navigation keys", () => {
    expect(GRID_NAV_KEYS.ArrowLeft).toBe("left");
    expect(GRID_NAV_KEYS.ArrowRight).toBe("right");
    expect(GRID_NAV_KEYS.ArrowUp).toBe("up");
    expect(GRID_NAV_KEYS.ArrowDown).toBe("down");
    expect(GRID_NAV_KEYS.PageUp).toBe("pageup");
    expect(GRID_NAV_KEYS.PageDown).toBe("pagedown");
    expect(GRID_NAV_KEYS.Enter).toBeUndefined();
  });
});
