import fc from "fast-check";
import { expect, test } from "vitest";
import { migrateHotCpuCaptureRules } from "@pwrsnap/shared";
import { resolveHotCpuProfileConfig } from "../hot-cpu-profile-config";
import { HotCpuRuleDetector } from "../hot-cpu-rule-detector";

test("enabled rules agree with an independent sliding-window oracle at either cadence", () => {
  fc.assert(fc.property(
    fc.boolean(), fc.boolean(), fc.boolean(),
    fc.integer({ min: 1, max: 400 }), fc.integer({ min: 1, max: 400 }),
    fc.constantFrom(4000, 10000, 30000, 60000),
    fc.array(fc.integer({ min: 0, max: 450 }), { minLength: 1, maxLength: 100 }),
    (oneSecondSpike, high, slowburn, highThreshold, slowThreshold, slowDuration, cpu) => {
      fc.pre(high || slowburn);
      const settings = migrateHotCpuCaptureRules();
      settings.high = { enabled: high, mode: oneSecondSpike ? "spike" : "sustained" };
      settings.spike = { thresholdPercent: highThreshold, durationMs: oneSecondSpike ? 1000 : 2000 };
      settings.sustained.thresholdPercent = highThreshold;
      settings.slowburn = { enabled: slowburn, thresholdPercent: slowThreshold, durationMs: slowDuration as 4000 | 10000 | 30000 | 60000 };
      const config = resolveHotCpuProfileConfig({ enabled: true, env: {}, captureRules: settings });
      if (!config.enabled) throw new Error("capture disabled");
      const cadence = oneSecondSpike && high ? 1000 : 2000;
      expect(config.intervalMs).toBe(cadence);
      const detector = new HotCpuRuleDetector(config.rules!, cadence);
      detector.sample({ pid: 1, timeMs: 0, cumulative: 0, electronCpuPercent: 900 });
      let cumulative = 0;
      for (const [index, percent] of cpu.entries()) {
        cumulative += percent * cadence / 100_000;
        const actual = detector.sample({ pid: 1, timeMs: cadence * (index + 1), cumulative, electronCpuPercent: 900 });
        const covered = (count: number, threshold: number) =>
          index + 1 >= count && cpu.slice(index + 1 - count, index + 1).every((value) => value >= threshold);
        expect(actual.matches.map(({ id }) => id)).toEqual([
          ...(high && covered(oneSecondSpike ? 1 : 2, highThreshold)
            ? [oneSecondSpike ? "spike" : "sustained"] : []),
          ...(slowburn && covered(slowDuration / cadence, slowThreshold) ? ["slowburn"] : [])
        ]);
        for (const match of actual.matches) {
          expect(match.triggerCpuPercent).toBeCloseTo(percent);
          expect(match.observedDurationMs).toBe(match.durationMs);
        }
      }
    }
  ));
});

test("migrated modes agree with the legacy threshold and count oracle for valid intervals", () => {
  fc.assert(fc.property(
    fc.constantFrom("spike" as const, "sustained" as const, "slowburn" as const),
    fc.integer({ min: 1, max: 100 }),
    fc.array(fc.integer({ min: 0, max: 150 })),
    (mode, slowThreshold, cpu) => {
      const config = resolveHotCpuProfileConfig({ enabled: true, env: {}, captureRules: migrateHotCpuCaptureRules(mode, slowThreshold) });
      if (!config.enabled) throw new Error("capture disabled");
      const detector = new HotCpuRuleDetector(config.rules!, 2000);
      detector.sample({ pid: 1, timeMs: 0, electronCpuPercent: 0 });
      let consecutive = 0;
      const threshold = mode === "slowburn" ? slowThreshold : 50;
      for (const [index, percent] of cpu.entries()) {
        consecutive = percent >= threshold ? consecutive + 1 : 0;
        const result = detector.sample({ pid: 1, timeMs: (index + 1) * 2000, electronCpuPercent: percent });
        expect(result.matches.length > 0).toBe(consecutive >= (mode === "spike" ? 1 : 2));
      }
    }
  ));
});

test("counts elapsed evidence and resets on a 2s gap at 1s cadence, PID change, missing readings and counter reset", () => {
  const detector = new HotCpuRuleDetector([
    { id: "spike", thresholdPercent: 50, durationMs: 1000, sampleCount: 1 },
    { id: "slowburn", thresholdPercent: 25, durationMs: 4000, sampleCount: 4 }
  ], 1000);
  const sample = (timeMs: number, cumulative: number, pid = 1) =>
    detector.sample({ pid, timeMs, cumulative, electronCpuPercent: 90 }).matches.map(({ id }) => id);
  expect(sample(0, 0)).toEqual([]);
  expect(sample(1000, 0.5)).toEqual(["spike"]);
  expect(sample(3000, 2)).toEqual([]);
  expect(sample(3800, 2.5)).toEqual([]);
  expect(sample(4800, 3)).toEqual(["spike"]);
  expect(sample(5800, 3.5, 2)).toEqual([]);
  expect(sample(6800, 0.01, 2)).toEqual([]);
  expect(sample(7800, 0.51, 2)).toEqual(["spike"]);
  detector.reset();
  expect(sample(8800, 1.01, 2)).toEqual([]);
});

test("at an overridden 3s cadence canonical 1s Spike matches once and 4s Slow burn needs two real samples", () => {
  const rules = migrateHotCpuCaptureRules("spike");
  rules.spike.durationMs = 1000;
  rules.slowburn.enabled = true;
  const config = resolveHotCpuProfileConfig({ enabled: true, captureRules: rules,
    env: { PWRSNAP_HOT_CPU_PROFILING_INTERVAL_MS: "3000" } });
  if (!config.enabled) throw new Error("capture disabled");
  const detector = new HotCpuRuleDetector(config.rules!, config.intervalMs);
  const sample = (timeMs: number) => detector.sample({ pid: 1, timeMs,
    cumulative: timeMs / 1000, electronCpuPercent: 0 }).matches;
  expect(sample(0)).toEqual([]);
  expect(sample(3000)).toMatchObject([{ id: "spike", cadenceMs: 3000, observedDurationMs: 3000 }]);
  expect(sample(6000)).toMatchObject([
    { id: "spike", sampleCount: 1, durationMs: 3000, observedDurationMs: 3000 },
    { id: "slowburn", sampleCount: 2, durationMs: 4000, observedDurationMs: 6000 }
  ]);
  expect(sample(12000)).toEqual([]);
});
