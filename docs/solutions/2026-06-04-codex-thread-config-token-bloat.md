---
date: 2026-06-04
kind: bug
area: ai/codex-enrichment
tags: [codex, tokens, cost, config, prompt, skills, regression]
---

# Codex enrichment/chat input tokens 6x'd after a Codex CLI update

## Symptom

Per-screenshot AI enrichment input tokens jumped from ~4k to ~24k (mostly
cached, so the bill is dampened but the prompt is genuinely ~6x bigger).
Library/Sizzle chat turns inflated the same way (e.g. 7k cached on a 1-turn
chat). Nothing in PwrSnap's enrichment code changed — `PWRSNAP_CODEX_THREAD_CONFIG`,
the base instructions, the schema, and the thread/turn params were byte-identical
to the prior release, and the kit (`@pwrdrvr/agent-client`) forwards the config
faithfully.

## Root cause

**The Codex CLI updated (Codex Desktop autoupdate → 0.133.0) and changed the
`config.toml` overlay schema that `PWRSNAP_CODEX_THREAD_CONFIG` targets.** The
`config` field of `thread/start` is a free-form `{ [key]: JsonValue }` map (the
`-c key=value` overlay), so stale keys don't error — they silently stop working,
and in one case actively backfire.

Measured against the user's Codex 0.133.0 (gpt-5.4-mini, one no-tool enrichment
turn), isolating each key:

| config | input tokens |
|---|---|
| old config (with `features: {…}`) | **23,469** |
| `features: {…}` alone (everything else minimal) | **28,263** |
| drop `features`, add `skills.bundled.enabled=false`, keep `web_search:"disabled"` | **3,111** |

Three schema drifts:

1. **`features: { apps, plugins, tool_suggest, … }` now INFLATES the prompt ~6x**
   instead of suppressing it. The 0.133 `features` schema differs from what the
   old keys meant; sending the block pulls a large amount of scaffolding into
   context. **Drop it entirely.**
2. **Disabling skills now needs two keys**: `skills.include_instructions = false`
   (drops the auto instructions block) *and* `skills.bundled.enabled = false`
   (stops bundled skills loading). The old config only set the first.
3. **`web_search` is a top-level STRING** (`"disabled"`). It removes the
   web-search tool (~5k of the prompt). The boolean `web_search = false` FAILS
   config deserialization on 0.133, which makes Codex fall back to the FULL
   default prompt — so never send the boolean.

The `include_permissions_instructions` / `include_apps_instructions` /
`include_collaboration_mode_instructions` / `include_environment_context` keys
are still valid top-level fields and were kept.

## Fix

`apps/desktop/src/main/ai/codex-thread-config.ts` — drop `features`, add
`skills.bundled.enabled = false`. This single constant feeds all three Codex
surfaces (capture enrichment, Library chat, Sizzle chat), so it fixes them
together. Result: ~3.1k input tokens (better than the pre-regression ~4k).

A guard test (`codex-thread-config.test.ts`) pins the known-good shape:
no `features`, `skills.bundled.enabled=false`, `web_search:"disabled"`.

## How to catch this next time

The config keys ARE Codex's `config.toml` schema and drift with the CLI. There
is no compile-time check — a stale key just stops suppressing. The detector is a
**token measurement against the installed Codex**: a one-shot `CodexOneShotClient`
turn with `threadConfig: PWRSNAP_CODEX_THREAD_CONFIG` should yield a few-thousand
input tokens, not tens of thousands. If it balloons after a Codex upgrade, diff
the config against the Codex source (`codex-rs/config/src/config_toml.rs`,
`skills_config.rs`) for renamed keys.

## Note on agent-kit

The kit was NOT at fault and needs no change. `CodexOneShotClient` forwards
`threadConfig` → Codex `config`, and `AgentStartThreadOptions.config` does the
same for the chat clients. The feature-control seam is cleanly exposed; the bug
was purely the stale config CONTENT on PwrSnap's side.
