import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  InitializeRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NativeIpcStream } from "../ai/mcp/native-mcp-bridge";

/** Desktop-owned Streamable HTTP framing, attached to the same SDK server as
 * stdio. The SDK's HTTP adapter rejects envelope extension fields; this adapter
 * preserves them and leaves method/schema validation to that shared server.
 * No event store, resumption, tool registry or request/result rewriting. */
export class IpcHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (...args: Parameters<NonNullable<Transport["onmessage"]>>) => void;
  sessionId?: string;
  readonly controller = new AbortController();
  readonly sockets = new Set<NativeIpcStream>();
  private readonly posts = new Map<RequestId, ServerResponse>();
  private sse: ServerResponse | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly pendingCatalogChanges = new Map<string, string>();

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    if (this.controller.signal.aborted)
      throw new Error("HTTP Session closed; bootstrap and reconnect manually");
    if (options?.resumptionToken !== undefined)
      throw new Error("HTTP event resumption is disabled");
    const responseId = !("method" in message) && "id" in message ? message.id : undefined;
    const target =
      responseId !== undefined
        ? this.posts.get(responseId)
        : options?.relatedRequestId === undefined
          ? this.sse
          : this.posts.get(options.relatedRequestId);
    const bytes = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) {
      await this.close();
      throw new Error("MCP HTTP output overflow");
    }
    if (!target || target.destroyed) {
      if (options?.relatedRequestId === undefined && !("id" in message) && "method" in message &&
        ["notifications/tools/list_changed", "notifications/resources/list_changed"].includes(message.method)) {
        // Keep at most the latest two catalog invalidations until the first
        // SSE stream. No requests, results, approvals or event history replay.
        this.pendingCatalogChanges.set(message.method, bytes);
        return;
      }
      throw new Error("No live HTTP response stream; rediscover or reconnect manually");
    }
    try {
      await new Promise<void>((resolve, reject) =>
        target.write(bytes, (error) => (error ? reject(error) : resolve()))
      );
      if (responseId !== undefined) {
        this.posts.delete(responseId);
        target.end();
      }
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    if (this.controller.signal.aborted) {
      this.reject(res, 410, "Session closed; reconnect manually");
      return;
    }
    const version = req.headers["mcp-protocol-version"] ?? "2025-03-26";
    if (typeof version !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      this.reject(res, 400, "Unsupported MCP protocol version");
      return;
    }
    if (req.method === "DELETE") {
      // Revoke immediately but let this terminal response drain. Every other
      // stream is closed. A peer that will not read/close is reclaimed in 2s.
      const socket = req.socket as unknown as NativeIpcStream;
      this.sockets.delete(socket);
      const timer = setTimeout(() => socket.destroy(), 2000);
      timer.unref();
      socket.once("close", () => clearTimeout(timer));
      res.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
        "mcp-session-id": this.sessionId!
      });
      res.end("{}");
      void this.close();
      return;
    }
    const accept = req.headers.accept ?? "";
    if (req.method === "GET") {
      if (!accept.includes("text/event-stream") || this.sse !== undefined) {
        this.reject(res, 406, "A single live SSE stream is required");
        return;
      }
      this.sse = res;
      this.headers(res);
      const pending = [...this.pendingCatalogChanges.values()];
      this.pendingCatalogChanges.clear();
      for (const bytes of pending) {
        await new Promise<void>((resolve, reject) =>
          res.write(bytes, (error) => error ? reject(error) : resolve()));
      }
      this.heartbeat = setInterval(() => {
        if (res.destroyed || res.writableLength > 4 * 1024 * 1024) {
          void this.close();
          return;
        }
        res.write(": keepalive\n\n", (error) => {
          if (error) void this.close();
        });
      }, 15_000);
      this.heartbeat.unref();
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "GET, POST, DELETE");
      this.reject(res, 405, "Use Streamable HTTP at /mcp");
      return;
    }
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      this.reject(res, 406, "Accept application/json and text/event-stream");
      return;
    }
    if (
      !req.headers["content-type"]
        ?.split(";")[0]
        ?.trim()
        .match(/^application\/json$/i)
    ) {
      this.reject(res, 415, "Use application/json");
      return;
    }
    // Validate the envelope without stripping or rejecting extension fields.
    // Registered MCP handlers in the SDK still validate each method's schema.
    if (!rpcMessage(body)) {
      this.reject(res, 400, "Invalid MCP message");
      return;
    }
    if ("method" in body && "id" in body) {
      if (this.posts.has(body.id)) {
        this.reject(res, 409, "Request id already active");
        return;
      }
      if (this.posts.size >= 128) {
        this.reject(res, 429, "Too many active HTTP requests");
        return;
      }
      this.sessionId ??= randomUUID();
      this.posts.set(body.id, res);
      this.headers(res);
    } else {
      res.writeHead(202, { "mcp-session-id": this.sessionId! });
      res.end();
    }
    this.onmessage?.(body, { requestInfo: { headers: req.headers } });
  }

  private headers(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "mcp-session-id": this.sessionId!
    });
    res.flushHeaders();
  }
  private reject(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
  }
  async close(): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.pendingCatalogChanges.clear();
    clearInterval(this.heartbeat);
    for (const response of this.posts.values()) response.destroy();
    this.posts.clear();
    this.sse?.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.onclose?.();
  }
}
function rpcMessage(value: unknown): value is JSONRPCMessage {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("jsonrpc" in value) ||
    value.jsonrpc !== "2.0"
  )
    return false;
  const id = "id" in value;
  if (
    id &&
    !(
      typeof value.id === "string" ||
      (typeof value.id === "number" && Number.isSafeInteger(value.id))
    )
  )
    return false;
  if ("method" in value)
    return typeof value.method === "string" && !("result" in value) && !("error" in value);
  if (!id || "result" in value === "error" in value) return false;
  return (
    !("error" in value) ||
    (typeof value.error === "object" &&
      value.error !== null &&
      "code" in value.error &&
      typeof value.error.code === "number" &&
      "message" in value.error &&
      typeof value.error.message === "string")
  );
}

