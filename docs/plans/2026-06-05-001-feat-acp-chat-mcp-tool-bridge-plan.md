---
title: "feat: ACP chat MCP tool bridge"
status: complete
date: 2026-06-05
completed: 2026-06-05
type: feat
target_repo: PwrSnap (this repo)
---

# ACP Chat MCP Tool Bridge — Plan

Status: **Shipped** (2026-06-05), merged in **PR #195** (`0e48bcfb`).
Live-verified: Gemini spawns the PwrSnap MCP server and calls a tool end to end
(`draw_arrow(cap-77)` through the full chain). The one open verification is a
signed/notarized packaged-build spawn check (see P4 below). Part of the broader
agent-kit consumption tracked by
`2026-06-02-001-feat-consume-agent-kit-plan.md` (now complete).

## Shipping status

- **P1 — RPC core:** `pwrsnap-tool-rpc-server.ts` (UDS + token + per-surface
  catalog/dispatch). Shipped + tested.
- **P2 — MCP server:** `pwrsnap-mcp-server-entry.ts` (official
  `@modelcontextprotocol/sdk`), `pwrsnap-tool-rpc-client.ts`, pure
  `mcp-translate.ts`. Shipped + tested (incl. a spawn smoke).
- **P3 — Wiring + build:** `buildPwrSnapMcpServer` + `defaultMakeAcpClient`
  passes `mcpServers`; electron-vite builds `pwrsnap-mcp-server.js` as a main
  entry. Shipped.
