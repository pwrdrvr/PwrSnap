// Keep PwrSnap's Codex App Server turns scoped to our app surfaces instead of
// inheriting Codex's coding-agent prompt and hosted tool scaffolding. Empty
// `environments` is still required at thread/start for env-gated shell tools.
export const PWRSNAP_CODEX_THREAD_CONFIG: Record<string, unknown> = {
  web_search: "disabled",
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
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
