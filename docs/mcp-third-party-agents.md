# Connecting a third-party agent to PwrSnap

Shipped-behavior reference for PwrSnap's loopback MCP surface: what an
operator does, what the app does, and what a change here must not break.
For the architectural framing see [architecture.md](architecture.md)
§"Process and transport shape"; for the enforcement rules see AGENTS.md.

## One door

PwrSnap serves MCP over `http://127.0.0.1:51729/mcp` while
**Settings → Local Agents → Enable local-agent access** is on. The only way
to get a credential for it is OAuth 2.1 against the same origin: dynamic
client registration at `/register`, an authorization request at
`/authorize` with PKCE (S256), PwrSnap's **native approval window**, a
redirect back to the client, and a code exchange at `/token`. Metadata is
published at the standard `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp` locations, and an
unauthenticated `POST /mcp` answers `401` with a `WWW-Authenticate` header
that points at the latter — which is how a client discovers all of this on
its own.

What comes out is an ordinary Session in Settings → Local Agents: same
role, same budgets, same **Revoke**. The operator picks the Session Name
and role in PwrSnap's own window; the browser page a client opens cannot
approve anything (it has no form and no script — the server test pins
that), it only waits.

There is deliberately no second way to mint a token. A device-flow-shaped
"pair" endpoint was built and removed in
[pwrdrvr/PwrSnap#561](https://github.com/pwrdrvr/PwrSnap/pull/561) once it
was measured that the agents it was meant for already speak the door above.

## What an operator does

Both recipes were verified end to end against the real server on 2026-09-05
(Claude Code 2.1.251, Codex CLI 0.152.1). Settings → Local Agents prints
them with the live endpoint filled in.

**Claude Code**

```bash
claude mcp add --transport http pwrsnap http://127.0.0.1:51729/mcp
claude mcp login pwrsnap
```

`add` records the server (`-s user` makes it available in every project).
`login` registers a client, opens the authorization URL in the browser,
and waits; PwrSnap's approval window opens; after approval Claude Code
prints *Authenticated with "pwrsnap". Its tools are now available.* Before
login, `claude mcp get pwrsnap` reports *Needs authentication*; after,
*✔ Connected*. A session then connects in tens of milliseconds. Claude Code
runs its own loopback redirect (`http://localhost:<port>/callback`), so no
redirect URI has to be pre-registered.

**Codex CLI**

```bash
codex mcp add pwrsnap --url http://127.0.0.1:51729/mcp --oauth-client-registration dcr
```

Codex detects OAuth support during `add` and starts the flow itself
(`codex mcp login pwrsnap` is only needed later, to re-authenticate).
`--oauth-client-registration dcr` names the registration strategy PwrSnap
supports. A subsequent `codex exec` that uses a PwrSnap tool completes the
call; PwrSnap records it against the Session.

**Anything else** that implements MCP's OAuth client role — dynamic
registration, PKCE S256, a loopback redirect — works the same way.
PwrAgent's client is one reference implementation. A client that has no
OAuth client at all is out of scope for this surface; do not add a
credential path for it that bypasses the approval window.

## Two things a client does that the server must answer cleanly

- **`GET /mcp` answers 405.** PwrSnap's endpoint is stateless — a fresh
  transport and a fresh `McpServer` per POST — so there is no session for
  a standalone SSE stream to belong to. Both verified clients open that
  GET as part of every connection (Codex before it even initializes).
  Letting the SDK transport handle it returns a stream that never ends,
  which pinned one transport + `McpServer` per live agent session until
  the client went away. 405 is the spec's answer for "no SSE stream at
  this endpoint"; both clients treat it as such and carry on.
- **A newer version-negotiation probe gets a clean 400.** Claude Code
  first POSTs a `server/discover` probe on a protocol version the pinned
  MCP SDK does not know; the SDK rejects it with 400 and Claude Code falls
  back to the classic `initialize`. Harmless; an SDK bump would answer it
  natively.

## Tool results carry their data twice

`toMcpToolResult` emits `structuredContent` **and** a text block holding
the same JSON. MCP says a tool returning `structuredContent` SHOULD also
serialize it, because a host that renders only `content` otherwise shows
the agent a summary sentence with no data in it. PwrSnap used to emit the
summary alone — "PwrSnap returned 1 capture. See structuredContent for
result fields." — which reads fine until you drive it from such a host
and get a sentence about where the answer went.

The JSON block goes **last**, after any `resource_link`. For a media tool
the link is the answer and belongs next to the sentence introducing it;
the JSON is the fallback copy of the metadata. It never carries the
signed media URL — that lives only in the resource link, and
`mcp-tool-registry.test.ts` asserts no other block contains it.

## The rules the door must keep

Enforced by the express middleware every route inherits (`mcp-server.ts`)
and pinned by `mcp-server.test.ts`:

- **Only loopback peers.** A non-loopback remote address gets 403 before
  any route runs.
- **Origin is validated.** Any web page the operator visits can POST to
  127.0.0.1; `Origin` is what separates a browser from a local process.
  A request with no Origin (a local process) is allowed; one from any
  non-loopback origin is refused.
- **Host is validated too.** A hostname that resolves to loopback defeats
  an Origin check alone, so `Host` must be the bound `127.0.0.1:<port>`.
- **Nothing is minted until the operator approves in the app window**, an
  unanswered authorization expires, and a second Session under an active
  Session Name is refused with an actionable `invalid_grant` — the
  operator revokes or renames first.

## How this was verified, so it can be re-verified

A vitest test under `apps/desktop/src/main/local-agents/__tests__/` boots
`LocalAgentMcpServer` on the real port with a stub `requestConsent` that
answers "allow", then drives the installed CLI with **async** `spawn`
under a Python `pty.spawn` wrapper and reads the raw `http.Server`
`request` events. Three traps, each of which cost real time:

- `spawnSync` blocks the event loop the server lives on. The client's
  requests then sit in the kernel backlog, the client reports a 30 s
  connect timeout with nothing on the wire, and the queued requests EPIPE
  the instant the sync call returns. It looks exactly like a server bug.
- `claude mcp login --no-browser` needs a TTY to accept the pasted
  redirect URL; macOS `script -q` cannot wrap a Node socketpair
  ("tcgetattr/ioctl: Operation not supported on socket"), Python's
  `pty.spawn` can.
- Under nvm, `claude` on PATH can resolve to an older npm-installed copy
  without `mcp login`. Spawn the absolute path of the native install.

Codex's `mcp login` has no non-browser mode; it opens the system browser,
which is fine — the page only waits for the native window.
