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
them, with a Copy button, once the listener reports `listening`. The
endpoint is the fixed `http://127.0.0.1:51729/mcp` (`LOCAL_AGENT_MCP_PORT`
in `mcp-server.ts`, not configurable); the Settings page carries its own
copy of that constant rather than reading it from the listener status, and
`LocalAgentsPage.test.tsx` pins the exact command text.

**Claude Code**

```bash
claude mcp add --scope user --transport http pwrsnap http://127.0.0.1:51729/mcp
claude mcp login pwrsnap
```

`add` records the server. `--scope user` matters: the default scope is
`local`, which registers the server for the terminal's current directory
only, so a paste from a terminal sitting at `~` would leave every project
without PwrSnap. `login` registers a client, opens the authorization URL in the browser,
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

- **Every verb but POST on `/mcp` answers 405 with `Allow: POST`.**
  PwrSnap's endpoint is stateless — a fresh transport and a fresh
  `McpServer` per POST — so there is no session for a standalone `GET`
  SSE stream to belong to and none for a `DELETE` to terminate. Both
  verified clients open that GET as part of every connection (Codex
  before it even initializes). Letting the SDK transport handle it
  returned a stream that never ended; because the server awaited the
  stream body, the request never completed and the transport +
  `McpServer` behind it lived for the rest of the process. 405 is the
  spec's answer for "no SSE stream at this endpoint"; both clients treat
  it as such and carry on. Neither sends `DELETE` without a session id,
  which this server never issues, and both treat 405 on it as
  "unsupported, fine". The check runs before auth, in `handleRequest`.
- **A newer version-negotiation probe gets a clean 400.** Claude Code
  first POSTs a `server/discover` probe on a protocol version the pinned
  MCP SDK does not know; the SDK rejects it with 400 and Claude Code falls
  back to the classic `initialize`. Harmless; an SDK bump would answer it
  natively.

## Tool results carry their data twice

`toMcpToolResult` (`mcp-tool-registry.ts`) emits `structuredContent`
**and** a text block holding the same JSON. MCP says a tool returning
`structuredContent` SHOULD also serialize it, for hosts that read only
`content`; such a host would otherwise be handed a summary sentence with
no data in it. PwrSnap used to emit the summary alone — "PwrSnap returned
1 capture. See structuredContent for result fields."

Know what this buys and what it costs. Claude Code and Codex both read
`structuredContent` and drop the text copy before the model sees it, so
for the two verified clients the block is neither help nor harm; the
payload is doubled only on the loopback wire. The block exists for
content-only hosts, which neither of them is.

The JSON block goes **last**, after any `resource_link`. For a media tool
the link is the answer and belongs next to the sentence introducing it;
the JSON is the fallback copy of the metadata. It never carries the
signed media URL — that lives only in the resource link. `structuredContent`
is always a JSON object; a non-object value is wrapped as `{ value }`,
because the SDK client parses it as a record and fails the whole call on
an array. `mcp-tool-registry.test.ts` pins all of this.

## The rules the door must keep

The first three are enforced by the express middleware every route
inherits (the `app.use` at the top of `LocalAgentMcpServer.start()` in
`mcp-server.ts`); `mcp-server.test.ts` pins the Origin and Host refusals
and the minting rules. The loopback-peer refusal is enforced but has no
test, because every test client is itself a loopback peer.

- **Only loopback peers.** A non-loopback remote address gets 403 before
  any route runs.
- **Origin is validated.** Any web page the operator visits can POST to
  127.0.0.1 with a perfectly correct `Host`, so Origin is the check that
  stops a cross-site request: an Origin whose hostname is not
  `127.0.0.1`, `localhost`, or `[::1]` is refused. A request with no
  Origin is allowed — local processes send none, but so do browser
  navigations, `<img>` loads, and plain GET forms, which is why the next
  rule exists and why no Origin-less path mints or reveals anything
  (`GET /mcp` is 405, the `/authorize` page has no form, `/media` needs a
  signed URL).
- **Host is validated too.** A hostname the attacker points at 127.0.0.1
  (DNS rebinding) yields same-origin GETs that carry no Origin at all and
  whose responses the page can read — an Origin check alone lets them
  through. `Host` must therefore equal the bound `127.0.0.1:<port>`
  exactly; `localhost:<port>` is refused.
- **Nothing is minted until the operator approves in the app window**, an
  unanswered authorization expires, and a second Session under an active
  Session Name is refused with an actionable `invalid_grant` — the
  operator revokes or renames first. `local-agent-minting-boundary.test.ts`
  greps the production sources so that the OAuth code exchange stays the
  only caller of the grant service's minting path.

## How this was verified, so it can be re-verified

The measurement was a scratch probe, not a committed test: a script
booted `LocalAgentMcpServer` on the real port with a stub `requestConsent`
that answered "allow", drove the installed CLI, and read the raw
`http.Server` `request` events. It was not kept because it depends on the
operator's installed CLIs, their versions, and a TTY. To repeat it by
hand: turn on local-agent access in a dev build, run the recipes above,
approve in the window, then `claude mcp get pwrsnap` (expect *✔ Connected*)
or a `codex exec` that calls a PwrSnap tool, and check Settings → Local
Agents → Recent agent actions for the recorded call.

If you script it instead, three traps, each of which cost real time:

- `spawnSync` blocks the event loop the server lives on. The client's
  requests then sit in the kernel backlog, the client reports a 30 s
  connect timeout with nothing on the wire, and the queued requests EPIPE
  the instant the sync call returns. It looks exactly like a server bug.
  Use async `spawn`.
- `claude mcp login --no-browser` needs a TTY to accept the pasted
  redirect URL; macOS `script -q` cannot wrap a Node socketpair
  ("tcgetattr/ioctl: Operation not supported on socket"), Python's
  `pty.spawn` can.
- Under nvm, `claude` on PATH can resolve to an older npm-installed copy
  without `mcp login`. Spawn the absolute path of the native install.

Codex's `mcp login` has no non-browser mode; it opens the system browser,
which is fine — the page only waits for the native window.
