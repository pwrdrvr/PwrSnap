import { describe, expect, test } from "vitest";
import {
  COLUMN_BIAS_RATIO,
  NARROW_GRID_PANE_PX,
  resolveColumnCount
} from "../gridColumns";

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

  test("the nudge scales the target (fewer/larger or more/smaller)", () => {
    // At inner 1063 the un-nudged target (180) rounds to 6 cols. A negative
    // nudge scales the target UP → fewer columns; positive scales it down →
    // more columns.
    expect(resolveColumnCount(1063, TARGET, 0, GAP)).toBe(6);
    expect(resolveColumnCount(1063, TARGET, -2, GAP)).toBe(4);
    expect(resolveColumnCount(1063, TARGET, 1, GAP)).toBe(7);
  });

  test("a nudge keeps cells consistent — no low-column-count balloon", () => {
    // The whole reason for scaling the target instead of offsetting the
    // column count: with a nudge applied, cells still stay in a tight band
    // around the SCALED target at every column count. The old column-offset
    // approach inflated low-count cells (250px @ 4 cols → 322px @ 2 cols).
    const bias = -2;
    const scaledTarget = TARGET * COLUMN_BIAS_RATIO ** -bias;
    for (let inner = NARROW_GRID_PANE_PX; inner <= 2400; inner++) {
      const cols = resolveColumnCount(inner, TARGET, bias, GAP);
      const cell = (inner - (cols - 1) * GAP) / cols;
      expect(cell).toBeGreaterThan(scaledTarget * 0.74);
      expect(cell).toBeLessThan(scaledTarget * 1.3);
    }
  });

  test("caps density so the nudge can't make sub-hard-min cells", () => {
    // A strong +nudge scales the target down toward the ~96px floor; the cap
    // keeps the column count to what fits above the hard min.
    expect(resolveColumnCount(600, TARGET, 3, GAP)).toBe(5);
  });

  test("floors at 1 column and treats non-positive widths as 1", () => {
    expect(resolveColumnCount(500, TARGET, -3, GAP)).toBe(1);
    expect(resolveColumnCount(0, TARGET, 0, GAP)).toBe(1);
    expect(resolveColumnCount(-10, TARGET, 0, GAP)).toBe(1);
  });
});
