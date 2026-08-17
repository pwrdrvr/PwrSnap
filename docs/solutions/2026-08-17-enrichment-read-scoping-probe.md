# Enrichment read scoping — what `sandbox: "read-only"` does and doesn't do

**Date:** 2026-08-17
**Context:** [#69](https://github.com/pwrdrvr/PwrSnap/issues/69) /
[#423](https://github.com/pwrdrvr/PwrSnap/pull/423)
**Status:** schema solved and measured; not yet wired into PwrSnap

Read this before attempting to scope what a capture-enrichment turn can
read. Everything below was measured against live Codex binaries
(0.146.0 via Homebrew, 0.148.0-alpha.9 bundled in ChatGPT.app), **not**
inferred from the protocol types. No model turns were run, so none of it
cost tokens — the probes use `codex sandbox` and the app-server's
`command/exec`, both of which execute locally in the sandbox without a
thread or a turn.

## The finding: `read-only` does not scope reads

Enrichment's posture is `sandbox: "read-only"`
([enrichment-sandbox.ts](../../apps/desktop/src/main/ai/enrichment-sandbox.ts)).
That denies **writes and network**. It does **not** restrict reads.

```console
$ cd <jail>
$ codex sandbox -c sandbox_mode=read-only cat <file far outside the jail>
SECRET-CANARY-VALUE
exit=0
```

Reproduced independently through the app-server:

```
TODAY  (sandboxPolicy: { type: "readOnly", networkAccess: false })
  inside jail            exit=0    INSIDE-JAIL-OK
  OUTSIDE jail           exit=0    SECRET-CANARY-VALUE
```

So every file the user's account can read — all of `~/Documents`, ssh
keys, cloud credentials — is readable from inside the jail if a shell
tool is reachable on an enrichment thread. Moving the jail out of
`~/Documents` (which #423 did) changes where the agent *starts*, not what
it can *reach*.

What stands in the way today, in order: the deny handlers on every
one-shot thread, `disableConfiguredMcpServers`, and `approvalPolicy:
"never"`. Network denial caps the blast radius — read content can only
surface through the enrichment JSON into PwrSnap's own DB.

`SandboxMode` is `read-only | workspace-write | danger-full-access`.
None of them is "reads confined to cwd".

## The lever: named permission profiles

`ThreadStartParams` has a second, mutually exclusive path:

```ts
/** Named profile id for this thread. Cannot be combined with `sandbox`. */
permissions?: string | null;
```

Confirmed working end-to-end against a live app-server — the profile can
ride in the same `config` overlay PwrSnap already sends, so no new
transport is needed:

| Probe | Result |
|---|---|
| `sandbox: "read-only"` (today) | OK, thread starts |
| `permissions: "p"`, no `[permissions]` table | `failed to load configuration: default_permissions requires a `[permissions]` table` |
| `permissions: "p"` + profile in `config` | **OK, thread starts** |
| `sandbox` + `permissions` together | `` `permissions` cannot be combined with `sandbox` `` |

### It fails closed

Every malformed or unrecognized profile denied **everything**, including
the jail itself (`exit=134` on a read that `read-only` allows). Codex
logs:

```
Permissions profile `x` does not define any recognized filesystem entries
for this version of Codex. Filesystem access will remain restricted.
```

This is the safe direction: a wrong profile breaks enrichment loudly
instead of silently widening the posture. It is the opposite of the
`web_search` trap in
[codex-thread-config.ts](../../apps/desktop/src/main/ai/codex-thread-config.ts),
where a bad value silently fell back to the full prompt.

## The schema — SOLVED

Source of truth: `codex-rs/config/src/permissions_toml.rs` and
`codex-rs/core/src/config/permissions.rs` in
[openai/codex](https://github.com/openai/codex) (Apache-2.0, so reading it
is allowed under AGENTS.md § "Dependency licensing").

`PermissionProfileToml` is `{ description, extends, workspace_roots,
filesystem, network }`. The trap is that **`filesystem` is a flattened
`path → access` map**, not an `entries` array — neither shape exposed by
`@pwrdrvr/codex-app-server-protocol` matches, which is why every guess
failed. `workspace_roots` is likewise a flattened `path → bool` map, not
a list.

Special keys (`parse_special_path`): `:root`, `:minimal`,
`:workspace_roots` (alias `:project_roots`), `:tmpdir`, `:slash_tmp`.
Anything else starting with `:` round-trips as `Unknown` and is warned +
ignored rather than aborting config load, so new specials are
forward-compatible. Access modes are `read | write | deny`.

### The working profile

```toml
[permissions.pwrsnap_enrichment.filesystem]
":root"    = "deny"
":minimal" = "read"
"<jail>"   = "read"
```

**`:minimal` is required.** With only `":root" = "deny"` plus the jail,
every command dies with SIGABRT — denying `:root` also denies reading
`/bin/cat`, so the process cannot exec. `:minimal` grants the system
paths needed to launch a process and nothing else.

### Measured result

Same probe harness, same machine:

| Target | `sandbox: "read-only"` | permissions profile |
|---|---|---|
| file inside the jail | ALLOWED | ALLOWED |
| file outside the jail | ALLOWED | DENIED |
| `~/Documents` | **ALLOWED** | DENIED |
| `~/.ssh` | **ALLOWED** | DENIED |
| `~/.aws` | **ALLOWED** | DENIED |
| network | DENIED | DENIED |

So the profile closes the read hole while preserving everything
`read-only` already gave us.

### Applying it to enrichment

`permissions` and `sandbox` are mutually exclusive on `thread/start`, so
the enrichment posture swaps one for the other and supplies the profile
through the `config` overlay PwrSnap already sends:

```jsonc
{
  "permissions": "pwrsnap_enrichment",
  // NOT "sandbox" — the two cannot be combined
  "config": {
    "permissions": {
      "pwrsnap_enrichment": {
        "filesystem": { ":root": "deny", ":minimal": "read", "<jail>": "read" }
      }
    }
  }
}
```

`default_permissions` is only needed when selecting a profile from
config; passing `permissions` on `thread/start` selects it directly.

Two things that make this safer than it looks:

- **The sandbox constrains commands the agent runs, not the app-server
  process itself.** Codex still reads its own `CODEX_HOME`, auth, and the
  turn's image input normally. Enrichment is one prompt in, one JSON
  object out with no tools, so a profile that denies everything has no
  effect on a well-behaved turn — it only bites when the model tries
  something enrichment should never do.
- **It fails closed.** An unrecognized profile denies everything rather
  than silently widening.

The residual risk is a Codex build that rejects the `permissions` field
outright, which would fail `thread/start` and break enrichment. PwrSnap's
CLI floor is 0.144.0 and the pinned protocol package declares
`permissions`, but the filesystem-key recognition was only verified on
0.146.0 and 0.148.0-alpha.9. A one-shot fallback to
`sandbox: "read-only"` on a `thread/start` rejection covers that.

## ACP has no equivalent lever

None of this applies to the ACP backend (Gemini / Qwen / Grok / Kimi).
`AcpStartThreadOptions` is `{ cwd?, mcpServers? }` and the kit drops
`sandbox` / `approvalPolicy` / `workspaceRoots` as Codex-only. There is
no sandbox to configure and no network denial either. See AGENTS.md
§ "Capture enrichment runs in a sandbox jail" → "The two backends are NOT
equally protected".

## Unverified, and worth checking

On macOS, the Codex/ACP child process is spawned by PwrSnap and may
inherit PwrSnap's TCC responsibility — and with it the user's granted
Documents access. If so, the agent reaches `~/Documents` *because
PwrSnap can*, and no cwd choice changes that; only a real read scope
would.
