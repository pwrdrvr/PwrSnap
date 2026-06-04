// Version-keyed Codex `config` overlay for PwrSnap's enrichment + chat turns.
//
// The `config` field of `thread/start` is the free-form `config.toml` overlay
// (the `-c key=value` mechanism). It scopes Codex down from its full coding-
// agent prompt to a minimal one. BUT the keys ARE Codex's config schema and
// that schema CHURNS across (even alpha) releases — the App Server binary moves
// fast. The same config object measured wildly different on different builds
// (one no-tool enrichment turn, gpt-5.4-mini):
//
//   | Codex            | `features` block present | minimal (no `features`)  |
//   | ---------------- | ------------------------ | ------------------------ |
//   | 0.133.0          | 23k  (features INFLATES) | 3.1k                     |
//   | 0.135.0-alpha.1  | 4k   (features suppresses) | (unmeasured)           |
//   | 0.137.0-alpha.4  | 4.6k                     | 2.9k                     |
//
// So there is no single correct config — we pick the shape by the version of
// the Codex App Server we're actually talking to. Add a range entry when a new
// Codex build changes the schema; the detector is a token measurement (see
// docs/solutions/2026-06-04-codex-thread-config-token-bloat.md).

import { execFileSync } from "node:child_process";

const SHARED_INCLUDES = {
  // Top-level STRING lever. `web_search = false` (boolean) FAILS config
  // deserialization on recent Codex and falls back to the FULL prompt.
  web_search: "disabled",
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false
} as const;

/**
 * Minimal config for Codex builds where `features` is absent/inflating and
 * skills gained the `bundled` toggle. Verified ~3k on 0.133.0 and ~2.9k on
 * 0.137.0-alpha.4. This is also the DEFAULT for unknown/newer builds.
 */
export const MINIMAL_THREAD_CONFIG: Record<string, unknown> = {
  ...SHARED_INCLUDES,
  skills: {
    include_instructions: false,
    bundled: { enabled: false }
  }
};

/**
 * Legacy config for Codex 0.135.x: there `features: { … }` is VALID and
 * suppresses (~4k), and the `skills.bundled` toggle does not exist yet. Sending
 * `features` to 0.133 inflates ~6x, so this shape is scoped to 0.135.x only.
 */
export const LEGACY_FEATURES_THREAD_CONFIG: Record<string, unknown> = {
  ...SHARED_INCLUDES,
  skills: {
    include_instructions: false
  },
  features: {
    apps: false,
    plugins: false,
    tool_suggest: false,
    image_generation: false,
    multi_agent: false,
    goals: false
  }
};

type MajorMinor = readonly [number, number];

type ThreadConfigRange = {
  /** Inclusive lower bound (major, minor). */
  fromInclusive: MajorMinor;
  /** Exclusive upper bound (major, minor), or null for open-ended. */
  toExclusive: MajorMinor | null;
  config: Record<string, unknown>;
  label: string;
};

/**
 * Ordered ranges, keyed by Codex MAJOR.MINOR (patch + prerelease ignored, so
 * `0.135.0-alpha.1` matches the 0.135 line). A version not covered by any range
 * falls through to `MINIMAL_THREAD_CONFIG`.
 */
const THREAD_CONFIG_RANGES: readonly ThreadConfigRange[] = [
  {
    // 0.135.x only. `features` suppresses here; the bundled-skills toggle is
    // absent. (0.133 needs minimal; 0.137+ prefer minimal — both are the
    // default below, so only 0.135 is special-cased.)
    fromInclusive: [0, 135],
    toExclusive: [0, 136],
    config: LEGACY_FEATURES_THREAD_CONFIG,
    label: "0.135.x"
  }
];

function parseMajorMinor(version: string): MajorMinor | null {
  const match = version.match(/^\s*v?(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

function compareMajorMinor(a: MajorMinor, b: MajorMinor): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

/** Pick the `config` overlay for a known Codex version. `null`/unparseable/
 *  uncovered versions get the minimal default (best on the newest builds). */
export function resolveCodexThreadConfig(
  codexVersion: string | null
): Record<string, unknown> {
  if (codexVersion !== null) {
    const mm = parseMajorMinor(codexVersion);
    if (mm !== null) {
      for (const range of THREAD_CONFIG_RANGES) {
        const atOrAboveFrom = compareMajorMinor(mm, range.fromInclusive) >= 0;
        const belowTo =
          range.toExclusive === null || compareMajorMinor(mm, range.toExclusive) < 0;
        if (atOrAboveFrom && belowTo) return range.config;
      }
    }
  }
  return MINIMAL_THREAD_CONFIG;
}

/** Probe a Codex binary's `--version`. Injectable for tests. */
export type CodexVersionProbe = (
  command: string,
  env?: NodeJS.ProcessEnv
) => string | null;

const defaultVersionProbe: CodexVersionProbe = (command, env) => {
  try {
    const out = String(
      execFileSync(command, ["--version"], {
        timeout: 5_000,
        // MERGE over process.env — passing only { CODEX_HOME } would drop PATH
        // and a bare `codex` command would fail to resolve.
        env: env !== undefined ? { ...process.env, ...env } : process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    );
    return out.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
};

const versionCache = new Map<string, string | null>();

/**
 * Resolve the config overlay for the Codex binary at `command`, probing its
 * version once (cached per command for the process lifetime — Codex doesn't
 * change version mid-session). A failed probe → minimal default.
 */
export function resolveCodexThreadConfigForCommand(
  command: string,
  env?: NodeJS.ProcessEnv,
  probe: CodexVersionProbe = defaultVersionProbe
): Record<string, unknown> {
  let version = versionCache.get(command);
  if (version === undefined) {
    version = probe(command, env);
    versionCache.set(command, version);
  }
  return resolveCodexThreadConfig(version);
}

/** Test seam: clear the per-command version cache. */
export function __clearCodexVersionCacheForTests(): void {
  versionCache.clear();
}

/**
 * @deprecated Prefer `resolveCodexThreadConfigForCommand(command, env)` so the
 * overlay matches the running Codex build. This alias is the minimal default
 * and exists only for call sites that don't yet have the command in hand.
 */
export const PWRSNAP_CODEX_THREAD_CONFIG = MINIMAL_THREAD_CONFIG;
