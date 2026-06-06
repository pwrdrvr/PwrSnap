// PwrSnap tool RPC server — the callback channel for the ACP chat MCP bridge.
//
// ACP agents (Gemini/Qwen) can only reach host tools over MCP, and ACP spawns
// the MCP server as ITS OWN child process (`AcpMcpServerConfig` is stdio:
// `{ name, command, args, env }`). That spawned MCP server is therefore a
// separate process from PwrSnap main and must call BACK into main to actually
// run a tool. This is that callback channel.
//
//   Gemini ──spawns──> pwrsnap-mcp-server (stdio MCP)
//                          └─ this UDS, token-auth ──> dispatchToolCall
//                                                        └─ command-bus (mcp)
//
// Transport: a Unix domain socket under userData (no TCP port, no network
// surface, filesystem-permission scoped to the user). Framing: newline-
// delimited JSON. Auth: a random per-app-run token, minted per chat surface at
// `register()` and presented on every request. A surface's token maps to its
// own tool catalog + dispatch, so the Library and Sizzle chat surfaces stay
// isolated. Tools self-enforce `principal: "mcp"` at the bus, so this server
// never widens the agent's reach beyond the registered allowlist — exactly the
// same exposure the Codex backend already has.

import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { getMainLogger } from "../../log";

const log = getMainLogger("pwrsnap:mcp-rpc");

/** Max accepted request line — a tool-call payload, never large. Guards against
 *  a misbehaving / hostile child streaming unbounded data. */
const MAX_LINE_BYTES = 256 * 1024;

/** Drop a connection that sits idle without completing a request. Bounds a
 *  child that connects and never sends a newline. */
const IDLE_SOCKET_TIMEOUT_MS = 30_000;

/** Cap concurrent connections so a misbehaving child can't open unbounded
 *  sockets. One bridge child makes one short-lived connection per call. */
const MAX_CONNECTIONS = 32;

/** What a chat surface registers: how to list + run its tools. */
export type ToolRpcSurface = {
  /** The surface's tool catalog (Codex `DynamicToolSpec[]`). */
  catalog: DynamicToolSpec[];
  /** Run one tool call. MUST resolve (never throw) — mirrors the Codex path. */
  dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Human label for logs — which surface + agent this token belongs to (e.g.
   *  "library-chat/grok"). The MCP `tools/call` carries no ACP thread/agent id
   *  (separate channels), so this is how we attribute a call to its agent. */
  label?: string;
};

/** Handle returned to a registrant: the env a spawned MCP server needs to reach
 *  this surface, plus an `unregister` to drop the token on teardown. */
export type ToolRpcRegistration = {
  socketPath: string;
  token: string;
  unregister: () => void;
};

/** Wire request shapes (newline-delimited JSON). */
type RpcRequest =
  | { token: string; op: "list" }
  | { token: string; op: "call"; call: DynamicToolCallParams };

type RpcResponse =
  | { ok: true; op: "list"; tools: DynamicToolSpec[] }
  | { ok: true; op: "call"; response: DynamicToolCallResponse }
  | { ok: false; error: string };

export class PwrSnapToolRpcServer {
  private server: Server | undefined;
  private socketPath: string | undefined;
  private readonly surfaces = new Map<string, ToolRpcSurface>();

