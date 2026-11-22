import type { Profiler } from "node:inspector";
import fc from "fast-check";
import { expect, test } from "vitest";
import { joinCpuProfiles } from "../cpu-profile-history";

function chunk(start: number, label: string, deltas: number[]): Profiler.Profile {
  const node = (id: number, functionName: string) => ({
    id, callFrame: { functionName, scriptId: "", url: "", lineNumber: 0, columnNumber: 0 }
  });
  return {
    nodes: [{ ...node(1, "(root)"), children: [2, 3] }, node(2, label), node(3, "(idle)")],
    startTime: start,
    endTime: start + deltas.reduce((time, delta) => time + delta, 0) + 1,
    samples: deltas.map((_delta, index) => index % 2 === 0 ? 2 : 3),
    timeDeltas: deltas
  };
}

function timeline(profile: Profiler.Profile) {
  const names = new Map(profile.nodes.map(({ id, callFrame }) => [id, callFrame.functionName]));
  let timestamp = profile.startTime;
  return profile.samples!.map((id, index) => {
    timestamp += profile.timeDeltas![index]!;
    return [names.get(id), timestamp];
  });
}

test("rotation preserves V8 sample timestamps and never attributes its gap to a real frame", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1 }),
    fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1 }),
    fc.integer({ min: 1, max: 1000 }),
    (before, after, gap) => {
      const first = chunk(10_000, "beforeRotation", before);
      const second = chunk(first.endTime + gap, "afterRotation", after);
      const merged = joinCpuProfiles([first, second]);
      expect(timeline(merged)).toEqual([
        ...timeline(first), ["(unrecorded)", first.endTime], ["(root)", second.startTime], ...timeline(second)
      ]);
      expect(merged.nodes.filter(({ callFrame }) => callFrame.functionName === "(idle)")).toHaveLength(1);
      expect(merged.endTime).toBe(second.endTime);
    }
  ));
});