- **P4 — Live + packaging:** Live Gemini run executed `draw_arrow(cap-77)`
  through the full chain. Packaging: `files: out/**/*` ships the entry and
  `package.json` pulls the SDK into the asar — pure JS loads from asar under
  `ELECTRON_RUN_AS_NODE`, no `asarUnpack` needed. **Still to do on a real
  packaged build:** confirm asar spawn works on a signed/notarized `.app`
  (couldn't be exercised from a dev checkout).

### Required kit fix (shipped in `@pwrdrvr/agent-acp` 0.2.1)

ACP's `McpServer` wire shape needs `args: string[]` and
`env: Array<{name,value}>`; the kit had been sending `env` as a `Record` with
`args` omitted, so Gemini failed `session/new` with `-32603`. Fixed at the
protocol boundary (the ergonomic `Record` API is unchanged).

### Security review (2026-06-05) — design sound

A `ce-security-reviewer` pass found **no exploitable vulnerabilities**. The token
is the real authn (24 random bytes / 192-bit, never logged), transport is a
user-scoped UDS (no network), the capability boundary is bounded to the ~23-tool
allowlist, all tool args are zod-validated and resolve through parameterized
SQLite primary-key lookups (no path-traversal / SSRF / arbitrary file I/O), the
spawned process is fully PwrSnap-controlled, and cross-surface token isolation
holds. Acted on the findings:

- **Hardened** the UDS server: socket dir created `mode 0o700` (no umask
  window) with a logged (not swallowed) chmod failure; per-socket 30s idle
  timeout; `server.maxConnections = 32`; oversize-line rejection now `end()`s
  (flushes the rejection) instead of `destroy()`.
- **Locked invariants with tests**: cross-surface isolation, unauthorized token
  never reaches `dispatchToolCall`, and the 256 KB oversize cap. (Off-allowlist
  tool rejection was already covered in `library-tool-catalog.test.ts`.)

**One architectural recommendation left as a follow-up:** `principal: "mcp"` is
currently a logging label only — the allowlist is the *sole* enforcement layer
(sound today: `dispatchLibraryToolCall` strictly resolves `params.tool` against
the allowlist). A bus-level backstop that asserts the dispatched command name is
in an mcp-permitted set when `principal === "mcp"` would harden against future
drift. Deferred deliberately: a hand-maintained permitted-verb set (tools fan out
to many bus verbs) is itself drift-prone and could create false confidence or
break tools if incomplete — it deserves its own focused change with the verb set
derived/verified against the allowlist, not a rushed literal.

### Known follow-ups (non-blocking)

- `buildPwrSnapMcpServer` returns an `unregister` that `defaultMakeAcpClient`
  currently drops; tokens accumulate one-per-surface (negligible — surfaces are
  app-lifetime singletons). Wire `unregister` + `server.stop()` on teardown when
  convenient.
- Tool calls trust the agent-supplied `capture_id` (same exposure as the Codex
  backend — the allowlist is the boundary). If we later want hard per-thread
  anchor scoping, enforce it in the RPC server.
- Confirm the asar MCP-entry spawn works on a **signed/notarized** packaged
  `.app` (P4 — couldn't be exercised from a dev checkout).

### ACP enrichment polish follow-ups (from PR #213, non-blocking)

These came out of the Grok/ACP enrichment polish (`906efe33`) and touch the same
ACP surface, parked here for whenever they earn their keep:

- **Gray out un-runnable models.** Remember which models an agent rejects on
  `session/set_model` (`-32602` — e.g. Grok rejecting Cursor's "Composer 2.5")
  and disable them in the Job-routing picker, so a model that won't run can't be
  picked. Today the run honestly falls back to the agent default and the strip
  shows a "you picked X — agent ran Y" note, but the picker still offers X.
- **Eager-warm model-label caches.** The ACP (`acp-model-cache`) and Codex
  (`codex-model-cache`) id→label caches warm when Settings → AI Providers lists
  models; a run viewed before that shows the raw id, then the friendly name.
  Could warm at startup.

---

(Original plan follows.)

Status: **Proposed** (not started). Author handoff: 2026-06-05.

## Problem

PwrSnap chat agents can call PwrSnap tools ("delete that arrow", "make all
arrows orange and Large") only when the chat backend is **Codex** — the
`ChatThreadController` registers a `DynamicToolSpec[]` catalog and routes
`DynamicToolCall`s back through `dispatchLibraryToolCall`
([library-tool-catalog.ts](../../apps/desktop/src/main/ai/library-tool-catalog.ts)).

When the chat backend is a **local ACP agent** (Gemini/Qwen), the agent gets
**no PwrSnap tools at all**:

- `AcpAgentClient.startThread` ignores the neutral `tools` option (ACP has no
  Codex-style dynamic-tool seam).
- `AcpAgentClient.startTurn` only sends prompt content blocks — the catalog is
  never advertised.

So an ACP chat agent today is a plain chatbot: it can talk about the snap but
cannot act on layers. This plan wires PwrSnap's existing tool allowlist to ACP
agents over **MCP** (the only tool mechanism ACP exposes), so an action a user
can take, an ACP agent can also take (agent-native parity).

### What is already done (prerequisites — shipped)

- `@pwrdrvr/agent-acp` ≥ 0.2.0: **non-blocking turns** (tool-using turns can
  take many round-trips without freezing the composer) and **system-prompt
  fold** (ACP chat agents receive the host persona + anchor context).
- The kit's `AcpAgentClient` already accepts `mcpServers: AcpMcpServerConfig[]`
  (`{ name, command, args?, env? }`) and forwards them to `session/new`. **No
  kit change is required for the bridge** — the work is entirely in PwrSnap.
- ACP chat sessions are pinned to a small scratch `cwd`.
- The command-bus already models an `mcp` `CommandPrincipal`
  ([command-bus.ts](../../apps/desktop/src/main/command-bus.ts)) — but no
  server backs it yet.

## Constraint that shapes the architecture

`AcpMcpServerConfig` is **stdio-only**: the ACP agent (Gemini) *spawns the MCP
server as its own child process* and speaks MCP over that child's stdio.
PwrSnap does not own that process tree. Therefore the spawned MCP server is a
**separate process from PwrSnap main** and must call **back** into main to
execute a tool. There is no way around a local IPC channel between the spawned
MCP server and PwrSnap main.

```
Gemini (ACP agent, child of PwrSnap transport)
  └─ spawns ──> pwrsnap-mcp-server (stdio MCP)   [tools/list, tools/call]
                   └─ calls back ──> PwrSnap main (UDS, token-auth)
                                        └─ command-bus (principal: mcp)
                                             └─ dispatchLibraryToolCall(anchor-scoped)
```

## Chosen design

### Transport between the spawned MCP server and main: Unix domain socket

- Main listens on a **Unix domain socket** under `app.getPath("userData")`
  (e.g. `mcp/<random>.sock`), created `0700`, removed on app quit. No TCP
  port, no network surface, filesystem-permission scoped to the user. (Windows
  has no UDS in the Electron Node build — defer; macOS-first per repo policy.)
- A **random per-app-run bearer token** is generated at startup and passed to
  the spawned MCP server via env. Every UDS request must present it. The token
  never touches disk except as a process env of children we spawn.

### The spawned MCP server runs on Electron-as-Node (no extra runtime)

- `command = process.execPath` with `env.ELECTRON_RUN_AS_NODE = "1"` so we
  reuse the bundled Electron binary as a plain Node — no separate `node` on
  the user's PATH required (important for packaged apps).
- `args = [<path to bundled pwrsnap-mcp-server entry>]`.
- Per-session env: `PWRSNAP_MCP_SOCKET`, `PWRSNAP_MCP_TOKEN`,
  `PWRSNAP_MCP_THREAD` (the chat threadId, for anchor scoping), and
  `PWRSNAP_MCP_CATALOG` (a path to a JSON file with the tool list, written at
  spawn time, so `tools/list` needs no round-trip).

### Components

1. **`apps/desktop/src/main/ai/mcp/pwrsnap-tool-rpc-server.ts`** — UDS server in
   main. One per app. Validates `{ token, threadId, tool, namespace, arguments }`,
   confirms `threadId` is a live chat thread, resolves that thread's anchor,
   and calls the surface's `dispatchToolCall` (same path Codex uses). Returns
   the `DynamicToolCallResponse`. Never throws across the boundary.

2. **`apps/desktop/src/main/ai/mcp/pwrsnap-mcp-server-entry.ts`** — the spawnable
   stdio MCP server. A **separate electron-vite build entry** (like preload).
   Implements MCP `initialize` / `tools/list` / `tools/call`. `tools/list`
   reads `PWRSNAP_MCP_CATALOG`; `tools/call` forwards to the UDS. Hand-rolled
   minimal stdio JSON-RPC **or** `@modelcontextprotocol/sdk` (MIT — allowed;
   decide in Phase 1; prefer the SDK if it doesn't bloat the spawn).

3. **Schema translation** — `DynamicToolSpec` → MCP tool `{ name, description,
   inputSchema }`. The allowlist already carries zod schemas; reuse the JSON
   Schema that `toDynamicToolSpec` produces (or `zod-to-json-schema`).

4. **Wiring** — `defaultMakeAcpClient`
   ([chat-controller-factory.ts](../../apps/desktop/src/main/ai/chat-controller-factory.ts))
   passes `mcpServers: [pwrsnapMcpServerConfig(threadScope)]` to the
   `AcpAgentClient`. The catalog + dispatch already flow into `buildChatSurface`.

5. **Packaging** — electron-builder must ship the MCP entry script (+ any deps)
   in resources/asar and it must be runnable via `ELECTRON_RUN_AS_NODE`. Add a
   lifecycle/path test.

### Security (must-haves, gated by `ce-security-*` review before merge)

- UDS path in userData, `0700`, unlinked on quit; reject if perms wrong.
- Constant-time token compare; reject unauthenticated/oversized payloads.
- `principal: "mcp"` capability check in the command-bus — the MCP path may
  invoke **only** the chat tool allowlist, never arbitrary verbs, never
  secrets, never settings writes.
- Per-thread anchor scoping: a tool call is bound to the spawning thread's
  capture/project; it cannot reach other captures.
- Tool approvals reuse the existing ACP `session/request_permission` → approval
  modal flow (already wired in `LibraryChatPanel`).

## Phasing

- **P1 — RPC core:** UDS server + token + `dispatchToolCall` bridge in main,
  unit-tested with a fake client. No agent yet.
- **P2 — MCP server entry:** the stdio MCP server + electron-vite entry +
  schema translation; tested by driving it over a pipe.
- **P3 — Wiring + packaging:** attach `mcpServers` in `defaultMakeAcpClient`;
  electron-builder resource; lifecycle test.
- **P4 — Live + hardening:** live Gemini run executing a real PwrSnap tool;
  security review; agent-native-parity review.

## Risks / open questions

- **MCP SDK vs hand-rolled.** SDK is correct but adds spawn weight; a hand-
  rolled stdio JSON-RPC MCP server is ~150 lines and dependency-free. Lean
  hand-rolled unless the SDK earns its keep.
- **Tool-result streaming.** Long tool calls — confirm the non-blocking turn +
  approval modal compose cleanly when a turn fans out several tool calls.
- **Qwen/other ACP agents' MCP support** may vary; verify each strategy honors
  `session/new` `mcpServers`.
- **Cross-platform.** UDS is macOS/Linux; Windows named pipe is a P8 follow-up.

## Test strategy

Unit: RPC auth/scoping/failure-policy; schema translation; MCP `tools/list`
/`tools/call` over an in-memory pipe. Integration: `buildChatSurface` attaches
the server config. Live: Gemini executes a real allowlist tool end to end.
