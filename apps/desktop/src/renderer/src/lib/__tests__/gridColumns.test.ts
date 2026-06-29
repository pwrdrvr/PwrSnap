import { describe, expect, test } from "vitest";
import { NARROW_GRID_PANE_PX, resolveColumnCount } from "../gridColumns";

const GAP = 12;
const TARGET = 180;

describe("resolveColumnCount", () => {
  test("rounds to the column count whose cell width is closest to the target", () => {
    // (inner+gap)/(target+gap) = 5.60 → nearest is 6, not floor's 5.
    expect(resolveColumnCount(1063, TARGET, 0, GAP)).toBe(6);
    // 5.27 → nearest is 5.
    expect(resolveColumnCount(980, TARGET, 0, GAP)).toBe(5);
  });

  test("keeps more columns when shrinking than the old floor math (breakpoint at the midpoint)", () => {
    // (inner+gap)/(target+gap) = 3.60 → round keeps 4 columns. The old floor
    // math dropped to 3 here (cells jumping ~33% bigger); round only drops at
    // 3.5 → a smaller jump and a later breakpoint.
    expect(resolveColumnCount(679, TARGET, 0, GAP)).toBe(4);
  });

  test("keeps every cell within a tight band around the target", () => {
    // The whole point of round-to-target: across the normal (non-narrow)
    // width range, no cell balloons far from the target. The old floor math
    // let cells reach ~1.5× the target at low column counts before adding a
    // column; round keeps them in ~[0.8×, 1.25×].
    for (let inner = NARROW_GRID_PANE_PX; inner <= 2400; inner++) {
      const cols = resolveColumnCount(inner, TARGET, 0, GAP);
      const cell = (inner - (cols - 1) * GAP) / cols;
      expect(cell).toBeGreaterThan(TARGET * 0.8);
      expect(cell).toBeLessThan(TARGET * 1.25);
    }
  });

  test("raises the target on a narrow pane (fewer, bigger cells)", () => {
    // inner 500 (< NARROW_GRID_PANE_PX): target raised to 220 → 2 cols.
    // At the un-raised 180 target it would round to 3.
    expect(resolveColumnCount(500, TARGET, 0, GAP)).toBe(2);
  });

  test("applies the column bias on top of the width-driven count", () => {
    expect(resolveColumnCount(1063, TARGET, -2, GAP)).toBe(4); // 6 − 2
    expect(resolveColumnCount(1063, TARGET, 1, GAP)).toBe(7); // 6 + 1
  });

  test("caps a positive bias so added columns can't make sub-hard-min cells", () => {
    // base 3 cols at inner 600; +3 would be 6, but only 5 fit above the
    // ~96px hard-min cell, so it's capped at 5.
    expect(resolveColumnCount(600, TARGET, 3, GAP)).toBe(5);
  });

  test("floors at 1 column and treats non-positive widths as 1", () => {
    expect(resolveColumnCount(500, TARGET, -3, GAP)).toBe(1);
    expect(resolveColumnCount(0, TARGET, 0, GAP)).toBe(1);
    expect(resolveColumnCount(-10, TARGET, 0, GAP)).toBe(1);
  });
});
