import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Duplex } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpExecutablePath } from "./mcp-executable";

const MAX_MESSAGE = 1024 * 1024;
const MAX_PENDING = 4 * MAX_MESSAGE;
/** Existing synchronous sinks may return a write count; asynchronous sinks
 * return a promise. Both transports await completion before accepting more. */
type ByteWriter = (bytes: Buffer) => unknown;
export const MANUAL_RECONNECT =
  "Open PwrSnap yourself, enable Local agents in Settings, then manually reconnect this MCP server in your host. Requests are never replayed.";

export type McpConnection = {
  id: number;
  relayVersion: string;
  identity: string | null;
  /** The role the relay's command line asked for (`--role`), if any. */
  role: string | null;
  framing: "raw" | "http";
  createTransport: (prepare?: (message: JSONRPCMessage) => Promise<void>, options?: { allowModernRequests?: boolean }) => McpByteTransport;
  createStream: () => NativeIpcStream;
};

type Frame = {
  type: "ready" | "open" | "data" | "written" | "close";
  id: number;
  data?: string;
  relay_version?: string;
  identity?: string | null;
  role?: string | null;
  framing?: "raw" | "http";
  endpoint?: string;
};

/** A bounded byte stream for Electron's HTTP parser. This object never binds a
 * socket; the protected native listener owns the only OS endpoint. */
export class NativeIpcStream extends Duplex {
  readonly remoteAddress = "local-ipc";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs = 0;
  constructor(private readonly writeBytes: ByteWriter, private readonly disconnect: () => void) {
    super({ highWaterMark: 64 * 1024 });
    this.on("error", () => undefined);
  }
  override _read(): void {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.touch();
    void Promise.resolve().then(() => this.writeBytes(bytes)).then(
      () => done(),
      (cause: unknown) => done(cause instanceof Error ? cause : new Error("IPC output closed"))
    );
  }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    clearTimeout(this.timer);
    this.disconnect();
    done(error);
  }
  receive(bytes: Buffer): void {
    if (this.destroyed) return;
    if (this.readableLength + bytes.length > MAX_PENDING) {
      this.destroy(new Error("HTTP IPC input overflow"));
      return;
    }
    this.touch();
    this.push(bytes);
  }
  async close(): Promise<void> { this.destroy(); }
  setTimeout(ms: number, callback?: () => void): this {
    this.timeoutMs = ms;
    if (callback) this.once("timeout", callback);
    this.touch();
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  private touch(): void {
    clearTimeout(this.timer);
    if (this.timeoutMs > 0) {
      this.timer = setTimeout(() => this.emit("timeout"), this.timeoutMs);
      this.timer.unref();
    }
  }
}

/** SDK transport owned by Electron. Decodes MCP framing without selecting or
 * rewriting message fields. Both requests and responses flow through it. */
