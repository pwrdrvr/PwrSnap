# Connect a local MCP agent to PwrSnap

PwrSnap must already be running with **Settings → Local agents → Enable
local-agent access** on. The MCP host launches the small bundled Rust
`pwrsnap-mcp` executable. It connects to the running desktop and forwards
stdio bytes in both directions. It never launches PwrSnap. Hosts that explicitly
support HTTP on Unix sockets or Windows named pipes can also connect directly
to that same protected IPC endpoint, without the stdio relay or a TCP port.

## Install and connect

Install PwrSnap normally. The relay ships inside the signed application:

| Platform | Bundled executable |
| --- | --- |
| macOS Apple Silicon and universal | `/Applications/PwrSnap.app/Contents/Resources/pwrsnap-mcp` |
| Windows x64 | `resources\pwrsnap-mcp.exe` inside the chosen PwrSnap installation |

Settings shows copyable commands containing the actual installation path.
An app move requires updating the host's command. No Node installation or
Electron-as-Node mode is required. Linux developers can build the relay with
`pnpm --filter @pwrsnap/desktop build:mcp`; PwrSnap does not distribute a Linux
installer. Build output is `apps/desktop/build/mcp/pwrsnap-mcp`.

For a standard macOS install:

```sh
claude mcp add --scope user --transport stdio pwrsnap -- '/Applications/PwrSnap.app/Contents/Resources/pwrsnap-mcp'
codex mcp add pwrsnap -- '/Applications/PwrSnap.app/Contents/Resources/pwrsnap-mcp'
```

For JSON-configured hosts such as Cursor, put the absolute relay path in
`command` and use an empty `args` array:

```json
{"mcpServers":{"pwrsnap":{"command":"/Applications/PwrSnap.app/Contents/Resources/pwrsnap-mcp","args":[]}}}
```

The relay is not prompted. PwrSnap grants the role named on the relay's command
line, or Full Access when none is named, and lists the connection as a Session
in Settings → Local Agents, named for the host's self-reported name. To give a
host less, add `--role` with a role id from Settings → Local Agents:

```sh
claude mcp add --scope user --transport stdio pwrsnap-preview -- '/Applications/PwrSnap.app/Contents/Resources/pwrsnap-mcp' --role builtin.preview
```

The built-in ids are `builtin.search`, `builtin.preview`, `builtin.full-media`,
`builtin.editor`, `builtin.sizzle` and `builtin.full-access`; the `builtin.`
prefix may be left off. A custom role uses its own id. An unknown id refuses
the connection rather than granting another role. If you do not trust a model
with a role's access, connect it with a lower role; a model you do not trust at
all belongs in a contained environment, not connected to this machine's
PwrSnap. Closing the host or relay ends and revokes that connection's Session.

