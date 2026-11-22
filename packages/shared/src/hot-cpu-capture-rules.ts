import { z } from "zod";
import type { HotCpuProfileTriggerMode } from "./protocol";

export const HOT_CPU_RULE_DURATIONS_MS = {
  spike: [1000, 2000],
  sustained: [4000, 6000, 10000, 20000],
  slowburn: [4000, 10000, 30000, 60000]
} as const;

export function isHotCpuThreshold(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 400;
}

const thresholdPercent = z.number().int().min(1).max(400);
export const hotCpuCaptureRulesSchema = z.object({
  high: z.object({ enabled: z.boolean(), mode: z.enum(["spike", "sustained"]) }),
  spike: z.object({ thresholdPercent, durationMs: z.literal(HOT_CPU_RULE_DURATIONS_MS.spike) }),
  sustained: z.object({ thresholdPercent, durationMs: z.literal(HOT_CPU_RULE_DURATIONS_MS.sustained) }),
  slowburn: z.object({
    enabled: z.boolean(), thresholdPercent, durationMs: z.literal(HOT_CPU_RULE_DURATIONS_MS.slowburn)
  })
}).refine((rules) => rules.high.enabled || rules.slowburn.enabled);

export type HotCpuCaptureRules = z.infer<typeof hotCpuCaptureRulesSchema>;

export function migrateHotCpuCaptureRules(mode: HotCpuProfileTriggerMode = "sustained", threshold = 15): HotCpuCaptureRules {
  return {
    high: { enabled: mode !== "slowburn", mode: mode === "spike" ? "spike" : "sustained" },
    spike: { thresholdPercent: 50, durationMs: 2000 },
    sustained: { thresholdPercent: 50, durationMs: 4000 },
    slowburn: { enabled: mode === "slowburn", thresholdPercent: Math.round(threshold), durationMs: 4000 }
  };
}

export function hotCpuRulesCadenceMs(rules: HotCpuCaptureRules): 1000 | 2000 {
  return rules.high.enabled && rules.high.mode === "spike" ? rules.spike.durationMs : 2000;
}

export type HotCpuEffectiveRule = {
  id: HotCpuProfileTriggerMode;
  thresholdPercent: number;
  durationMs: number;
  sampleCount: number;
};

export type HotCpuRuleMatch = HotCpuEffectiveRule & {
  cadenceMs: number;
  observedDurationMs: number;
  triggerCpuPercent: number;
  peakCpuPercent: number;
  measurement: "cumulative" | "electron" | "mixed";
};

export type HotCpuEnvironmentOverrides = {
  rules?: {
    keys: string[];
    cadenceMs: number;
    main: HotCpuEffectiveRule[];
    renderer: HotCpuEffectiveRule[];
    forcedMode?: HotCpuProfileTriggerMode;
  };
  armed?: true;
  chromiumTrace?: boolean;
};