export class McpByteTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly controller = new AbortController();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private pending: { message: JSONRPCMessage; bytes: number }[] = [];
  private pendingBytes = 0;
  private started = false;
  private ready = false;
  private preparing = false;
  private closed = false;
  constructor(
    private readonly writeBytes: ByteWriter,
    private readonly disconnect: () => void,
    private readonly beforeInitialize?: (message: JSONRPCMessage) => Promise<void>,
    private readonly allowModernRequests = false
  ) {}
  async start(): Promise<void> {
    this.started = true;
    this.drain();
  }
  receive(bytes: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      // A control-pipe chunk can coalesce several complete MCP frames. Limit
      // each frame, rather than making admission depend on OS read boundaries.
      if (Buffer.byteLength(line) > MAX_MESSAGE)
        return this.fail(new Error("MCP message exceeds 1 MiB"));
      if (line.trim() === "") continue;
      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0")
          throw new Error("invalid MCP message");
        this.pendingBytes += Buffer.byteLength(line);
        if (this.pendingBytes > MAX_PENDING || this.pending.length >= 128)
          throw new Error("MCP input overflow");
        this.pending.push({ message, bytes: Buffer.byteLength(line) });
        this.drain();
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error("invalid MCP message"));
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE)
      this.fail(new Error("MCP message exceeds 1 MiB"));
  }
  private drain(): void {
    if (!this.started || this.closed || this.preparing || this.pending.length === 0) return;
    if (!this.ready || this.allowModernRequests) {
      const first = this.pending[0].message;
      // External desktop servers can opt into per-request-versioned MCP.
      // The desktop SDK validates that revision and its complete metadata;
      // the desktop's admission callback runs before each delivered message.
      // Internal endpoints retain their initialize-only gate by default.
      const modern = this.allowModernRequests && "method" in first && "id" in first &&
        typeof first.params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "string";
      if (!this.ready && (!("method" in first) || (first.method !== "initialize" && !modern)))
        return this.fail(new Error("Initialize MCP before using PwrSnap"));
      this.preparing = true;
      void Promise.resolve()
        .then(() => this.beforeInitialize?.(first))
        .then(() => {
          this.preparing = false;
          this.ready = true;
          if (this.allowModernRequests) {
            if (this.closed) return;
            const next = this.pending.shift()!;
            this.pendingBytes -= next.bytes;
            this.onmessage?.(next.message);
          }
          this.drain();
        })
        .catch((cause: unknown) =>
          this.fail(cause instanceof Error ? cause : new Error("MCP consent failed"))
        );
      return;
    }
    const messages = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const { message } of messages) {
      if (this.closed) break;
      this.onmessage?.(message);
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error(MANUAL_RECONNECT);
    const bytes = Buffer.from(JSON.stringify(message) + "\n");
    if (bytes.length > 32 * MAX_MESSAGE) {
      this.fail(new Error("MCP output overflow"));
      throw new Error("MCP output overflow");
    }
    try {
      await this.writeBytes(bytes);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause : new Error("MCP output closed"));
      throw cause;
    }
  }
  fail(error: Error): void {
    this.onerror?.(error);
    void this.close();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.pending = [];
    this.buffer = "";
    this.disconnect();
    this.onclose?.();
  }
}

/** Electron launches a native listener, not an independently functioning MCP
 * server. Losing either control pipe tears down all accepted IPC streams. */
