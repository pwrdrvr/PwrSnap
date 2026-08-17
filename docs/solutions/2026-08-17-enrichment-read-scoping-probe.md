# Enrichment read scoping — what `sandbox: "read-only"` does and doesn't do

**Date:** 2026-08-17
**Context:** [#69](https://github.com/pwrdrvr/PwrSnap/issues/69) /
[#423](https://github.com/pwrdrvr/PwrSnap/pull/423)
**Status:** open problem, lever identified, schema not yet nailed

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

## What's still unknown — the profile schema

Neither shape exposed by `@pwrdrvr/codex-app-server-protocol` is accepted
by 0.146.0 **or** 0.148.0-alpha.9:

- `file_system.entries[{ path, access }]` (the `FileSystemSandboxEntry` form)
- `file_system.read[] / write[]` (the legacy form the types mark as
  "will be removed in favor of `entries`")

Field names pulled from the binary's serde metadata suggest the real
`PermissionProfileToml` is:

```
description   extends   workspace_roots   filesystem   network
```

Note `filesystem` (one word), not `file_system`. `workspace_roots` is a
**struct** (`WorkspaceRootsToml`), not an array — passing a list gives
`invalid type: sequence, expected struct WorkspaceRootsToml`. The
sub-shape of `filesystem` was not determined. `FileSystemAccessMode` is
`read | write | deny` and `FileSystemPath` supports
`{ type: "special", value: { kind: "root" | "minimal" | "tmpdir" |
"project_roots" | "slash_tmp" } }` — which is exactly the "deny root,
allow tmpdir" vocabulary this needs.

**Do not guess further from the type definitions.** Get the schema from
Codex's own config documentation. Trial and error burned an afternoon and
produced only fail-closed denials.

Also relevant: PwrSnap pins the protocol package at **0.144.0** while
ChatGPT.app already ships **0.148.0-alpha.9**, so the package's types may
lag the config surface the running binary actually accepts.

## Reproducing

`command/exec` is the cheapest probe — it runs a command in the server
sandbox with no thread, no turn, and no model tokens, and takes either
`sandboxPolicy` or `permissionProfile`:

```jsonc
// initialize FIRST with experimentalApi, or runtimeWorkspaceRoots is rejected
{ "method": "initialize", "params": {
    "clientInfo": { "name": "probe", "title": null, "version": "0.0.0" },
    "capabilities": { "experimentalApi": true, "requestAttestation": false } } }

{ "method": "command/exec", "params": {
    "command": ["cat", "<canary outside the jail>"],
    "cwd": "<jail>",
    "sandboxPolicy": { "type": "readOnly", "networkAccess": false } } }
```

Two traps:

- **`thread/shellCommand` is not a valid test.** Its own doc says it
  "runs unsandboxed with full access rather than inheriting the thread
  sandbox policy."
- **`codex sandbox -c permissions.…` cannot express a profile.** `-c`
  parses the value as TOML, and the profile path aborts the CLI with
  SIGABRT and no message. Use a temp `CODEX_HOME` with a real
  `config.toml`, or the app-server `config` overlay.

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
