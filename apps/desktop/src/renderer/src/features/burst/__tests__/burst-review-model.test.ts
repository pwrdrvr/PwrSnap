// The Burst Review selection rules, against a plain-set model.
//
// Model: the choice is a set of frame indexes. Toggling flips membership;
// a range adds every frame between the two ends (inclusive, strip order);
// "all" chooses every keepable frame or, when they all already are, none.
// Kept frames (already snaps) are never in the choice, whatever the user
// does. The implementation keeps a sorted array; after every step it must
// equal the model's set, sorted.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  formatOffset,
  reconcileSelection,
  selectRange,
  stampPreview,
  stillGaps,
  toggleAll,
  toggleFrame,
  type Selection
} from "../burst-review-model";

type Op =
  | { kind: "toggle"; pos: number }
  | { kind: "range"; from: number; to: number }
  | { kind: "all" };

const opArb = (n: number): fc.Arbitrary<Op> =>
  fc.oneof(
    fc.record({ kind: fc.constant("toggle" as const), pos: fc.nat(n - 1) }),
    fc.record({ kind: fc.constant("range" as const), from: fc.nat(n - 1), to: fc.nat(n - 1) }),
    fc.record({ kind: fc.constant("all" as const) })
  );

describe("selection", () => {
  test("matches the set model under any sequence of toggles, ranges and select-all", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            // Ring indexes: increasing, with gaps (evicted / skipped frames).
            fc.uniqueArray(fc.nat(500), { minLength: n, maxLength: n }).map((xs) => xs.sort((a, b) => a - b)),
            fc.array(fc.boolean(), { minLength: n, maxLength: n }),
            fc.array(opArb(n), { maxLength: 40 })
          )
        ),
        ([, indexes, keptFlags, ops]) => {
          const frames = indexes.map((index) => ({ index }));
          const kept = new Set(indexes.filter((_, i) => keptFlags[i]));
          const keepable = indexes.filter((i) => !kept.has(i));
          let selection: Selection = [];
          const model = new Set<number>();
          for (const op of ops) {
            if (op.kind === "toggle") {
              const idx = indexes[op.pos]!;
              selection = toggleFrame(selection, idx, kept);
              if (!kept.has(idx)) {
                if (model.has(idx)) model.delete(idx);
                else model.add(idx);
              }
            } else if (op.kind === "range") {
              selection = selectRange(selection, frames, indexes[op.from]!, indexes[op.to]!, kept);
              const [lo, hi] = op.from <= op.to ? [op.from, op.to] : [op.to, op.from];
              for (let p = lo; p <= hi; p++) if (!kept.has(indexes[p]!)) model.add(indexes[p]!);
            } else {
              selection = toggleAll(selection, frames, kept);
              const all = keepable.every((i) => model.has(i));
              model.clear();
              if (!all) for (const i of keepable) model.add(i);
            }
            expect(selection).toEqual([...model].sort((a, b) => a - b));
          }
        }
      ),
      { numRuns: 300 }
    );
  });

  test("reconcile drops exactly the choices that are kept or gone", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat(60), { maxLength: 20 }),
        fc.uniqueArray(fc.nat(60), { maxLength: 20 }),
        fc.uniqueArray(fc.nat(60), { maxLength: 20 }),
        (chosen, present, keptList) => {
          const selection = [...chosen].sort((a, b) => a - b);
          const kept = new Set(keptList);
          const next = reconcileSelection(selection, present.map((index) => ({ index })), kept);
          expect(next).toEqual(selection.filter((i) => present.includes(i) && !kept.has(i)));
        }
      )
    );
  });
});

describe("still gaps", () => {
  test("marks exactly the spacings past one and a half frame intervals", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 2000 }), { maxLength: 40 }), (steps) => {
        let t = 0;
        const frames = [{ index: 0, offsetMs: 0 }];
        steps.forEach((step, i) => {
          t += step;
          frames.push({ index: i + 1, offsetMs: t });
        });
        const gaps = stillGaps(frames, 10);
        const expected = new Map<number, number>();
        steps.forEach((step, i) => {
          if (step > 150) expected.set(i, step);
        });
        expect(gaps).toEqual(expected);
      })
    );
  });
});

describe("time words", () => {
  test("offsets read +S.mmm s", () => {
    expect(formatOffset(0)).toBe("+0.000 s");
    expect(formatOffset(1300)).toBe("+1.300 s");
    expect(formatOffset(61_005.4)).toBe("+61.005 s");
  });

  test("the stamp preview counts from the first kept still", () => {
    const iso = new Date(2026, 10, 21, 9, 15, 30, 250).toISOString();
    expect(stampPreview({ capturedAt: iso, offsetMs: 2700 }, 1200)).toBe("09:15:30.250 (+1.500 s)");
  });
});
