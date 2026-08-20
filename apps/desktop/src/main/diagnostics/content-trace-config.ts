// Env-gated multi-process Chrome trace harness config.
//
// Sibling to the hot-CPU harness (`hot-cpu-profile-config.ts`) and the
// startup profiler (`PWRSNAP_STARTUP_PROFILE=1`): off by default, armed
// only by an env var, and kept wired in production builds so a user can
// hand back a real trace without a custom build.
//
// The hot-CPU harness answers "which process is burning CPU"; it cannot
// answer "why is the GPU process burning it", because the GPU process
// runs no JS and so cannot be V8-profiled. `contentTracing` records the
// browser + GPU + renderer trace event streams into a single Chrome
// trace, which is the only view that shows compositor frame cadence,
// damage rects, and raster/draw/swap attribution.

import { resolve } from "node:path";

/** The categories that matter for compositor / GPU-process work.
 *
 *  - `viz` + `gpu`: the viz compositor's Display/Scheduler/DrawFrame and
 *    the GPU service's command-buffer + swap work. This is the GPU
 *    process's own story.
 *  - `cc`: the renderer's compositor — tile raster, damage, activation.
 *  - `benchmark`: `BenchmarkInstrumentation::DisplayRenderingStats`,
 *    which carries the per-frame counters used to count frames.
 *  - `disabled-by-default-devtools.timeline.frame`: the DevTools frame
 *    lifecycle markers, so a trace can be read in the DevTools/Perfetto
 *    frame viewer.
 *  - `media`: video decode + `VideoFrameSubmitter` events, which is how
 *    we tell whether the video reaches an overlay plane or is drawn by
 *    the compositor.
 *  - `toplevel`: message-loop task boundaries — the denominator every
 *    per-process "where did the time go" split is computed against.
 */
export const CONTENT_TRACE_DEFAULT_CATEGORIES = [
  "viz",
  "gpu",
  "cc",
  "benchmark",
  "disabled-by-default-devtools.timeline.frame",
  "media",
  "toplevel"
] as const;

const DEFAULT_DURATION_MS = 15_000;
const MIN_DURATION_MS = 1_000;
const MAX_DURATION_MS = 120_000;

export type ContentTraceConfig =
  | { enabled: false }
  | {
      enabled: true;
      outputRoot: string;
      categories: string[];
      /** Milliseconds of trace captured per run. */
      durationMs: number;
      /** When > 0, arm a one-shot recording this long after `whenReady`.
       *  0 (default) means recordings are started on demand only. */
      autoStartDelayMs: number;
    };

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, MIN_DURATION_MS), MAX_DURATION_MS);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** `PWRSNAP_TRACE_CATEGORIES` replaces (not extends) the default set, so
 *  a narrow investigation can drop the noisy ones. Blank entries are
 *  dropped; an all-blank value falls back to the defaults rather than
 *  recording an empty category filter (which records nothing useful). */
function parseCategories(value: string | undefined): string[] {
  if (!value) return [...CONTENT_TRACE_DEFAULT_CATEGORIES];
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parsed.length > 0 ? parsed : [...CONTENT_TRACE_DEFAULT_CATEGORIES];
}

export function resolveContentTraceConfig(options?: {
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  outputRoot?: string;
}): ContentTraceConfig {
  const env = options?.env ?? process.env;
  if (!options?.enabled && !isEnabled(env.PWRSNAP_TRACE)) {
    return { enabled: false };
  }

  const outputRootEnv = env.PWRSNAP_TRACE_OUTPUT_ROOT?.trim();
  const outputRoot = outputRootEnv
    ? resolve(outputRootEnv)
    : options?.outputRoot ?? process.cwd();

  return {
    enabled: true,
    outputRoot,
    categories: parseCategories(env.PWRSNAP_TRACE_CATEGORIES),
    durationMs: parseDurationMs(env.PWRSNAP_TRACE_DURATION_MS, DEFAULT_DURATION_MS),
    autoStartDelayMs: parseNonNegativeInteger(env.PWRSNAP_TRACE_AUTOSTART_DELAY_MS, 0)
  };
}
