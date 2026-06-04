import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveCodexThreadConfig,
  resolveCodexThreadConfigForCommand,
  MINIMAL_THREAD_CONFIG,
  LEGACY_FEATURES_THREAD_CONFIG,
  __clearCodexVersionCacheForTests
} from "../codex-thread-config";

// The Codex `config` overlay schema churns across (even alpha) releases, so
// PwrSnap keys the shape by the running Codex version with FLOOR / "last
// compatible marker wins" semantics: a marker applies from its MAJOR.MINOR
// forward to every newer version until a higher marker supersedes it.
//
// Markers today (empirically verified against real Codex builds):
//   ≤ 0.134   → minimal  (0.133 measured ~3k; `features` INFLATES ~6x there)
//   0.135–136 → legacy   (0.135.0-alpha.1 measured ~4k; `features` suppresses)
//   ≥ 0.137   → minimal  (0.137.0-alpha.4 measured ~2.9k)
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

  test("every version newer than 0.137 inherits the 0.137 marker (minimal) forever", () => {
    for (const v of ["0.138.0", "0.139.5", "0.150.0", "0.999.99", "1.0.0", "2.4.0"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MINIMAL_THREAD_CONFIG);
    }
  });

  test("null / unparseable → newest marker (Codex only moves forward)", () => {
    // Newest marker today is 0.137 → minimal.
    expect(resolveCodexThreadConfig(null)).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("not-a-version")).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("")).toBe(MINIMAL_THREAD_CONFIG);
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
    // 0.137 block: 0.137.x .. onward all minimal.
    for (const v of ["0.137.0", "0.138.0", "0.141.2"]) {
      expect(resolveCodexThreadConfig(v)).toBe(MINIMAL_THREAD_CONFIG);
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
});

describe("resolveCodexThreadConfigForCommand (cached version probe)", () => {
  afterEach(() => __clearCodexVersionCacheForTests());

  test("probes the command's version once, then serves from cache", () => {
    const probe = vi.fn(() => "0.136.0"); // no marker of its own → 0.135 legacy
    const a = resolveCodexThreadConfigForCommand("/path/codex", undefined, probe);
    const b = resolveCodexThreadConfigForCommand("/path/codex", undefined, probe);
    expect(a).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(b).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(probe).toHaveBeenCalledTimes(1); // cached by command
  });

  test("distinct commands probe independently", () => {
    const probe = vi.fn((cmd: string) => (cmd === "/old/codex" ? "0.135.0" : "0.138.0"));
    expect(resolveCodexThreadConfigForCommand("/old/codex", undefined, probe)).toBe(
      LEGACY_FEATURES_THREAD_CONFIG
    );
    expect(resolveCodexThreadConfigForCommand("/new/codex", undefined, probe)).toBe(
      MINIMAL_THREAD_CONFIG
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test("a failed probe (null) → newest-marker default", () => {
    const probe = vi.fn(() => null);
    expect(resolveCodexThreadConfigForCommand("/x/codex", undefined, probe)).toBe(
      MINIMAL_THREAD_CONFIG
    );
  });
});
