import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveCodexThreadConfig,
  resolveCodexThreadConfigForCommand,
  MINIMAL_THREAD_CONFIG,
  LEGACY_FEATURES_THREAD_CONFIG,
  __clearCodexVersionCacheForTests
} from "../codex-thread-config";

// The Codex `config` overlay schema churns across (even alpha) releases, so
// PwrSnap keys the shape by the running Codex version. These tests pin the
// version→shape map empirically verified against real Codex builds:
//   0.133.0          → minimal  (~3k; `features` INFLATES ~6x here)
//   0.135.0-alpha.1  → legacy   (~4k; `features` suppresses, no bundled toggle)
//   0.137.0-alpha.4  → minimal  (~2.9k)
describe("resolveCodexThreadConfig (version-keyed Codex overlay)", () => {
  afterEach(() => __clearCodexVersionCacheForTests());

  test("0.133.x uses the minimal (no-`features`) config", () => {
    expect(resolveCodexThreadConfig("0.133.0")).toBe(MINIMAL_THREAD_CONFIG);
  });

  test("0.135.x uses the legacy `features` config (incl. prerelease tags)", () => {
    expect(resolveCodexThreadConfig("0.135.0")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.135.0-alpha.1")).toBe(LEGACY_FEATURES_THREAD_CONFIG);
  });

  test("0.137.x and newer fall through to the minimal default", () => {
    expect(resolveCodexThreadConfig("0.137.0-alpha.4")).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("0.999.0")).toBe(MINIMAL_THREAD_CONFIG);
  });

  test("0.136.x (gap between known ranges) defaults to minimal", () => {
    expect(resolveCodexThreadConfig("0.136.0")).toBe(MINIMAL_THREAD_CONFIG);
  });

  test("null / unparseable version → minimal default", () => {
    expect(resolveCodexThreadConfig(null)).toBe(MINIMAL_THREAD_CONFIG);
    expect(resolveCodexThreadConfig("not-a-version")).toBe(MINIMAL_THREAD_CONFIG);
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
    const probe = vi.fn(() => "0.135.0-alpha.1");
    const a = resolveCodexThreadConfigForCommand("/path/codex", undefined, probe);
    const b = resolveCodexThreadConfigForCommand("/path/codex", undefined, probe);
    expect(a).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(b).toBe(LEGACY_FEATURES_THREAD_CONFIG);
    expect(probe).toHaveBeenCalledTimes(1); // cached by command
  });

  test("a failed probe (null) → minimal default", () => {
    const probe = vi.fn(() => null);
    expect(resolveCodexThreadConfigForCommand("/x/codex", undefined, probe)).toBe(
      MINIMAL_THREAD_CONFIG
    );
  });
});
