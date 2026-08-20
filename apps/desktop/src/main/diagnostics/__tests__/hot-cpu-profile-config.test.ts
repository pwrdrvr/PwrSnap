import { describe, expect, test } from "vitest";
import { resolveHotCpuProfileConfig } from "../hot-cpu-profile-config";

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