Command stdio is the portable local path documented by
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code](https://code.claude.com/docs/en/mcp), and
[Cursor](https://cursor.com/docs/mcp).
[VS Code's socket/pipe URL configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
supports HTTP over those endpoints. Use the direct setup below or the stdio
relay. Native socket/pipe support is not universal: hosts need either command
stdio or explicit HTTP-over-IPC support. Network-only hosts cannot connect.

## Direct IPC HTTP in VS Code

1. In PwrSnap Settings → Local agents → **Direct IPC HTTP → VS Code**, click
   **Create HTTP Session** and approve a Session Name and role in the native
   consent window. The credential must initialize its Session within two minutes.
2. Copy the fresh VS Code configuration into `mcp.json`. It contains the actual
   socket/pipe URL and a new secret input reference, never a token. Copy the
   credential separately; it is available only in that Settings response.
3. Start the MCP server in VS Code and paste the credential into its password
   input. VS Code documents per-server `headers` and password `promptString`
   inputs. Do not store the literal token in shared configuration or a URL.
4. Keep PwrSnap and the host connected. To reconnect after disconnection,
   create a new HTTP Session and copy its fresh configuration. The new password
   input reference prompts for a fresh secret rather than reusing the cached
   value. Explicitly start/reconnect the server.

For a Unix account with effective UID 501, a complete example is:

```json
{
  "servers": {
    "pwrsnap": {
      "type": "http",
      "url": "unix:///tmp/pwrsnap-mcp-501/mcp.sock#/mcp",
      "headers": { "Authorization": "Bearer ${input:pwrsnap-http-token}" }
    }
  },
  "inputs": [{
    "type": "promptString", "id": "pwrsnap-http-token",
    "description": "PwrSnap HTTP Session credential", "password": true
  }]
}
```

Use Settings' actual URL instead of assuming UID 501. Windows uses
`pipe:///pipe/pwrsnap-mcp-<account-SID>#/mcp`. The fragment is the HTTP request
subpath, not part of the native endpoint name. This is Streamable HTTP at
`/mcp`, including a persistent GET SSE stream for server messages; the old
standalone SSE transport and WebSocket upgrade are not enabled.

The credential is random, retained only as an in-memory hash, and binds one
logical MCP Session to the native-consented scope ceiling. The bearer header
is required on **every** request; `Mcp-Session-Id` alone grants no authority.
Concurrent POST/GET requests may use several IPC connections within that
Session. Each physical connection retains its framing for its entire lifetime.
Closing its last authenticated IPC connection, interrupting a request/SSE
stream, revoking it in Settings, disabling access, or closing the desktop ends
the Session and invalidates the credential. Idle HTTP keep-alive connections
expire after five minutes; SSE keep-alives preserve a connected host. A new
initialize with a consumed credential fails. No SSE reconnect, Last-Event-ID
replay or event history is supported.

HTTP support does not establish OAuth support over IPC. PwrSnap does not
advertise browser authorization, resource-metadata discovery or token endpoints
on this path. Its supported bootstrap is the explicit desktop-native flow
above. Existing OAuth bearers are not reused or accepted. The VS Code transport
and header syntax is documented by VS Code; transport tests exercise it with
Node HTTP clients, rather than claiming an end-to-end OAuth or editor login
verification.

## Revoke, remove, and connect again

Revoking a Session ends its access immediately; its card stays marked revoked.
Removing a revoked Session deletes that saved entry while preserving audit
entries with its id. Active Sessions offer Revoke, and `localAgents:remove`
refuses active ids. Removal cannot end or restore access.

Each new connection creates a new Session and id; a name already in use gets a
number. Cards show the authorization time and the id's last four characters to
tell them apart. Direct HTTP needs fresh native consent and a fresh bootstrap
credential for each connection. Removing old entries never transfers an
approval or makes an old credential usable again.

Legacy OAuth registration metadata may remain in
`localAgents.retainedOAuthClients` after its last revoked entry is removed,
capped at 64 records. This preserves saved metadata only: OAuth endpoints and
legacy bearer authentication remain unavailable. Native Sessions create no
OAuth registration or persisted bearer credential.

## Migrate an existing HTTP/OAuth connection

1. Remove the host's old PwrSnap HTTP server entry and its cached OAuth login.
   For CLI hosts, use `claude mcp remove pwrsnap` or `codex mcp remove pwrsnap`.
2. Install the updated desktop, open it yourself, and enable Local agents.
3. Copy the new stdio command or direct IPC HTTP configuration from Settings,
   then manually reconnect the MCP server in the host. A relay gets the role on
   its command line; HTTP clients use the bootstrap described above.
4. Revoke obsolete HTTP Sessions in Settings when no longer needed.

The former loopback listener on port 51729, its OAuth authorization/token
routes and HTTP media delivery are removed. There is no MCP TCP/WebSocket
fallback. HTTP framing over protected IPC is supported explicitly. Existing
persisted credentials and roles are not deleted, reused or
upgraded into broader authority. No OAuth token or prior approval is accepted
by the new IPC path. Migration neither restarts active agent turns nor replays
requests. Changing a live Session's role may narrow access immediately;
widening requires fresh consent. The grant service enforces the initial
capability, history and budget ceilings even when the command bus resolves
current roles again.

## Disconnects, discovery and versions

If PwrSnap is missing, disabled, or disconnected, open it manually, enable
Local agents, and use the host's explicit reconnect command. The relay makes
one connection attempt, never retries a live session, and never replays an
operation. Closing or overflowing stdio tears down the native stream and the
desktop's SDK server resources. Idle revoked Sessions are reclaimed before
new-connection admission; cleanup and capacity checks are serialized.

`pwrsnap-mcp --version` reports the relay version and transport version.
The native greeting negotiates **transport 1**, independently of release
numbers. Compatible older/newer relay releases can connect; a different
transport version fails closed with an update/reconnect instruction. MCP
initialization reports the desktop's actual application version, capabilities
and instructions, including the connecting relay's version. The desktop is
authoritative for tools, schemas, descriptions, annotations, resources,
prompts and skills it supports. A relay update never adds tools by itself.
Byte/framing preservation does not make an extension part of that interface:
the desktop SDK still validates supported messages and advertised capabilities.

The full MCP stream supports notifications, server requests, responses,
cancellation, approval/elicitation metadata and extension fields. The byte
relay does not select fields. Supported tool/resource list-change notifications
ask the host to re-discover; they do not update host caches themselves.
HTTP retains at most the latest tool and resource catalog invalidations until
its first GET SSE stream opens. Hosts without SSE must explicitly re-discover.
No operations, results or approvals are queued for replay. Loaded
skills and initialization instructions require the host's supported refresh
or an explicit new connection. Prompts/skills not advertised by the desktop
are not supplied by the relay.

### Sizzle authoring skill

The desktop advertises `io.modelcontextprotocol/skills` using the official SDK's
[Skills extension (SEP-2640)](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills).
`skills/list` enumerates `skill://pwrsnap-sizzle-reels/SKILL.md`; `skills/get`
returns the same entry by URI, with complete frontmatter and every file's
SHA-256 digest and byte size. `resources/read` serves the exact bundled files,
including `references/timeline.md` and `agents/openai.yaml`. `resources/list`
also exposes them to ordinary resource readers. The manifest is static, not
`dynamic`; no directory-read capability is advertised. No checkout or
documentation network request is required. Tool-only
hosts can discover `pwrsnap_sizzle_skill`, omit `path` to read the skill, and
request `path: "references/timeline.md"` for examples and tool inputs.

Guidance reads require an approved live Session, including after revocation
or role changes. They require no capture/composition permissions and spend no
media-read budget. A generic resource/tool read does not activate a skill;
the host's skill loader verifies the entry and applies its own approval policy.
Instructions explain the operations; actual media and
render calls still enforce their existing grants and budgets. See
[Authoring Sizzle reels](sizzle-agent-reels.md).

Native stdio supports both the existing initialize handshake and revision
`2026-07-28` requests with per-request metadata and `server/discover`.
Modern `server/discover` exposes public server metadata without creating a
grant; the first protected request opens the connection's Session. Discovery-only
connections retain the admission timeout. The SDK handles era negotiation.
Direct IPC HTTP retains its initialize-based Session contract and advertises
the extension through that legacy handshake. Internal ACP endpoints retain
their separate initialize-only gate.

Media tools return canonical `pwrsnap://` MCP resource links. Use
`resources/read` to obtain bytes. Each read rechecks the live Session,
capabilities, capture-history horizon, usage budget and resource ownership.
No HTTP URL or arbitrary filesystem path is exposed for media delivery.

### Displaying resource links in a host

Keep the typed `resource_link` block from a completed media tool, including
when the host wraps that tool result in another envelope. Resolve its exact
URI with `resources/read` on the same live MCP connection that issued the
link. An export belongs to that connection's client; a separate connection
with the same role cannot read it. A host's generic resource browser or a
second MCP process is not a substitute for the issuing connection.

For images, `contents[]` contains the URI, MIME type and a `blob` holding
base64-encoded file bytes. Treat `blob` as opaque binary data throughout the
host's transport and serialization path. Text summarization, token clipping,
ellipsis insertion and pretty-printing must never alter it. A successful
JSON parse alone does not establish byte fidelity: validate base64 strictly,
then compare decoded length with the link's `size` and decode the image.
Node's permissive base64 decoder can silently ignore invalid characters.

The host can fetch once, retain bytes in its authorized session-owned media
cache and display the image inline through its protected renderer media
path. Display does not require printing base64 into model context or adding
the same image as another model input. Reuse still needs the host's session
ownership and revocation checks; a resource URI never grants filesystem
access. Surface resource-read errors rather than rendering partial bytes or
reconnecting with a broader grant. There is no need for a separate HTTP media
route merely to display an MCP binary resource.

The capture media byte oracles in `local-agents/__tests__/mcp-server.test.ts`
exercise the real resource links, production handlers and native relay with
synthetic PNG/JPEG files, including a PNG response larger than 1 MiB. They
compare canonical base64, byte lengths, SHA-256 and decoded pixels over stdio
and direct IPC HTTP, and check missing files, unknown URIs, cross-client
export reads, narrowed capabilities and revocation. The same tests select a
Unix socket on macOS/Linux and a named pipe on Windows; a local run only
verifies its host platform. No operator capture or desktop launch is needed.

## Transport and permission boundaries

Electron launches a native listener transport child and retains all MCP
handlers in main. The external host's relay connects to that listener over a
Unix socket on macOS/Linux or a Windows named pipe. The child reports opaque
connection bytes over its desktop-owned stdin/stdout; it has no registry,
filesystem tool or privileged application handler. Losing the desktop/control
pipes closes all accepted streams.

For the external endpoint only, the listener classifies one initial line in
three seconds: a versioned `PWRSNAP-MCP/1` preamble of less than 128 bytes or a
recognized HTTP/1.0 or HTTP/1.1 request line of at most 4096 bytes. Malformed,
ambiguous, incomplete, oversized or unsupported prefixes close the connection.
Every prefetched HTTP byte reaches Electron's HTTP parser unchanged. The
parser consumes the bridged stream without calling `listen()`. Both modes
use the same desktop MCP factory, tools, resources and per-call checks.

On Unix, the default endpoint is `/tmp/pwrsnap-mcp-<effective-uid>/mcp.sock`.
Its directory must be owned by the account, nonsymlinked and private (0700);
the socket is 0600. Both peers check the effective UID. A retained ownership
lock serializes binding and stale cleanup. Only an owned socket that refuses
connections can be removed, and cleanup checks its inode before unlinking.
A live listener, regular file, symlink, or endpoint owned by another account
is never removed. `--endpoint PATH` is available for isolated development and
internal per-run chat endpoints; it retains these checks.

On Windows, the stable pipe name uses the account SID. An explicit protected
DACL sets that SID as owner and sole allowed identity, remote clients are
rejected, and first-instance protection refuses an occupied name. Clients
verify the connected server handle's owner before sending any protocol data.
Overlapped I/O is cancelled on teardown, including stalled writers. These
protections deliberately avoid the broader
[default pipe ACL](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights);
[CreateNamedPipeW](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)
documents the first-instance and remote-client controls.

The Rust relay performs both client-side peer checks and the protected desktop
listener's server-side checks. Direct IPC HTTP hosts implement their own native
client connection; do not assume they perform the relay's server-owner/peer-UID
verification. They still reach the protected listener, need the one-Session
bearer credential and cannot obtain authority from account identity or HTTP.

macOS privacy permissions remain associated with the independently launched
desktop and the actual code performing operations. Do not describe TCC as
universal permission inheritance: Apple's
[responsible-code guidance](https://developer.apple.com/forums/topics/app-and-system-services/app-and-system-services-core-os?sortBy=oldest&sortOrder=DESC)
describes heuristic attribution that can break. The relay requests no screen,
Accessibility or capture-files permissions and does not impersonate the host.
OS account checks and native consent are distinct boundaries.

## Internal AI adapter inventory

The internal ACP chat adapter uses the same raw byte transport on a separate,
random endpoint. A fresh app-minted token selects one chat registration's
catalog and dispatcher. It never authenticates an external Session. Catalog
flattening and MCP conversion live in Electron main; every `tools/list` reads
the current registration, and an explicit catalog update emits list-change.
Unregister closes its streams. Tokens are per run, are not restored on restart,
and never appear in connection commands, logs or renderer settings. HTTP
classification is disabled on those internal endpoints.

The former Electron-as-Node MCP entry and snapshot-fetching callback client
are removed. No MCP listener uses TCP or WebSockets. Direct API OAuth callback
HTTP and optional development services belong to other app features and do
not serve MCP.

## Build and release checks

`pnpm build` builds the host relay before Electron. `build:native` and the
macOS release stage build both Darwin architectures and combine them with
`lipo`; ARM64 stages thin the isolated copy. The relay ships as an actual
resource executable and follows the existing Developer ID/notarization or
Windows Authenticode signing path. Release verification requires its presence,
architecture and signature. Production signing is performed by guarded release
CI, not by ordinary development builds.

`pnpm test:mcp` runs native endpoint/compatibility tests; CI runs them on
macOS, Windows and Linux. The normal unit suite exercises real stdio/native
connections plus consent, revocation, per-run identity and lifecycle boundaries.
`pnpm licenses:check` includes a lock-aligned Rust runtime license snapshot;
native builds verify it against Cargo's selected normal/build graphs for all
supported targets. After a dependency change, run
`node scripts/check-mcp-rust-licenses.mjs --write`, review the allowed licenses,
and regenerate the main notice with `pnpm licenses:generate`.
