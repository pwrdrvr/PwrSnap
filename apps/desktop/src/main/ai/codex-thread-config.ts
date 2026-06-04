// Keep PwrSnap's Codex App Server turns scoped to our app surfaces instead of
// inheriting Codex's coding-agent prompt and hosted tool scaffolding. Empty
// `environments` is still required at thread/start for env-gated shell tools.
//
// ⚠️  These keys ARE the Codex `config.toml` overlay schema and they DRIFT with
// the Codex CLI. Validate against the installed Codex by measuring enrichment
// input tokens — a sudden ~6x jump means a key stopped suppressing (or started
// inflating). Two hard-won facts for Codex 0.133.0:
//
//   • `features: { … }` MUST NOT be sent. The schema changed: on 0.133 this
//     block INFLATES the prompt ~6x (a no-tool enrichment turn went 3k → 28k)
//     instead of suppressing. Drop it entirely; the individual `include_*` /
//     `skills` / `web_search` keys below do the real suppression.
//   • Disabling skills now takes BOTH `skills.include_instructions = false`
//     (drops the auto skills-instructions block) AND `skills.bundled.enabled =
//     false` (stops Codex's bundled skills from loading into context).
//   • `web_search` is a top-level STRING ("disabled"). Do NOT send the boolean
//     `web_search = false` nor `tools.web_search = false` as the primary lever:
//     a bare `web_search = false` fails config deserialization and Codex falls
//     back to the FULL default prompt.
//
// Measured on Codex 0.133.0, gpt-5.4-mini, one-shot enrichment turn: this
// config yields ~3.1k input tokens; the old `features`-bearing config yielded
// ~23k. See docs/solutions for the investigation.
export const PWRSNAP_CODEX_THREAD_CONFIG: Record<string, unknown> = {
  web_search: "disabled",
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  skills: {
    include_instructions: false,
    bundled: {
      enabled: false
    }
  }
};
