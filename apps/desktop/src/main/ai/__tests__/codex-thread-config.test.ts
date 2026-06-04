import { describe, expect, test } from "vitest";
import { PWRSNAP_CODEX_THREAD_CONFIG } from "../codex-thread-config";

// Guards the Codex `config` overlay that scopes PwrSnap's enrichment + chat
// turns down to a minimal prompt. These keys drift with the Codex CLI; this
// test pins the shape that was empirically verified against Codex 0.133.0 to
// keep input tokens ~3k instead of ~24k. If a Codex upgrade legitimately
// changes the schema, update both this test AND a fresh token measurement.
describe("PWRSNAP_CODEX_THREAD_CONFIG (Codex 0.133 prompt suppression)", () => {
  test("does NOT send a `features` block (it inflates the prompt ~6x on 0.133)", () => {
    expect(PWRSNAP_CODEX_THREAD_CONFIG).not.toHaveProperty("features");
  });

  test("disables bundled skills AND the skills-instructions block", () => {
    expect(PWRSNAP_CODEX_THREAD_CONFIG.skills).toEqual({
      include_instructions: false,
      bundled: { enabled: false }
    });
  });

  test("disables web search via the top-level string lever (not the boolean)", () => {
    // `web_search = false` (boolean) FAILS config deserialization on 0.133 and
    // falls back to the full prompt; the string "disabled" is the valid lever.
    expect(PWRSNAP_CODEX_THREAD_CONFIG.web_search).toBe("disabled");
  });

  test("keeps the still-valid include_* suppression keys", () => {
    expect(PWRSNAP_CODEX_THREAD_CONFIG.include_permissions_instructions).toBe(false);
    expect(PWRSNAP_CODEX_THREAD_CONFIG.include_apps_instructions).toBe(false);
    expect(PWRSNAP_CODEX_THREAD_CONFIG.include_collaboration_mode_instructions).toBe(false);
    expect(PWRSNAP_CODEX_THREAD_CONFIG.include_environment_context).toBe(false);
  });
});
