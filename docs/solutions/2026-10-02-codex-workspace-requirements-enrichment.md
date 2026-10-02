# Codex 0.160 enrichment fails while reloading its permission profile

Capture enrichment reported `failed to load workspace requirements` after
creating a GPT-6-Luna ephemeral thread. Both image and video runs failed;
Regenerate reproduced it. The model was present in the live catalog.

Codex's diagnostic SQLite log showed workspace-routing setup failing before
inference, followed by repeated sampling retries and an HTTP fallback. The
error did not identify a model-access failure.

In Codex 0.160.0, workspace routing rebuilds the retained session config with
fresh `ConfigOverrides`. PwrSnap supplied the profile definition in the
thread config but selected it only through `thread/start.permissions`.
Rebuilding lost that override and rejected the profile table with:
`config defines [permissions] profiles but does not set default_permissions`.
The routing code discards that cause and returns the generic error above.

Source pointers in OpenAI's Apache-2.0-licensed `rust-v0.160.0` tag:
`codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs`
(`read_account`), `codex-rs/app-server/src/config_manager.rs`
(`load_retained_session_config`), and `codex-rs/core/src/config/mod.rs`
(`rebuild_with_session_layers` and permission selection validation).

A configuration-only CLI probe reproduced the profile-table rejection with
an empty temporary `CODEX_HOME`, no auth, and no user configuration. This
affects the integration with Codex 0.160.0 rather than one machine's settings
or a particular model. The same profile table was accepted when it also set
`default_permissions`. No model turn or capture input was needed.

To reproduce, run Codex 0.160.0 with an empty temporary `CODEX_HOME`:

```sh
codex app-server -c 'permissions.pwrsnap_enrichment={filesystem={":root"="deny",":minimal"="read","/tmp/pwrsnap-diagnostic-jail"="read"}}' </dev/null
```

It exits 1 with the specific config error. Add
`-c 'default_permissions="pwrsnap_enrichment"'` and the same probe exits 0.
Use CLI overrides for this probe: app-server can tolerate an invalid on-disk
user config by loading defaults, which would hide the reproduction.

Keep `default_permissions: "pwrsnap_enrichment"` in the read-scoped thread
config alongside the profile definition and the explicit thread selection.
Leave the named profile unselected on the legacy sandbox fallback. The jail,
filesystem rules, network denial, tool denial, and approval policy stay intact.
The UI should describe a Codex configuration failure before AI ran, rather
than implying the model tried and failed to understand the screenshot.
Keep the original failure available in the status tooltip and persisted run
error. A generic requirements-load failure alone does not establish invalid
credentials or model access; it must not trigger a weaker sandbox fallback.