  /** Start listening on a UDS under `socketDir`. Idempotent. */
  async start(socketDir: string): Promise<void> {
    if (this.server !== undefined) return;
    // Create the dir 0700 up front (mode in mkdir avoids the umask window
    // between create and chmod) and re-assert + LOG on failure rather than
    // silently leaving it world-traversable. The real authn is the token; this
    // is defense-in-depth on top of the already user-scoped userData parent.
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(socketDir, 0o700);
    } catch (cause) {
      log.warn("could not chmod 0700 the MCP socket dir", {
        socketDir,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    // Short, unique socket name. macOS caps UDS paths at ~104 bytes, so keep it
    // tight and rely on the (already user-scoped) directory for isolation.
    const socketPath = join(socketDir, `t${randomBytes(6).toString("hex")}.sock`);
    rmSync(socketPath, { force: true });

    const server = createServer((socket) => this.onConnection(socket));
    server.maxConnections = MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(socketPath, 0o600);
    } catch {
      // best-effort
    }
    this.server = server;
    this.socketPath = socketPath;
    log.info("tool RPC server listening", { socketPath });
  }

  /** Register a surface's tools, minting a token. Throws if not started. */
  register(surface: ToolRpcSurface): ToolRpcRegistration {
    if (this.socketPath === undefined) {
      throw new Error("PwrSnapToolRpcServer.register before start()");
    }
    const token = randomBytes(24).toString("hex");
    this.surfaces.set(token, surface);
    const socketPath = this.socketPath;
    return {
      socketPath,
      token,
      unregister: () => {
        this.surfaces.delete(token);
      }
    };
  }

  async stop(): Promise<void> {
    this.surfaces.clear();
    const server = this.server;
    const socketPath = this.socketPath;
    this.server = undefined;
    this.socketPath = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
  }

  private onConnection(socket: Socket): void {
    socket.setEncoding("utf8");
    socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        // `end()` (not `destroy()`) so the rejection actually flushes before
        // the socket closes.
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.handleLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      this.respond(socket, { ok: false, error: "malformed request" });
      return;
    }
    const surface = this.authorize(request.token);
    if (surface === undefined) {
      this.respond(socket, { ok: false, error: "unauthorized" });
      return;
    }
    if (request.op === "list") {
      this.respond(socket, { ok: true, op: "list", tools: surface.catalog });
      return;
    }
    if (request.op === "call") {
      // Log EVERY MCP tool call reaching us (this UDS is the single entry point
      // for both ACP chat surfaces' tools). Without this, an agent's tool calls
      // are invisible on the main side unless the specific handler happens to
      // log — so a turn that made a dozen calls left almost no trace. The result
      // line carries success + duration so a denied/failing tool is obvious.
      const call = request.call;
      const startedAt = Date.now();
      // `agent` attributes the call to its surface+backend (e.g. "library-chat/
      // grok"). The MCP `tools/call` carries no ACP thread/agent id — separate
      // channels — so the token's registered label is the only attribution we
      // have; that's also why `threadId` here is always empty.
      const agent = surface.label;
      log.info("mcp tool call", {
        agent,
        tool: call.tool,
        namespace: call.namespace,
        args: summarizeArgs(call.arguments)
      });
      // dispatchToolCall is contractually non-throwing, but guard anyway so a
      // bug can't crash the connection (which would wedge the agent's turn).
      try {
        const response = await surface.dispatchToolCall(call);
        log.info("mcp tool call done", {
          agent,
          tool: call.tool,
          success: response.success === true,
          ms: Math.round(Date.now() - startedAt)
        });
        this.respond(socket, { ok: true, op: "call", response });
      } catch (cause) {
        log.error("mcp tool call threw", {
          agent,
          tool: call.tool,
          ms: Math.round(Date.now() - startedAt),
          message: cause instanceof Error ? cause.message : String(cause)
        });
        this.respond(socket, {
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      }
      return;
    }
    this.respond(socket, { ok: false, error: "unknown op" });
  }

  /** Constant-time token check against the registered surfaces. */
  private authorize(token: unknown): ToolRpcSurface | undefined {
    if (typeof token !== "string" || token.length === 0) return undefined;
    // Map lookup is fine here: tokens are 24 random bytes, so a timing oracle on
    // key presence reveals nothing exploitable (no secret is derived from it).
    return this.surfaces.get(token);
  }

  private respond(socket: Socket, response: RpcResponse): void {
    if (socket.destroyed) return;
    socket.write(JSON.stringify(response) + "\n");
  }
}

/** Compact, bounded one-line view of a tool call's arguments for the log.
 *  Truncates so a big payload (e.g. a long text label) can't flood the log,
 *  and never throws on a non-serializable value. */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return "<unserializable>";
  }
  if (text === undefined) return "";
  const MAX = 300;
  return text.length > MAX ? `${text.slice(0, MAX)}…(+${text.length - MAX})` : text;
}

/** App-singleton accessor. */
let singleton: PwrSnapToolRpcServer | undefined;
export function getToolRpcServer(): PwrSnapToolRpcServer {
  if (singleton === undefined) singleton = new PwrSnapToolRpcServer();
  return singleton;
}
