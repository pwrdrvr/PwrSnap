# Codex configuration overlays and inherited enrichment hooks

PwrSnap already uses the supported App Server configuration override mechanism:
`thread/start.config`. Investigating Codex 0.160.0 did not identify a separate
configuration-overlay endpoint that PwrSnap should adopt.

## Mechanism and lifecycle

The current [official App Server guide](https://learn.chatgpt.com/docs/app-server)
describes thread start/resume/fork configuration overrides. The installed
0.160.0 binary's experimental JSON schema exposes `config` on those requests;
its config methods are read, persistent value/batch writes, requirements read,
and MCP reload. There is no overlay create/apply/remove method in that schema.
The pinned `@pwrdrvr/codex-app-server-protocol` 0.159.2 surface agrees.

In OpenAI's Apache-2.0-licensed `rust-v0.160.0` source,
`app-server/src/config_manager.rs::load_with_cli_overrides` converts request
JSON values to TOML and appends them after process CLI overrides. The config
loader stores them as a `SessionFlags` layer. Core's
`config/mod.rs::layer_stack_preserving_session` keeps session layers when
rebuilding retained configuration. This explains why #698 selects the jail
profile in `config.default_permissions` as well as `thread/start.permissions`:
the typed selection is not itself a retained config-layer entry.

This mechanism is appropriate for PwrSnap's shared process: each enrichment
thread gets its own ephemeral config, while chat gets its own start/fork
overrides. Process-wide CLI flags, a profile file, or persistent `config/*`
writes would change the isolation boundary. No new overlay abstraction or
user-config edit is needed.

## Missing suppression

The existing overlay disabled plugins, apps, web search, project instruction
discovery, and configured MCP servers, but omitted lifecycle hooks. Codex
0.160.0 enables the `hooks` feature by default. A trusted `SessionStart` hook
can run before inference and inject context. Its command runtime is separate
from sandboxed model tools, so the enrichment filesystem jail and tool-denial
handlers do not prevent that execution.

Legacy `notify` commands also survive the overlay. `hooks/src/registry.rs`
builds its `after_agent` callbacks from `legacy_notify_argv` independently of
the lifecycle-hook feature. Notification arguments include the assistant's
last message, which can contain screenshot-derived text. Disabling hooks
alone does not disable that callback.

The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents `features.hooks` and `notify`. The fix pins `features.hooks = false`
and `notify = []` in every enrichment thread's existing config object,
including the legacy sandbox fallback. Other feature overrides remain intact.
Chat's config and the shared process are unchanged. The `hooks` feature key is
also present and default-on in the `rust-v0.144.0` source, PwrSnap's supported
CLI floor, so this does not require another version marker or wrapper.

## Verification

A live 0.160.0 probe used a fresh temporary `CODEX_HOME`, no credentials or
user files, a scratch jail, and a synthetic Responses provider served only on
loopback. The provider returned a fixed SSE `response.completed` event; no
real model ran or tokens were purchased. The synthetic user config defined
a `SessionStart` shell hook and a legacy notification command, each writing
a different marker outside the jail but inside the probe's scratch directory.
`hooks/list` supplied the hook key/current hash, which was saved as
`hooks.state.<key>.trusted_hash` in that temporary config. The probe did not
bypass hook trust.

Three fresh ephemeral threads used the same process and read-scoped jail:

| Thread overlay | SessionStart marker | Notify marker |
| --- | --- | --- |
| Existing enrichment posture | Written | Written |
| Add `features.hooks = false`, `notify = []` | Absent | Absent |
| Existing posture again | Written | Written |

This demonstrates both the missing isolation and the supported per-thread
fix without altering the operator's configuration. Also tested hooks disabled
without the notification override: the notification marker was still written.

Before the fix, four pool regressions failed on missing/true hook enablement.
After adding hook suppression alone, three notification regressions still
failed. The final tests cover omitted and explicit caller config, inherited
enablement, preservation of other features and immutable inputs, both sandbox
attempts, chat start/fork after enrichment on the same owner, and absence of
persistent config writes.
