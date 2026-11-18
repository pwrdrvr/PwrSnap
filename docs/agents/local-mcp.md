# Agent rules: Local agent access (MCP)

This file holds rules that used to live in the root
[AGENTS.md](../../AGENTS.md), moved here verbatim so the root file stays
under Codex's 32 KiB project-doc cap. The root keeps a one-line summary of
each section below and says when to read this file. The rules here bind
exactly as they did there. A reference to a section that is not in this file
("see Workflow above", a heading quoted in a code comment) means the root
AGENTS.md or one of the other files in `docs/agents/`.

## Local agent access — desktop-owned MCP, native approval

External agents launch the bundled `pwrsnap-mcp` Rust stdio byte relay.
Electron main owns the complete MCP interface and every privileged handler.
The relay must never launch the desktop, implement tools, translate schemas,
execute commands, or expose a standalone fallback. The native listener is a
transport child of the already running desktop. Keep the socket/pipe peer
checks, protected endpoint ownership and bounded I/O on both native roles.

- There is no MCP TCP or WebSocket listener, including media delivery. One
  protected IPC endpoint accepts explicit versioned raw relay framing or
  HTTP/1.x, classified once with a bounded preamble and deadline. Preserve
  every prefetched HTTP byte. Electron owns the HTTP parser and both modes
  use the same MCP server factory, handlers and authorization. The HTTP server
  must never call listen(). Internal ACP endpoints remain raw-only.
- Direct HTTP clients bootstrap in Settings through native consent, receive a
  two-minute single-initialize bearer credential, and send it on every request
  with the MCP Session id. Session ids and same-user IPC confer no authority.
  Closing the last authenticated IPC connection or an unfinished request/SSE
  stream revokes the Session. No SSE resumption or event replay. Retained legacy
  credentials are not accepted by this transport; never replay or transfer
  their approvals. Browser OAuth over IPC is unsupported; no TCP fallback.
- A relay connection is never prompted. The client names its role on the
  relay command line (`pwrsnap-mcp --role <id>`), and `mcp-server.ts` grants
  exactly that role, or Full Access when none is named
  (`local-agent-relay-role.ts`). An unknown id refuses the connection and never
  falls back to another role. A client the operator does not trust with
  everything connects with a lower role; an untrusted model belongs in a
  contained environment, not on this machine's PwrSnap. Direct IPC HTTP has no
  command line, so it still opens `openNativeSession` only after native
  consent. Either way the connection ceiling is enforced by `authorizeClient`
  as well as the MCP boundary, so command-bus role re-resolution cannot widen
  the grant. A disconnect revokes the session. Modern stdio `server/discover`
  may return public server metadata without creating a grant; every protected
  request, including skill discovery/reads, needs the connection's grant. Internal ACP remains
  initialize-only, and discovery-only connections keep their admission timeout.
- Every tool/resource read retains capability, history, usage-budget,
  revocation and owner checks. Tool results keep `structuredContent` and a
  trailing text JSON block. Media is read through canonical MCP resources,
  never through a new port or filesystem path disclosure.
- Full bidirectional MCP messages belong to the desktop: preserve
  notifications, server requests, cancellations, metadata and extension
  fields in the byte transport. Transport compatibility and MCP capabilities
  are separate from release equality; desktop initialization is authoritative.
- A closed/overflowed stdio/control transport must close native IPC and SDK
  resources. Reclaim idle revoked connections before checking the cap;
  serialize cleanup and admission so concurrent replacements cannot over-admit.
- Missing, disabled or disconnected desktops fail with actionable manual
  reconnect instructions. No reconnect/replay under an active session.
- The internal ACP stream retains its separate per-chat token, catalog and
  dispatcher boundary. Registration revocation closes its connections.
  Catalog snapshots/translation do not belong in a caller-launched adapter.
  List-change notifications require hosts to re-discover; loaded skills and
  initialization metadata do not refresh themselves.
- **Advertise MCP skills through the [Skills extension (SEP-2640)](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills):** declare `io.modelcontextprotocol/skills` in capabilities, implement `skills/list` / `skills/get` with verbatim frontmatter and complete SHA-256/byte-size file manifests, and serve files through `resources/read`; use the SDK's extension and the discovery mechanism for the supported protocol revision, with custom reader tools only as a compatibility fallback.

Owners: `local-agents/mcp-server.ts`, `ai/mcp/native-mcp-bridge.ts`,
`ai/mcp/pwrsnap-tool-rpc-server.ts`, and `crates/pwrsnap-mcp/`.
See [docs/mcp-third-party-agents.md](../../docs/mcp-third-party-agents.md).
