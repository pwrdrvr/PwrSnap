import { describe, expect, test } from "vitest";
import {
  resolveCodexThreadConfig,
  withEffectiveCodeModeSettings,
  MINIMAL_THREAD_CONFIG,
  LEGACY_FEATURES_THREAD_CONFIG,
  MODERN_THREAD_CONFIG
} from "../codex-thread-config";

// The Codex `config` overlay schema churns across (even alpha) releases, so
// PwrSnap keys the shape by the running Codex version with FLOOR / "last
// compatible marker wins" semantics: a marker applies from its MAJOR.MINOR
// forward to every newer version until a higher marker supersedes it.
//
// Markers today (empirically verified against real Codex builds):
//   ≤ 0.134   → minimal  (0.133 measured ~3k; `features` INFLATES ~6x there)
//   0.135–136 → legacy   (0.135.0-alpha.1 measured ~4k; `features` suppresses)
//   0.137–143 → minimal  (0.137.0-alpha.4 measured ~2.9k)
//   ≥ 0.144   → modern   (plugins default-on; AGENTS.md must be suppressed)
describe("resolveCodexThreadConfig — floor / last-marker-wins", () => {
  test("below the 0.135 marker (0.133 / 0.134) → minimal baseline", () => {
    expect(resolveCodexThreadConfig("0.133.0")).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.134.9")).toBe(MINIMAL_THREAD_CONFIG);
  });

  test("exactly the 0.135 marker (incl. prerelease) → legacy", () => {
    expect(resolveCodexThreadConfig("0.135.0")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.135.0-alpha.1")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.135.7")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
  });

  test("0.136 has NO marker → inherits the 0.135 marker (legacy), not the default", () => {
    // This is the headline propagation rule: a newer version with no marker of
    // its own uses the most recent PRECEDING marker.
    expect(resolveCodexThreadConfig("0.136.0")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.136.99")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.136.0-alpha.2")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
  });

  test("exactly the 0.137 marker (incl. prerelease) → minimal", () => {
    expect(resolveCodexThreadConfig("0.137.0")).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.137.0-alpha.4")).toBe(MINIMAL_THREAD_CONFIG);
  });

  test("0.138 through 0.143 inherit the 0.137 marker (minimal)", () => {
    for (const v of ["0.138.0", "0.139.5", "0.141.2", "0.143.99"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MINIMAL_THREAD_CONFIG);
    }
  });

  test("0.144 and newer use the modern suppression profile", () => {
    for (const v of ["0.144.0", "0.144.0-alpha.1", "0.150.0", "1.0.0", "2.4.0"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MODERN_THREAD_CONFIG);
    }
  });

  test("null / unparseable → newest marker (Codex only moves forward)", () => {
    // Newest marker today is 0.144 → modern.
    expect(resolveCodexThreadConfig(null)).toBe(MODERN_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("not-a-version")).toBe(MODERN_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("")).toBe(MODERN_THREAD_CONFIG);
  });

  test("a marker boundary is exact: 0.134.x is below 0.135, 0.135.0 is on it", () => {
    expect(resolveCodexThreadConfig("0.134.999")).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.135.0")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
  });

  test("propagation is monotonic per marker block (no gaps inside a block)", () => {
    // 0.135 block: 0.135.x and 0.136.x all legacy.
    for (const v of ["0.135.0", "0.135.3", "0.136.0", "0.136.4"]) {
      expect(resolveCodexThreadConfig(v)).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    }
    // 0.137 block: 0.137.x through 0.143.x are minimal.
    for (const v of ["0.137.0", "0.138.0", "0.141.2", "0.143.9"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MINIMAL_THREAD_CONFIG);
    }
    // 0.144 block: modern from its boundary onward.
    for (const v of ["0.144.0", "0.146.0", "1.0.0"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MODERN_THREAD_CONFIG);
    }
  });
});

describe("config shape invariants (per Codex schema notes)", () => {
  test("minimal: NO `features`, disables bundled skills, web_search is the string lever", () => {
    expect(MINIMAL_THREAD_CONFIG).not.toHaveProperty("features");
    expect(MINIMAL_THREAD_CONFIG.skills).toEqual({
      include_instructions: false,
      bundled: { enabled: false }
    });
    expect(MINIMAL_THREAD_CONFIG.web_search).toBe("disabled");
  });

  test("legacy: HAS `features`, no bundled toggle (0.135 schema)", () => {
    expect(LEGACY_FEATURES_THREAD_CONFIG).toHaveProperty("features");
    expect(LEGACY_FEATURES_THREAD_CONFIG.skills).toEqual({ include_instructions: false });
  });

  test("modern: disables plugins and project AGENTS.md discovery", () => {
    expect(MODERN_THREAD_CONFIG).toMatchObject({
      project_doc_max_bytes: 0,
      skills: {
        include_instructions: false,
        bundled: { enabled: false }
      },
      features: {
        apps: false,
        plugins: false,
        tool_suggest: false,
        image_generation: false,
        multi_agent: false,
        goals: false
      }
    });
  });

  test("modern: keeps rich PwrSnap responses out of Code Mode flattening", () => {
    expect(MODERN_THREAD_CONFIG).toHaveProperty(
      "features.code_mode.direct_only_tool_namespaces",
      ["pwrsnap_library", "pwrsnap_sizzle"]
    );
  });

  test.each([true, false])(
    "preserves scalar Code Mode enablement (%s) when adding namespace policy",
    (enabled) => {
      const resolved = withEffectiveCodeModeSettings(MODERN_THREAD_CONFIG, {
        config: { features: { code_mode: enabled } }
      });

      expect(resolved).toHaveProperty("features.code_mode", {
        direct_only_tool_namespaces: ["pwrsnap_library", "pwrsnap_sizzle"],
        enabled
      });
      expect(MODERN_THREAD_CONFIG).not.toHaveProperty("features.code_mode.enabled");
    }
  );

  test("preserves table-valued Code Mode enablement", () => {
    expect(
      withEffectiveCodeModeSettings(MODERN_THREAD_CONFIG, {
        config: { features: { code_mode: { enabled: true } } }
      })
    ).toHaveProperty("features.code_mode.enabled", true);
  });

  test("unions effective and PwrSnap direct-only namespaces without duplicates", () => {
    const resolved = withEffectiveCodeModeSettings(MODERN_THREAD_CONFIG, {
      config: {
        features: {
          code_mode: {
            direct_only_tool_namespaces: ["mcp__history", "pwrsnap_library"]
          }
        }
      }
    });

    expect(resolved).toHaveProperty("features.code_mode.direct_only_tool_namespaces", [
      "mcp__history",
      "pwrsnap_library",
      "pwrsnap_sizzle"
    ]);
    expect(resolved).not.toHaveProperty("features.code_mode.enabled");
  });
});
