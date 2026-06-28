// Pure-function coverage for the four z-order ops. Each case
// asserts the new ORDERING (positional, not z_index values) so the
// tests are robust against changes to Z_GAP. `diffChanges` is exercised
// separately because the assignment policy (only-moved-items get fresh
// z_index = position × gap) is load-bearing for the renderer's "only
// dispatch what actually moved" behavior.

import { describe, expect, test } from "vitest";

import { Z_GAP, computeNewOrder, diffChanges, moveToIndex } from "../z-order";

type Item = { id: string };
const ids = (items: readonly Item[]): string[] => items.map((i) => i.id);
const mk = (...names: string[]): Item[] => names.map((name) => ({ id: name }));

describe("moveToIndex", () => {
  test("moves an item to a lower index", () => {
    expect(ids(moveToIndex(mk("A", "B", "C", "D"), "D", 1))).toEqual(["A", "D", "B", "C"]);
  });
  test("moves an item to a higher index", () => {
    expect(ids(moveToIndex(mk("A", "B", "C", "D"), "A", 2))).toEqual(["B", "C", "A", "D"]);
  });
  test("clamps an out-of-range target", () => {
    expect(ids(moveToIndex(mk("A", "B", "C"), "A", 99))).toEqual(["B", "C", "A"]);
    expect(ids(moveToIndex(mk("A", "B", "C"), "C", -5))).toEqual(["C", "A", "B"]);
  });
  test("a no-op move returns the same reference", () => {
    const items = mk("A", "B", "C");
    expect(moveToIndex(items, "B", 1)).toBe(items);
    expect(moveToIndex(items, "Z", 0)).toBe(items); // unknown id
  });
});

describe("computeNewOrder — forward (one step)", () => {
  test("single-select moves up one slot", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C", "D"), ["B"], "forward"))).toEqual([
      "A",
      "C",
      "B",
      "D"
    ]);
  });

  test("already-on-top single-select is a no-op", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C"), ["C"], "forward"))).toEqual([
      "A",
      "B",
      "C"
    ]);
  });

  test("contiguous multi-select moves as a group", () => {
    // B + C selected → group moves up past D, preserving B-then-C
    // relative order.
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["B", "C"], "forward"))
    ).toEqual(["A", "D", "B", "C"]);
  });

  test("non-contiguous multi-select moves each independently", () => {
    // B + D selected. D's already at the top (no move). B moves past C.
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["B", "D"], "forward"))
    ).toEqual(["A", "C", "B", "D"]);
  });

  test("empty selection is a no-op", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C"), [], "forward"))).toEqual([
      "A",
      "B",
      "C"
    ]);
  });

  test("everything-selected is a no-op (nothing to step past)", () => {
    // Same regression class as "already-on-top single-select" but
    // for the whole stack — if every layer is selected, there's no
    // un-selected neighbor to step over, so the order is unchanged.
    // The toFront/toBack tests already cover this case for the
    // jump-to-edge ops; the per-step forward/backward variants
    // didn't.
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["A", "B", "C", "D"], "forward"))
    ).toEqual(["A", "B", "C", "D"]);
  });
});

describe("computeNewOrder — backward (one step)", () => {
  test("single-select moves down one slot", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C", "D"), ["C"], "backward"))).toEqual([
      "A",
      "C",
      "B",
      "D"
    ]);
  });

  test("already-at-bottom single-select is a no-op", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C"), ["A"], "backward"))).toEqual([
      "A",
      "B",
      "C"
    ]);
  });

  test("contiguous multi-select moves as a group", () => {
    // C + D selected → group moves down past B, preserving C-then-D
    // relative order.
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["C", "D"], "backward"))
    ).toEqual(["A", "C", "D", "B"]);
  });

  test("everything-selected is a no-op (nothing to step past)", () => {
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["A", "B", "C", "D"], "backward"))
    ).toEqual(["A", "B", "C", "D"]);
  });
});

describe("computeNewOrder — toFront", () => {
  test("single-select goes to the very top", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C", "D"), ["A"], "toFront"))).toEqual([
      "B",
      "C",
      "D",
      "A"
    ]);
  });

  test("multi-select moves to the top, preserving relative order", () => {
    // A + C selected → they land at the top with A before C (their
    // original relative order).
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["A", "C"], "toFront"))
    ).toEqual(["B", "D", "A", "C"]);
  });

  test("everything-selected is a no-op", () => {
    expect(
      ids(computeNewOrder(mk("A", "B", "C"), ["A", "B", "C"], "toFront"))
    ).toEqual(["A", "B", "C"]);
  });
});

describe("computeNewOrder — toBack", () => {
  test("single-select goes to the very bottom", () => {
    expect(ids(computeNewOrder(mk("A", "B", "C", "D"), ["D"], "toBack"))).toEqual([
      "D",
      "A",
      "B",
      "C"
    ]);
  });

  test("multi-select moves to the bottom, preserving relative order", () => {
    expect(
      ids(computeNewOrder(mk("A", "B", "C", "D"), ["B", "D"], "toBack"))
    ).toEqual(["B", "D", "A", "C"]);
  });
});

describe("diffChanges", () => {
  test("emits one change per item that moved, with z_index = newPosition × Z_GAP", () => {
    // Before: [A, B, C, D] at positions 0..3
    // After:  [A, C, B, D] — B + C swapped, A + D stayed
    const before = mk("A", "B", "C", "D");
    const after = mk("A", "C", "B", "D");
    expect(diffChanges(before, after)).toEqual([
      { id: "C", newZIndex: 1 * Z_GAP },
      { id: "B", newZIndex: 2 * Z_GAP }
    ]);
  });

  test("returns empty when ordering is unchanged", () => {
    const items = mk("A", "B", "C");
    expect(diffChanges(items, items.slice())).toEqual([]);
  });

  test("ignores items that fell off the new order (deletion is a separate op)", () => {
    const before = mk("A", "B", "C");
    const after = mk("A", "C");
    // Only C's position changed (2 → 1). B is gone — not our concern;
    // delete is dispatched through its own op.
    expect(diffChanges(before, after)).toEqual([{ id: "C", newZIndex: 1 * Z_GAP }]);
  });
});
