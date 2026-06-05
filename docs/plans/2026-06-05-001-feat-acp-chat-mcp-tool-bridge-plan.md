# ACP Chat MCP Tool Bridge — Plan

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