type Ticket = {
  transport: IpcHttpTransport;
  used: boolean;
  sseOpened: boolean;
  expires: ReturnType<typeof setTimeout>;
};
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Electron-owned HTTP parser over the existing protected native byte bridge.
 * This server is deliberately never listened on: no TCP or second IPC bind. */
export class IpcHttpMcp {
  private readonly tickets = new Map<string, Ticket>();
  private readonly transports = new Set<IpcHttpTransport>();
  private readonly sockets = new Set<NativeIpcStream>();
  private readonly bound = new WeakMap<NativeIpcStream, Ticket>();
  private closed = false;
  private readonly http = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void this.request(req, res).catch(() => {
      this.reply(res, 400, "Invalid local MCP HTTP request; bootstrap and reconnect manually.");
    });
  });
  constructor(
    private readonly prepare: (
      transport: IpcHttpTransport,
      initialize: JSONRPCMessage
    ) => Promise<void>
  ) {
    this.http.maxHeadersCount = 64;
    this.http.keepAliveTimeout = 5 * 60_000;
    this.http.on("clientError", (_error, socket) => socket.destroy());
    this.http.on("upgrade", (_req, socket) => socket.destroy());
    this.http.on("connect", (_req, socket) => socket.destroy());
    this.http.on("checkContinue", (_req, res) => this.reply(res, 417, "Expect is unsupported"));
  }
  accept(socket: NativeIpcStream): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    // Absolute initial-header deadline, independent of byte trickling.
    const timer = setTimeout(() => socket.destroy(), 10_000);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      this.sockets.delete(socket);
    });
    socket.once("ipc-http-request", () => clearTimeout(timer));
    socket.setTimeout(30_000, () => socket.destroy());
    this.http.emit("connection", socket);
  }
  /** Called only by the desktop UI, which still must complete native consent.
   * The secret is returned once, held only as a hash here, and consumed by one
   * initialize. Never exported in settings, list projections, logs or URLs. */
  async bootstrap(signal: AbortSignal): Promise<{ token: string; expiresAt: string }> {
    if (this.closed || signal.aborted)
      throw new Error("Local MCP is disconnected; enable it and reconnect manually");
    const transport = new IpcHttpTransport();
    this.transports.add(transport);
    const abort = (): void => {
      void transport.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    const token = randomBytes(32).toString("base64url");
    const key = digest(token);
    let ticket: Ticket | undefined;
    transport.controller.signal.addEventListener(
      "abort",
      () => {
        this.transports.delete(transport);
        this.tickets.delete(key);
        if (ticket) clearTimeout(ticket.expires);
        signal.removeEventListener("abort", abort);
      },
      { once: true }
    );
    try {
      await this.prepare(transport, {
        jsonrpc: "2.0",
        id: "native-bootstrap",
        method: "initialize",
        params: { clientInfo: { name: "Direct IPC HTTP client", version: "native bootstrap" } }
      });
      if (this.closed || signal.aborted || transport.controller.signal.aborted)
        throw new Error("Bootstrap disconnected; approve a new Session");
      const expires = setTimeout(() => {
        void transport.close();
      }, 120_000);
      expires.unref();
      ticket = { transport, used: false, sseOpened: false, expires };
      this.tickets.set(key, ticket);
      return { token, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    } catch (cause) {
      await transport.close();
      throw cause;
    }
  }
  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const socket = req.socket as unknown as NativeIpcStream;
    socket.emit("ipc-http-request");
    if (
      this.closed ||
      req.url !== "/mcp" ||
      req.headers.origin !== undefined ||
      req.headers["last-event-id"] !== undefined
    ) {
      this.reply(res, 400, "Use /mcp with no Origin or event replay; reconnect manually");
      return;
    }
    const auth = req.headers.authorization;
    const ticket =
      typeof auth === "string" && /^Bearer [A-Za-z0-9_-]{43}$/.test(auth)
        ? this.tickets.get(digest(auth.slice(7)))
        : undefined;
    if (!ticket || ticket.transport.controller.signal.aborted) {
      // No OAuth discovery challenge: unix/pipe OAuth browser redirects have
      // not been established as supported. Bootstrap in PwrSnap Settings.
      this.reply(
        res,
        401,
        "Create a direct IPC HTTP Session in PwrSnap Settings and supply its bearer header"
      );
      return;
    }
    if (this.bound.has(socket) && this.bound.get(socket) !== ticket) {
      this.reply(res, 403, "This IPC connection belongs to another Session");
      return;
    }
    const transport = ticket.transport;
    const sessionId = req.headers["mcp-session-id"];
    if (ticket.used && (typeof sessionId !== "string" || sessionId !== transport.sessionId)) {
      this.reply(res, 404, "Session unavailable; bootstrap a new Session and reconnect manually");
      return;
    }
    if (!ticket.used && (req.method !== "POST" || sessionId !== undefined)) {
      this.reply(res, 400, "Initialize the new Session with POST /mcp");
      return;
    }
    const body = req.method === "POST" ? await this.readBody(req) : undefined;
    // Recheck after asynchronous body reads: another connection may have used
    // the ticket, or the desktop may have revoked it while this body arrived.
    if (transport.controller.signal.aborted) {
      this.reply(res, 410, "Session revoked");
      return;
    }
    // Node may emit several pipelined requests before any body read settles.
    // Another request can bind this socket during the await above. Recheck
    // before consuming a credential or dispatching on the approved transport.
    if (this.bound.has(socket) && this.bound.get(socket) !== ticket) {
      this.reply(res, 403, "This IPC connection belongs to another Session");
      return;
    }
    if (!ticket.used) {
      if (!InitializeRequestSchema.safeParse(body).success) {
        this.reply(res, 400, "Initialize MCP first");
        return;
      }
      ticket.used = true; // Synchronous consume, before calling any SDK code.
      clearTimeout(ticket.expires);
    } else if (typeof sessionId !== "string" || sessionId !== transport.sessionId) {
      this.reply(res, 409, "Credential already used; approve a new Session");
      return;
    } else if (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "initialize"
    ) {
      this.reply(res, 409, "This Session is already initialized; active Sessions cannot restart");
      return;
    }
    if (req.method === "GET") {
      if (ticket.sseOpened) {
        this.reply(res, 409, "SSE resumption is disabled; reconnect manually");
        return;
      }
      ticket.sseOpened = true;
    }
    if (!this.bound.has(socket)) {
      this.bound.set(socket, ticket);
      transport.sockets.add(socket);
      socket.once("close", () => {
        transport.sockets.delete(socket);
        if (transport.sockets.size === 0) void transport.close();
      });
    }
    socket.setTimeout(5 * 60_000);
    // An interrupted request or SSE stream ends the Session. Finished HTTP
    // messages may share a persistent connection; no operation is replayed.
    res.once("close", () => {
      if (!res.writableFinished) void transport.close();
    });
    await transport.handleRequest(req, res, body);
    if (transport.sessionId === undefined) await transport.close();
  }
  private async readBody(req: IncomingMessage): Promise<unknown> {
    const timer = setTimeout(() => req.destroy(new Error("MCP HTTP body timed out")), 30_000);
    timer.unref();
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += (chunk as Buffer).length;
        if (length > 1024 * 1024) throw new Error("MCP HTTP body exceeds 1 MiB");
        chunks.push(chunk as Buffer);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
  private reply(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent || res.destroyed) {
      res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    res.end(message);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([...this.transports].map((transport) => transport.close()));
  }
}
