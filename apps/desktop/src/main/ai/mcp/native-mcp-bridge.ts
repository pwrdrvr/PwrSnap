import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpExecutablePath } from "./mcp-executable";

const MAX_MESSAGE = 1024 * 1024;
const MAX_PENDING = 4 * MAX_MESSAGE;
export const MANUAL_RECONNECT =
  "Open PwrSnap yourself, enable Local agents in Settings, then manually reconnect this MCP server in your host. Requests are never replayed.";

export type McpConnection = {
  id: number;
  relayVersion: string;
  identity: string | null;
  createTransport: (prepare?: (message: JSONRPCMessage) => Promise<void>) => McpByteTransport;
};

type Frame = {
  type: "ready" | "open" | "data" | "close";
  id: number;
  data?: string;
  relay_version?: string;
  identity?: string | null;
};

/** SDK transport owned by Electron. Decodes MCP framing without selecting or
 * rewriting message fields. Both requests and responses flow through it. */
export class McpByteTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly controller = new AbortController();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private pending: JSONRPCMessage[] = [];
  private pendingBytes = 0;
  private started = false;
  private ready = false;
  private preparing = false;
  private closed = false;
  constructor(
    private readonly writeBytes: (bytes: Buffer) => void,
    private readonly disconnect: () => void,
    private readonly beforeInitialize?: (message: JSONRPCMessage) => Promise<void>
  ) {}
  async start(): Promise<void> {
    this.started = true;
    this.drain();
  }
  receive(bytes: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    if (Buffer.byteLength(this.buffer) > MAX_MESSAGE)
      return this.fail(new Error("MCP message exceeds 1 MiB"));
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0")
          throw new Error("invalid MCP message");
        this.pendingBytes += Buffer.byteLength(line);
        if (this.pendingBytes > MAX_PENDING || this.pending.length >= 128)
          throw new Error("MCP input overflow");
        this.pending.push(message);
        this.drain();
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error("invalid MCP message"));
        return;
      }
    }
  }
  private drain(): void {
    if (!this.started || this.closed || this.preparing || this.pending.length === 0) return;
    if (!this.ready) {
      const first = this.pending[0];
      if (!("method" in first) || first.method !== "initialize")
        return this.fail(new Error("Initialize MCP before using PwrSnap"));
      this.preparing = true;
      void Promise.resolve()
        .then(() => this.beforeInitialize?.(first))
        .then(() => {
          this.preparing = false;
          this.ready = true;
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
    for (const message of messages) {
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
      this.writeBytes(bytes);
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
  private readonly connections = new Map<number, McpByteTransport>();
  onclose?: () => void;
  constructor(
    private readonly options: {
      endpoint?: string;
      executable?: string;
      onConnection: (input: McpConnection) => void;
    }
  ) {}
  async start(): Promise<void> {
    if (this.child !== undefined) return;
    const child = spawn(
      this.options.executable ?? mcpExecutablePath(),
      [
        "--desktop-listen",
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
      createTransport: (prepare) => {
        if (this.connections.has(frame.id)) throw new Error("duplicate connection");
        const transport = new McpByteTransport(
          (bytes) => {
            for (let offset = 0; offset < bytes.length; offset += 16384)
              this.write({
                type: "data",
                id: frame.id,
                data: bytes.subarray(offset, offset + 16384).toString("base64")
              });
          },
          () => {
            this.connections.delete(frame.id);
            try {
              this.write({ type: "close", id: frame.id });
            } catch {
              this.shutdown();
            }
          },
          prepare
        );
        this.connections.set(frame.id, transport);
        return transport;
      }
    });
  }
  private write(frame: Frame): void {
    const input = this.child?.stdin;
    if (input === undefined || input.destroyed) return;
    if (input.writableLength > MAX_PENDING) {
      this.shutdown();
      throw new Error("MCP control output overflow");
    }
    input.write(JSON.stringify(frame) + "\n");
  }
  private shutdown(): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
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
  async stop(): Promise<void> {
    this.shutdown();
    await this.stopped;
  }
}
