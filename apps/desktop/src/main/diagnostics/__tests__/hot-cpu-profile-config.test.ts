import { migrateHotCpuCaptureRules } from "@pwrsnap/shared";
import { describe, expect, test } from "vitest";
import { hotCpuChromiumTraceEnabled, resolveHotCpuProfileConfig } from "../hot-cpu-profile-config";

const baseEnv: NodeJS.ProcessEnv = { PWRSNAP_HOT_CPU_PROFILING: "1" };

describe("resolveHotCpuProfileConfig per-target thresholds", () => {
  test("targets share the generic thresholds by default", () => {
    const rendererConfig = resolveHotCpuProfileConfig({
      env: { ...baseEnv, PWRSNAP_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "60" },
      target: "renderer"
    });
    const mainConfig = resolveHotCpuProfileConfig({
      env: { ...baseEnv, PWRSNAP_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "60" },
      target: "main"
    });

    expect(rendererConfig).toMatchObject({ enabled: true, thresholdPercent: 60 });
    expect(mainConfig).toMatchObject({ enabled: true, thresholdPercent: 60 });
  });

  test("MAIN_* env vars override trigger thresholds for the main target only", () => {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PWRSNAP_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "60",
      PWRSNAP_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT: "20",
      PWRSNAP_HOT_CPU_PROFILING_MAIN_THRESHOLD_PERCENT: "35",
      PWRSNAP_HOT_CPU_PROFILING_MAIN_SLOWBURN_THRESHOLD_PERCENT: "10"
    };

    expect(resolveHotCpuProfileConfig({ env, target: "main" })).toMatchObject({
      thresholdPercent: 35,
      slowburnThresholdPercent: 10
    });
    expect(resolveHotCpuProfileConfig({ env, target: "renderer" })).toMatchObject({
      thresholdPercent: 60,
      slowburnThresholdPercent: 20
    });
    // No target behaves like the renderer (pre-existing callers).
    expect(resolveHotCpuProfileConfig({ env })).toMatchObject({
      thresholdPercent: 60,
      slowburnThresholdPercent: 20
    });
  });
});

test("Chromium capture requires its own explicit opt-in", () => {
  expect(hotCpuChromiumTraceEnabled(baseEnv)).toBe(false);
  expect(hotCpuChromiumTraceEnabled({ PWRSNAP_HOT_CPU_PROFILING_CHROMIUM_TRACE: "off" })).toBe(false);
  expect(hotCpuChromiumTraceEnabled({ PWRSNAP_HOT_CPU_PROFILING_CHROMIUM_TRACE: " true " })).toBe(true);
});

test("legacy fractional thresholds apply exactly until an explicit canonical rule replaces them", () => {
  for (const env of [baseEnv, { ...baseEnv, PWRSNAP_HOT_CPU_PROFILING_TRIGGER_MODE: "slowburn" }]) {
    const legacy = { env, triggerMode: "slowburn" as const, slowburnThresholdPercent: 15.5 };
    expect(resolveHotCpuProfileConfig(legacy)).toMatchObject({
      slowburnThresholdPercent: 15.5, rules: [{ id: "slowburn", thresholdPercent: 15.5 }]
    });
    expect(resolveHotCpuProfileConfig({ ...legacy, captureRules: migrateHotCpuCaptureRules("slowburn", 18) })).toMatchObject({
      slowburnThresholdPercent: 18, rules: [{ id: "slowburn", thresholdPercent: 18 }]
    });
  }
});

test("scripted legacy mode keeps its window, count and per-target threshold precedence", () => {
  const env = {
    ...baseEnv,
    PWRSNAP_HOT_CPU_PROFILING_TRIGGER_MODE: "slowburn",
    PWRSNAP_HOT_CPU_PROFILING_INTERVAL_MS: "3000",
    PWRSNAP_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "3",
    PWRSNAP_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT: "33",
    PWRSNAP_HOT_CPU_PROFILING_MAIN_SLOWBURN_THRESHOLD_PERCENT: "22"
  };
  for (const [target, thresholdPercent] of [["main", 22], ["renderer", 33]] as const) {
    expect(resolveHotCpuProfileConfig({ env, target })).toMatchObject({
      enabled: true, intervalMs: 3000, triggerMode: "slowburn",
      rules: [{ id: "slowburn", thresholdPercent, durationMs: 9000, sampleCount: 3 }]
    });
  }
});

test("canonical rules round 3s cadence up to sufficient samples while a legacy script keeps its count", () => {
  const env = { ...baseEnv, PWRSNAP_HOT_CPU_PROFILING_INTERVAL_MS: "3000" };
  const rules = migrateHotCpuCaptureRules("spike");
  rules.spike.durationMs = 1000;
  rules.slowburn.enabled = true;
  expect(resolveHotCpuProfileConfig({ env, captureRules: rules })).toMatchObject({
    intervalMs: 3000, rules: [
      { id: "spike", durationMs: 3000, sampleCount: 1 },
      { id: "slowburn", durationMs: 4000, sampleCount: 2 }
    ]
  });
  expect(resolveHotCpuProfileConfig({ env, triggerMode: "sustained" })).toMatchObject({
    intervalMs: 3000, rules: [{ id: "sustained", durationMs: 6000, sampleCount: 2 }]
  });
  expect(resolveHotCpuProfileConfig({
    env: { ...env, PWRSNAP_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "3" }, captureRules: rules
  })).toMatchObject({
    rules: [{ id: "spike", durationMs: 3000, sampleCount: 1 }, { id: "slowburn", durationMs: 9000, sampleCount: 3 }]
  });
  expect(rules.spike.durationMs).toBe(1000);
  expect(rules.slowburn.durationMs).toBe(4000);
});