export class NativeMcpBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopped: Promise<void> = Promise.resolve();
  private endpoint: string | undefined;
  private readonly connections = new Map<number, McpByteTransport | NativeIpcStream>();
  private controlWrites: Promise<void> = Promise.resolve();
  private readonly outputQueues = new Map<number, Promise<void>>();
  private queuedBytes = 0;
  private readonly acknowledgements = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  onclose?: () => void;
  constructor(
    private readonly options: {
      endpoint?: string;
      executable?: string;
      allowHttp?: boolean;
      onConnection: (input: McpConnection) => void;
    }
  ) {}
  async start(): Promise<void> {
    if (this.child !== undefined) return;
    const child = spawn(
      this.options.executable ?? mcpExecutablePath(),
      [
        "--desktop-listen",
        ...(this.options.allowHttp ? ["--allow-http"] : []),
        ...(this.options.endpoint === undefined ? [] : ["--endpoint", this.options.endpoint])
      ],
      { stdio: "pipe", windowsHide: true }
    );
    this.child = child;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("MCP listener startup timed out"));
        void this.stop();
      }, 10_000);
      const closed = (): void => {
        clearTimeout(timer);
        reject(new Error(`MCP listener disconnected. ${MANUAL_RECONNECT}`));
        this.shutdown();
      };
      child.once("error", (error) => {
        reject(error);
        closed();
      });
      child.once("exit", closed);
      child.stdin.on("error", closed);
      // Never copy protocol data or peer identity secrets into logs.
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (buffer.length > 128 * 1024) {
          closed();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line) as Frame;
            if (frame.type === "ready") {
              this.endpoint = frame.endpoint;
              clearTimeout(timer);
              resolve();
            } else this.receive(frame);
          } catch {
            closed();
            return;
          }
        }
      });
    });
  }
  private receive(frame: Frame): void {
    if (frame.type === "written") {
      this.acknowledgements.get(frame.id)?.resolve();
      return;
    }
    if (frame.type === "close") {
      void this.connections.get(frame.id)?.close();
      return;
    }
    if (frame.type === "data") {
      if (typeof frame.data !== "string") throw new Error("invalid native transport data");
      this.connections.get(frame.id)?.receive(Buffer.from(frame.data, "base64"));
      return;
    }
    if (
      frame.type !== "open" ||
      !Number.isSafeInteger(frame.id) ||
      typeof frame.relay_version !== "string"
    )
      throw new Error("invalid native transport event");
    this.options.onConnection({
      id: frame.id,
      relayVersion: frame.relay_version,
      identity: frame.identity ?? null,
      role: typeof frame.role === "string" ? frame.role : null,
      framing: frame.framing ?? "raw",
      createStream: () => {
        if (frame.framing !== "http" || !this.options.allowHttp) throw new Error("HTTP IPC disabled");
        if (this.connections.has(frame.id)) throw new Error("duplicate connection");
        const stream = new NativeIpcStream((bytes) => this.sendBytes(frame.id, bytes), () => this.disconnect(frame.id));
        this.connections.set(frame.id, stream);
        return stream;
      },
      createTransport: (prepare, options) => {
        if (frame.framing === "http") throw new Error("HTTP bytes require the desktop HTTP parser");
        if (this.connections.has(frame.id)) throw new Error("duplicate connection");
        const transport = new McpByteTransport(
          (bytes) => this.sendBytes(frame.id, bytes),
          () => this.disconnect(frame.id),
          prepare,
          options?.allowModernRequests ?? false
        );
        this.connections.set(frame.id, transport);
        return transport;
      }
    });
  }
  private sendBytes(id: number, bytes: Buffer): Promise<void> {
    // Bound queued logical responses separately from the tiny control frames.
    // Overflow rejects this connection's send, never the shared listener.
    if (this.queuedBytes + bytes.length > 64 * MAX_MESSAGE)
      return Promise.reject(new Error("MCP pending output overflow"));
    const child = this.child;
    this.queuedBytes += bytes.length;
    const previous = this.outputQueues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        if (!child || child !== this.child || !this.connections.has(id)) throw new Error(MANUAL_RECONNECT);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const acknowledged = new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MCP peer output stalled; reconnect manually")), 5000);
          timer.unref();
          this.acknowledgements.set(id, { resolve, reject });
        });
        // Attach the rejection handler before control-pipe I/O can fail.
        void acknowledged.catch(() => undefined);
        try {
          await Promise.all([
            this.write({ type: "data", id, data: bytes.subarray(offset, offset + 16384).toString("base64") }),
            acknowledged
          ]);
        } finally {
          clearTimeout(timer);
          this.acknowledgements.delete(id);
        }
      }
    }).finally(() => {
      this.queuedBytes -= bytes.length;
      if (this.outputQueues.get(id) === next) this.outputQueues.delete(id);
    });
    this.outputQueues.set(id, next);
    return next;
  }
  private disconnect(id: number): void {
    this.connections.delete(id);
    this.acknowledgements.get(id)?.reject(new Error(MANUAL_RECONNECT));
    void this.write({ type: "close", id }).catch(() => undefined);
  }
  private write(frame: Frame): Promise<void> {
    const child = this.child;
    const next = this.controlWrites.catch(() => undefined).then(async () => {
      if (!child || child !== this.child || child.stdin.destroyed) throw new Error(MANUAL_RECONNECT);
      // One bounded frame at a time. Completion propagates OS backpressure;
      // the peer acknowledgement also bounds the native per-peer queue.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("MCP native control pipe stalled; reconnect manually"));
          if (this.child === child) this.shutdown();
        }, 5000);
        timer.unref();
        try {
          child.stdin.write(JSON.stringify(frame) + "\n", (error) => {
            clearTimeout(timer);
            if (error) reject(error); else resolve();
          });
        } catch (cause) {
          clearTimeout(timer);
          reject(cause);
        }
      });
    });
    this.controlWrites = next;
    return next;
  }
  private shutdown(): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    for (const pending of this.acknowledgements.values()) pending.reject(new Error(MANUAL_RECONNECT));
    this.acknowledgements.clear();
    this.stopped =
      child.pid === undefined || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
            timer.unref();
            child.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          });
    child.kill();
    for (const transport of [...this.connections.values()]) void transport.close();
    this.connections.clear();
    this.onclose?.();
  }
  isRunning(): boolean {
    return this.child !== undefined;
  }
  httpUrl(): string | undefined {
    if (!this.options.allowHttp || !this.isRunning() || this.endpoint === undefined) return undefined;
    return this.endpoint.startsWith("\\\\.\\pipe\\")
      ? `pipe:///pipe/${encodeURIComponent(this.endpoint.slice(9))}#/mcp`
      : `unix://${this.endpoint.split("/").map(encodeURIComponent).join("/")}#/mcp`;
  }
  async stop(): Promise<void> {
    this.shutdown();
    await this.stopped;
  }
}
