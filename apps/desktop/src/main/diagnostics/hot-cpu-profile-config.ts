import { resolve } from "node:path";
import type { HotCpuProfileTriggerMode } from "@pwrsnap/shared";
import {
  HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT,
  HOT_CPU_PROFILE_START_DELAY_DEFAULT_MS,
  HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT,
  isHotCpuProfileTriggerMode
} from "@pwrsnap/shared";

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_THRESHOLD_PERCENT = 50;
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

function parseTriggerMode(
  value: string | undefined,
  fallback: HotCpuProfileTriggerMode
): HotCpuProfileTriggerMode {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return isHotCpuProfileTriggerMode(normalized) ? normalized : fallback;
}

export function resolveHotCpuProfileConfig(options?: {
  captureHeapSnapshot?: boolean;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  heapSnapshotLimit?: number;
  outputRoot?: string;
  repoRoot?: string;
  slowburnThresholdPercent?: number;
  startDelayMs?: number;
  triggerMode?: HotCpuProfileTriggerMode;
}): HotCpuProfileConfig {
  const env = options?.env ?? process.env;
  if (!options?.enabled && !isEnabled(env.PWRSNAP_HOT_CPU_PROFILING)) {
    return { enabled: false };
  }

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
    triggerMode: parseTriggerMode(
      env.PWRSNAP_HOT_CPU_PROFILING_TRIGGER_MODE,
      options?.triggerMode ?? HOT_CPU_PROFILE_TRIGGER_MODE_DEFAULT
    ),
    intervalMs: parsePositiveInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_INTERVAL_MS,
      DEFAULT_INTERVAL_MS
    ),
    thresholdPercent: parsePositiveNumber(
      env.PWRSNAP_HOT_CPU_PROFILING_THRESHOLD_PERCENT,
      DEFAULT_THRESHOLD_PERCENT
    ),
    slowburnThresholdPercent: clampPercent(
      parsePositiveNumber(
        env.PWRSNAP_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT,
        options?.slowburnThresholdPercent ?? HOT_CPU_PROFILE_SLOWBURN_THRESHOLD_DEFAULT_PERCENT
      )
    ),
    consecutiveSamples: parsePositiveInteger(
      env.PWRSNAP_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES,
      DEFAULT_CONSECUTIVE_SAMPLES
    ),
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
