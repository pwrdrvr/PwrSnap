import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { resolveSizzleText, SizzleTimelineSchema } from "../sizzle-timeline";

describe("binding expansion work", () => {
  it("resolves shared empty dependencies with work proportional to the graph", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 18 }),
        fc.integer({ min: 2, max: 20 }),
        (depth, fanout) => {
          const bindings = Object.fromEntries(
            Array.from({ length: depth }, (_, i) => [
              `b${i}`,
              i === depth - 1 ? "" : `{{b${i + 1}}}`.repeat(fanout),
            ]),
          );
          // These are ordinary schema-valid inputs, including the reported
          // 14-node, 20-way empty expansion. Stop the old exponential traversal
          // after a bounded number of reads rather than hanging the test runner.
          const timeline = SizzleTimelineSchema.parse({
            version: 1,
            width: 320,
            height: 180,
            bindings,
            scenes: [{ id: "intro", durationFrames: 30, layers: [] }],
          });
          let reads = 0;
          const measured = new Proxy(timeline.bindings, {
            get(target, key: string) {
              if (++reads > depth * fanout + 1)
                throw new Error("Binding work exceeded graph size");
              return target[key];
            },
          });
          expect(resolveSizzleText("{{b0}}", measured)).toBe("");
          expect(reads).toBeLessThanOrEqual(depth);
        },
      ),
      { examples: [[14, 20]] },
    );
  });

  it("enforces path depth even when a dependency was already resolved", () => {
    const bindings = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [
        `b${i}`,
        i === 20 ? "done" : `{{b${i + 1}}}`,
      ]),
    );
    expect(() => resolveSizzleText("{{b20}} {{b0}}", bindings)).toThrow(
      "maximum depth",
    );
    expect(resolveSizzleText("{{b20}} {{b1}}", bindings)).toBe("done done");
  });

  it("retains formatting, cycle detection and the expanded-output bound", () => {
    expect(
      resolveSizzleText("{{n}} {{n|number}} {{caption}}", {
        n: 12345,
        caption: "{{n|number}} files",
      }),
    ).toBe("12345 12,345 12,345 files");
    expect(() =>
      resolveSizzleText("{{a}}", { a: "{{b}}", b: "{{a}}" }),
    ).toThrow("acyclic");
    const bindings = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `b${i}`,
        i === 15 ? "x" : `{{b${i + 1}}}{{b${i + 1}}}`,
      ]),
    );
    expect(() => resolveSizzleText("{{b0}}", bindings)).toThrow("16000");
  });
});
