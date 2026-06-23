import { describe, expect, test } from "vitest";
import { nextGridSelectionId, GRID_NAV_KEYS } from "../grid-nav";

// A 10-item grid, 4 cells per row, 2 rows per page:
//   row0: a b c d
//   row1: e f g h
//   row2: i j
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const CPR = 4;
const RPP = 2;

describe("nextGridSelectionId — within the grid", () => {
  test("right / left move by one in reading order", () => {
    expect(nextGridSelectionId(IDS, "f", "right", CPR, RPP)).toBe("g");
    expect(nextGridSelectionId(IDS, "f", "left", CPR, RPP)).toBe("e");
  });

  test("down / up move by a row (cellsPerRow)", () => {
    expect(nextGridSelectionId(IDS, "b", "down", CPR, RPP)).toBe("f"); // b → f
    expect(nextGridSelectionId(IDS, "f", "up", CPR, RPP)).toBe("b"); // f → b
  });

  test("page down / up move by cellsPerRow × rowsPerPage", () => {
    // a (idx 0) + 4*2 = idx 8 → i
    expect(nextGridSelectionId(IDS, "a", "pagedown", CPR, RPP)).toBe("i");
    // i (idx 8) - 8 = idx 0 → a
    expect(nextGridSelectionId(IDS, "i", "pageup", CPR, RPP)).toBe("a");
  });
});

describe("nextGridSelectionId — clamping at the edges (no wrap)", () => {
  test("left at the first cell stays put", () => {
    expect(nextGridSelectionId(IDS, "a", "left", CPR, RPP)).toBe("a");
  });
  test("right at the last cell stays put", () => {
    expect(nextGridSelectionId(IDS, "j", "right", CPR, RPP)).toBe("j");
  });
  test("up from the top row clamps to the first cell", () => {
    expect(nextGridSelectionId(IDS, "c", "up", CPR, RPP)).toBe("a"); // c-4 → clamp 0
  });
  test("down from the last (partial) row clamps to the last cell", () => {
    expect(nextGridSelectionId(IDS, "i", "down", CPR, RPP)).toBe("j"); // i+4 → clamp 9
  });
  test("page down past the end clamps to the last cell", () => {
    expect(nextGridSelectionId(IDS, "h", "pagedown", CPR, RPP)).toBe("j");
  });
});

describe("nextGridSelectionId — no current selection enters from an end", () => {
  test("forward keys select the first cell", () => {
    for (const dir of ["right", "down", "pagedown"] as const) {
      expect(nextGridSelectionId(IDS, null, dir, CPR, RPP)).toBe("a");
    }
  });
  test("backward keys select the last cell", () => {
    for (const dir of ["left", "up", "pageup"] as const) {
      expect(nextGridSelectionId(IDS, null, dir, CPR, RPP)).toBe("j");
    }
  });
  test("a stale selection (not in the list) is treated as no selection", () => {
    expect(nextGridSelectionId(IDS, "gone", "right", CPR, RPP)).toBe("a");
  });
});

describe("nextGridSelectionId — degenerate inputs", () => {
  test("empty grid returns null", () => {
    expect(nextGridSelectionId([], "a", "right", CPR, RPP)).toBeNull();
  });
  test("cellsPerRow / rowsPerPage below 1 are floored to 1", () => {
    expect(nextGridSelectionId(IDS, "a", "down", 0, 0)).toBe("b"); // cpr→1
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
