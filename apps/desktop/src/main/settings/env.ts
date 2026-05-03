// Centralized env-var names for settings overrides.
//
// Mirrors PwrAgnt's apps/desktop/src/main/settings/desktop-settings-env.ts.
// Phase 1 only needs the Codex-command override; expand as Phase 3
// settings substrate lands.

/**
 * Override the Codex CLI binary used by `codex-discovery` and the
 * `StdioJsonRpcTransport`. When set, takes precedence over the
 * user-configured Settings → AI value, the `codex` binary on `$PATH`,
 * and the bundled Codex Desktop installation. Useful for CI runs and
 * for developers testing pre-release Codex builds.
 */
export const PWRSNAP_CODEX_COMMAND_ENV = "PWRSNAP_CODEX_COMMAND";
