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
//   | 0.146.0-alpha.9  | required for plugin suppression | leaks plugins     |
//
// So there is no single correct config — we pick the shape by the version of
// the Codex App Server we're actually talking to. Add a range entry when a new
// Codex build changes the schema; the detector is a token measurement (see
// docs/solutions/2026-06-04-codex-thread-config-token-bloat.md).

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

/**
 * Current config for Codex 0.144+ (PwrSnap's supported protocol floor).
 *
 * Modern Codex enables plugins by default. Keep this feature block version-
 * scoped: older 0.133 builds interpret it differently and inflate the prompt.
 * `project_doc_max_bytes` suppresses cwd/project AGENTS discovery; Codex still
 * injects the selected profile's global AGENTS.md once per fresh thread because
 * the App Server has no thread-level switch for that process-owned source.
 */
export const MODERN_THREAD_CONFIG: Record<string, unknown> = {
  ...SHARED_INCLUDES,
  project_doc_max_bytes: 0,
  skills: {
    include_instructions: false,
    bundled: { enabled: false }
  },
  features: {
    apps: false,
    // PwrSnap's rich tool responses can contain adjacent image + text items.
    // Keep them as direct model tools so Code Mode does not flatten those
    // structured items into a newline-joined string and corrupt data URLs.
    code_mode: {
      direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"]
    },
    plugins: false,
    tool_suggest: false,
    image_generation: false,
    multi_agent: false,
    goals: false
  }
};

/**
 * Preserve the selected profile's effective Code Mode settings when a thread
 * overlay adds table-valued policy. Codex also accepts the standard scalar
 * feature form (`features.code_mode = true`); replacing that scalar with a
 * table that omits `enabled` silently falls back to false. Arrays replace
 * lower-layer arrays, so direct-only namespaces must be explicitly unioned.
 */
export function withEffectiveCodeModeSettings(
  baseConfig: Record<string, unknown> | undefined,
  configReadResponse: unknown
): Record<string, unknown> | undefined {
  const baseFeatures = asRecord(baseConfig?.["features"]);
  const baseCodeMode = asRecord(baseFeatures?.["code_mode"]);
  if (baseConfig === undefined || baseFeatures === null || baseCodeMode === null) {
    return baseConfig;
  }

  const effectiveConfig = asRecord(asRecord(configReadResponse)?.["config"]);
  const effectiveFeatures = asRecord(effectiveConfig?.["features"]);
  const effectiveCodeMode = effectiveFeatures?.["code_mode"];
  const effectiveCodeModeTable = asRecord(effectiveCodeMode);
  const enabled =
    typeof effectiveCodeMode === "boolean"
      ? effectiveCodeMode
      : effectiveCodeModeTable?.["enabled"];
  const effectiveDirectOnlyNamespaces = stringArray(
    effectiveCodeModeTable?.["direct_only_tool_namespaces"]
  );
  if (typeof enabled !== "boolean" && effectiveDirectOnlyNamespaces === null) {
    return baseConfig;
  }

  const baseDirectOnlyNamespaces =
    stringArray(baseCodeMode["direct_only_tool_namespaces"]) ?? [];
  const directOnlyToolNamespaces = [
    ...new Set([
      ...(effectiveDirectOnlyNamespaces ?? []),
      ...baseDirectOnlyNamespaces
    ])
  ];

  return {
    ...baseConfig,
    features: {
      ...baseFeatures,
      code_mode: {
        ...baseCodeMode,
        ...(effectiveDirectOnlyNamespaces !== null
          ? { direct_only_tool_namespaces: directOnlyToolNamespaces }
          : {}),
        ...(typeof enabled === "boolean" ? { enabled } : {})
      }
    }
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type MajorMinor = readonly [number, number];

type ThreadConfigMarker = {
  /**
   * The Codex MAJOR.MINOR at which this config becomes effective. A marker
   * applies from its version FORWARD — to that minor AND every newer version —
   * UNTIL a higher marker supersedes it. (Patch + prerelease are ignored, so
   * `0.135.0-alpha.1` matches the 0.135 marker.)
   */
  since: MajorMinor;
  config: Record<string, unknown>;
  label: string;
};

/**
 * "Last compatible marker wins." To resolve, pick the marker with the GREATEST
 * `since` that is still <= the running Codex MAJOR.MINOR (a floor lookup). Each
 * marker therefore owns a half-open range up to the next marker: with markers
 * at 0.0 / 0.135 / 0.137 / 0.144, version 0.136 resolves to the 0.135 marker,
 * 0.140 resolves to the 0.137 marker, and 0.144+ resolves to the modern marker.
 *
 * To support a new Codex build that changes the schema, ADD a marker at its
 * MAJOR.MINOR — it then governs that version and all newer ones automatically.
 * Kept sorted ascending for readability; resolution is order-independent.
 */
const THREAD_CONFIG_MARKERS: readonly ThreadConfigMarker[] = [
  // Baseline floor (0.133 / 0.134): `features` INFLATES ~6x here — go minimal.
  { since: [0, 0], config: MINIMAL_THREAD_CONFIG, label: "≤ 0.134" },
  // 0.135 → 0.136: `features` SUPPRESSES (~4k); bundled-skills toggle absent.
  { since: [0, 135], config: LEGACY_FEATURES_THREAD_CONFIG, label: "0.135 → 0.136" },
  // 0.137 → 0.143: minimal is best (~2.9k); `features` is not needed.
  { since: [0, 137], config: MINIMAL_THREAD_CONFIG, label: "0.137 → 0.143" },
  // 0.144 and onward: plugins are default-on again; explicitly suppress the
  // current feature set and prevent project AGENTS.md discovery.
  { since: [0, 144], config: MODERN_THREAD_CONFIG, label: "≥ 0.144" }
];

function parseMajorMinor(version: string): MajorMinor | null {
  const match = version.match(/^\s*v?(\d+)\.(\d+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

function compareMajorMinor(a: MajorMinor, b: MajorMinor): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

function newestMarker(): ThreadConfigMarker {
  return THREAD_CONFIG_MARKERS.reduce((newest, marker) =>
    compareMajorMinor(marker.since, newest.since) > 0 ? marker : newest
  );
}

/**
 * Pick the `config` overlay for a Codex version using floor / "last marker
 * wins" semantics: the highest marker whose `since` is <= the running version.
 * `null` / unparseable / below-all-markers → the newest marker (Codex only
 * moves forward, so an unknown build is most likely a recent one).
 */
export function resolveCodexThreadConfig(
  codexVersion: string | null
): Record<string, unknown> {
  const mm = codexVersion !== null ? parseMajorMinor(codexVersion) : null;
  if (mm === null) return newestMarker().config;
  let best: ThreadConfigMarker | null = null;
  for (const marker of THREAD_CONFIG_MARKERS) {
    if (
      compareMajorMinor(mm, marker.since) >= 0 &&
      (best === null || compareMajorMinor(marker.since, best.since) > 0)
    ) {
      best = marker;
    }
  }
  return (best ?? newestMarker()).config;
}

/**
 * @deprecated Callers with a store-published Codex version should use
 * `resolveCodexThreadConfig(version)`. This alias is the minimal default and
 * exists only for call sites that don't have a resolved version in hand.
 */
export const PWRSNAP_CODEX_THREAD_CONFIG = MINIMAL_THREAD_CONFIG;
