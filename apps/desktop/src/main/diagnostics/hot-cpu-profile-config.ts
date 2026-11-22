import { resolve } from "node:path";
import type {
  HotCpuCaptureRules, HotCpuEffectiveRule, HotCpuEnvironmentOverrides,
  HotCpuProfileTarget, HotCpuProfileTriggerMode, Settings
} from "@pwrsnap/shared";
import {
  HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  hotCpuRulesCadenceMs,
  migrateHotCpuCaptureRules,
  isHotCpuProfileTriggerMode
} from "@pwrsnap/shared";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_CONSECUTIVE_SAMPLES = 2;
const DEFAULT_PROFILE_DURATION_MS = 15_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_MAX_PROFILES = 5;
const DEFAULT_HEAP_SNAPSHOT = false;
const DEFAULT_HEAP_SNAPSHOT_LIMIT = 2;
const MAX_HEAP_SNAPSHOT_LIMIT = 3;

export type HotCpuProfileConfig =
  | { enabled: false }
  | {
      enabled: true;
      outputRoot: string;
      repoRoot: string;
      startDelayMs: number;
      triggerMode: HotCpuProfileTriggerMode;
      intervalMs: number;
      rules?: HotCpuEffectiveRule[];
      thresholdPercent: number;
      slowburnThresholdPercent: number;
      consecutiveSamples: number;
      profileDurationMs: number;
      cooldownMs: number;
      maxProfiles: number;
      captureHeapSnapshot: boolean;
      heapSnapshotLimit: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function hotCpuChromiumTraceEnabled(env: NodeJS.ProcessEnv = process.env, preference = false): boolean {
  const override = env.PWRSNAP_HOT_CPU_PROFILING_CHROMIUM_TRACE;
  return override === undefined ? preference : isEnabled(override);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampHeapSnapshotLimit(value: number): number {
  return Math.min(Math.max(Math.round(value), 1), MAX_HEAP_SNAPSHOT_LIMIT);
}

function clampPercent(value: number): number {
  return Math.min(Math.max(value, 1), 100);
}

const PREFIX = "PWRSNAP_HOT_CPU_PROFILING_";

type RuleOptions = {
  captureRules?: HotCpuCaptureRules;
  triggerMode?: HotCpuProfileTriggerMode;
  slowburnThresholdPercent?: number;
};

function resolveRules(options: RuleOptions, env: NodeJS.ProcessEnv, target?: HotCpuProfileTarget) {
  const storedSlowburnThreshold = options.captureRules?.slowburn.thresholdPercent ??
    clampPercent(options.slowburnThresholdPercent ?? HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT);
  const stored = options.captureRules ?? migrateHotCpuCaptureRules(
    options.triggerMode ?? HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
    storedSlowburnThreshold
  );
  const keys: string[] = [];
  const modeEnv = env.PWRSNAP_HOT_CPU_PROFILING_TRIGGER_MODE?.trim().toLowerCase();
  const forcedMode = modeEnv && isHotCpuProfileTriggerMode(modeEnv) ? modeEnv : undefined;
  if (forcedMode) keys.push(PREFIX + "TRIGGER_MODE");
  const rules = forcedMode ? migrateHotCpuCaptureRules(forcedMode, storedSlowburnThreshold) : stored;
  const nominalCadence = forcedMode ? DEFAULT_INTERVAL_MS : hotCpuRulesCadenceMs(rules);
  const integerOverride = (suffix: string) => {
    const key = PREFIX + suffix;
    const value = parsePositiveInteger(env[key], 0);
    if (value > 0) keys.push(key);
    return value;
  };
  const intervalOverride = integerOverride("INTERVAL_MS");
  const intervalMs = intervalOverride || nominalCadence;
  const legacyTiming = Boolean(forcedMode || (!options.captureRules && intervalOverride));
  const countOverride = integerOverride("CONSECUTIVE_SAMPLES");
  function threshold(suffix: string, fallback: number, slowburn = false): number {
    const mainKey = PREFIX + "MAIN_" + suffix;
    const key = target === "main" && env[mainKey] !== undefined ? mainKey : PREFIX + suffix;
    const value = parsePositiveNumber(env[key], 0);
    if (value <= 0) return fallback;
    keys.push(key);
    // Preserve the historical Slow burn environment range.
    return slowburn ? clampPercent(value) : value;
  }
  const highThreshold = threshold("THRESHOLD_PERCENT", rules[rules.high.mode].thresholdPercent);
  const slowburnThreshold = threshold("SLOWBURN_THRESHOLD_PERCENT", storedSlowburnThreshold, true);
  const active: HotCpuEffectiveRule[] = [];
  function add(id: HotCpuProfileTriggerMode, thresholdPercent: number) {
    const sampleCount = id === "spike" ? 1 : countOverride ||
      (legacyTiming ? DEFAULT_CONSECUTIVE_SAMPLES : Math.max(2, Math.ceil(rules[id].durationMs / intervalMs)));
    const durationMs = id === "spike" || countOverride || legacyTiming
      ? sampleCount * intervalMs : rules[id].durationMs;
    active.push({ id, thresholdPercent, sampleCount, durationMs });
  }
  if (rules.high.enabled) add(rules.high.mode, highThreshold);
  if (rules.slowburn.enabled) add("slowburn", slowburnThreshold);
  return { intervalMs, keys, active, forcedMode, highThreshold, slowburnThreshold, countOverride };
}

export function hotCpuSettingsWithEnvironment(settings: Settings, env: NodeJS.ProcessEnv = process.env): Settings {
  const general = settings.general;
  const options: RuleOptions = {
    ...(general.hotCpuProfilingRules ? { captureRules: general.hotCpuProfilingRules } : {}),
    triggerMode: general.hotCpuProfilingTriggerMode,
    slowburnThresholdPercent: general.hotCpuProfilingSlowburnThresholdPercent
  };
  const main = resolveRules(options, env, "main");
  const renderer = resolveRules(options, env, "renderer");
  const keys = [...new Set([...main.keys, ...renderer.keys])];
  const overrides: HotCpuEnvironmentOverrides = {};
  if (keys.length) {
    overrides.rules = {
      keys, cadenceMs: main.intervalMs, main: main.active, renderer: renderer.active,
      ...(main.forcedMode ? { forcedMode: main.forcedMode } : {})
    };
  }
  if (isEnabled(env.PWRSNAP_HOT_CPU_PROFILING)) overrides.armed = true;
  if (env.PWRSNAP_HOT_CPU_PROFILING_CHROMIUM_TRACE !== undefined) {
    overrides.chromiumTrace = hotCpuChromiumTraceEnabled(env);
  }
  return Object.keys(overrides).length ? { ...settings, hotCpuProfilingEnvironment: overrides } : settings;
}

/** One config shape serves every monitored target (renderer + main);
 *  each profiler instance evaluates its own target's CPU against these
 *  thresholds independently. Pass `target: "main"` to let the
 *  `PWRSNAP_HOT_CPU_PROFILING_MAIN_THRESHOLD_PERCENT` /
 *  `PWRSNAP_HOT_CPU_PROFILING_MAIN_SLOWBURN_THRESHOLD_PERCENT` env vars
 *  override the shared trigger thresholds for the main process only —
 *  everything else stays shared on purpose. */
export function resolveHotCpuProfileConfig(options?: RuleOptions & {
  captureHeapSnapshot?: boolean;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  heapSnapshotLimit?: number;
  outputRoot?: string;
  repoRoot?: string;
  startDelayMs?: number;
  target?: HotCpuProfileTarget;
}): HotCpuProfileConfig {
  const env = options?.env ?? process.env;
  if (!options?.enabled && !isEnabled(env.PWRSNAP_HOT_CPU_PROFILING)) {
    return { enabled: false };
  }

  const effective = resolveRules(options ?? {}, env, options?.target);
  const primary = effective.active[0]!;

  const repoRoot = resolve(env.PWRSNAP_HOT_CPU_PROFILING_ROOT ?? options?.repoRoot ?? process.cwd());
  const outputRoot =
    env.PWRSNAP_HOT_CPU_PROFILING_OUTPUT_ROOT ?? options?.outputRoot ?? repoRoot;

  return {
    enabled: true,
    repoRoot,
    outputRoot,
    startDelayMs: parseNonNegativeInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_START_DELAY_MS,
      options?.startDelayMs ?? HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS
    ),
    triggerMode: primary.id,
    intervalMs: effective.intervalMs,
    rules: effective.active,
    thresholdPercent: effective.highThreshold,
    slowburnThresholdPercent: effective.slowburnThreshold,
    consecutiveSamples: primary.id === "spike" ? effective.countOverride || DEFAULT_CONSECUTIVE_SAMPLES : primary.sampleCount,
    profileDurationMs: parsePositiveInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_DURATION_MS,
      DEFAULT_PROFILE_DURATION_MS
    ),
    cooldownMs: parsePositiveInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_COOLDOWN_MS,
      DEFAULT_COOLDOWN_MS
    ),
    maxProfiles: parsePositiveInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_MAX_PROFILES,
      DEFAULT_MAX_PROFILES
    ),
    captureHeapSnapshot:
      env.PWRSNAP_HOT_CPU_PROFILING_HEAP_SNAPSHOT === undefined
        ? options?.captureHeapSnapshot ?? DEFAULT_HEAP_SNAPSHOT
        : isEnabled(env.PWRSNAP_HOT_CPU_PROFILING_HEAP_SNAPSHOT),
    heapSnapshotLimit: clampHeapSnapshotLimit(
      parsePositiveInteger(
        env.PWRSNAP_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT,
        options?.heapSnapshotLimit ?? DEFAULT_HEAP_SNAPSHOT_LIMIT
      )
    )
  };
}
