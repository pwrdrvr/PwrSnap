// Client for PwrSnapToolRpcServer's Unix-domain-socket protocol. Used by the
// spawned MCP server (pwrsnap-mcp-server-entry) to reach PwrSnap main, and by
// tests. Newline-delimited JSON, one in-flight request at a time (the MCP
// server serializes tool calls per turn anyway), short connect retry so a race
// against main's listen() doesn't fail the first call.

import { connect, type Socket } from "node:net";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";

export type ToolRpcClientOptions = {
  socketPath: string;
  token: string;
  /** Per-request timeout (ms). Default 60s — a tool dispatch can render. */
  timeoutMs?: number;
};

export class ToolRpcClient {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: ToolRpcClientOptions) {
    this.socketPath = options.socketPath;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async list(): Promise<DynamicToolSpec[]> {
    const res = (await this.request({ token: this.token, op: "list" })) as {
      ok: boolean;
      tools?: DynamicToolSpec[];
      error?: string;
    };
    if (!res.ok) throw new Error(`tool RPC list failed: ${res.error ?? "unknown"}`);
    return res.tools ?? [];
  }

  async call(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const res = (await this.request({ token: this.token, op: "call", call })) as {
      ok: boolean;
      response?: DynamicToolCallResponse;
      error?: string;
    };
    if (!res.ok || res.response === undefined) {
      throw new Error(`tool RPC call failed: ${res.error ?? "unknown"}`);
    }
    return res.response;
  }

  /** One connect → write → read-line → close round-trip. */
  private request(payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let settled = false;
      let buffer = "";
      const done = (err: Error | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(
        () => done(new Error("tool RPC timeout")),
        this.timeoutMs
      );
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          try {
            done(null, JSON.parse(buffer.slice(0, newline)));
          } catch (cause) {
            done(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }
      });
      socket.on("error", (err) => done(err));
      socket.on("close", () => done(new Error("tool RPC connection closed")));
    });
  }
}
