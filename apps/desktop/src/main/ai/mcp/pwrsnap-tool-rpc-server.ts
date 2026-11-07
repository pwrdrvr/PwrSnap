// Internal ACP MCP endpoint. The per-chat token selects its desktop-owned
// catalog/dispatcher. It grants no external-agent role and cannot be reused
// after unregister. The Rust child only carries bytes.
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { app } from "electron";
import { NativeMcpBridge, type McpByteTransport } from "./native-mcp-bridge";
import { flattenDynamicToolCatalog, toCallToolResult, toMcpTool } from "./mcp-translate";

export type ToolRpcSurface = {
  catalog: DynamicToolSpec[];
  dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  label?: string;
};
export type ToolRpcRegistration = {
  socketPath: string;
  token: string;
  unregister: () => void;
  updateCatalog: (catalog: DynamicToolSpec[]) => void;
};
type Surface = ToolRpcSurface & { sessions: Set<{ server: Server; transport: McpByteTransport }> };
export class PwrSnapToolRpcServer {
  private bridge: NativeMcpBridge | undefined;
  private socketPath: string | undefined;
  private starting: Promise<void> | undefined;
  private readonly surfaces = new Map<string, Surface>();
  async start(): Promise<void> {
    if (this.starting !== undefined) return this.starting;
    this.socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\pwrsnap-acp-${randomUUID()}`
        : `/tmp/pwrsnap-mcp-${process.getuid!()}/a${randomBytes(6).toString("hex")}.sock`;
    const bridge = new NativeMcpBridge({
      endpoint: this.socketPath,
      onConnection: (input) => {
        const surface = input.identity === null ? undefined : this.surfaces.get(input.identity);
        const transport = input.createTransport(async () => {
          if (surface === undefined || this.surfaces.get(input.identity!) !== surface)
            throw new Error("Chat registration expired; reconnect manually");
        });
        if (surface === undefined) {
          void transport.close();
          return;
        }
        const server = new Server(
          { name: "pwrsnap-chat", version: app.getVersion() },
          {
            capabilities: { tools: { listChanged: true } },
            instructions:
              "These tools belong to the current PwrSnap chat registration. Re-discover tools after a list-change notification. A closed chat requires a new registration."
          }
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: flattenDynamicToolCatalog(surface.catalog).map((entry) => toMcpTool(entry.spec))
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          if (
            input.identity === null ||
            this.surfaces.get(input.identity) !== surface ||
            transport.controller.signal.aborted ||
            extra.signal.aborted
          )
            throw new Error("Chat registration expired");
          const entry = flattenDynamicToolCatalog(surface.catalog).find(
            (item) => item.spec.name === request.params.name
          );
          if (entry === undefined) throw new Error("Unknown chat tool; re-discover tools");
          return toCallToolResult(
            await surface.dispatchToolCall({
              threadId: "",
              turnId: "",
              callId: String(extra.requestId),
              namespace: entry.namespace,
              tool: entry.spec.name,
              arguments: (request.params.arguments ?? {}) as DynamicToolCallParams["arguments"]
            })
          );
        });
        const session = { server, transport };
        surface.sessions.add(session);
        transport.controller.signal.addEventListener(
          "abort",
          () => {
            surface.sessions.delete(session);
            void server.close();
          },
          { once: true }
        );
        void server.connect(transport).catch(() => {
          void transport.close();
        });
      }
    });
    this.bridge = bridge;
    this.starting = bridge.start().catch((cause: unknown) => {
      this.bridge = undefined;
      this.starting = undefined;
      throw cause;
    });
    return this.starting;
  }
  register(input: ToolRpcSurface): ToolRpcRegistration {
    if (this.socketPath === undefined || this.bridge === undefined || !this.bridge.isRunning())
      throw new Error("MCP register before start");
    const token = randomBytes(24).toString("hex");
    const surface: Surface = {
      ...input,
      catalog: structuredClone(input.catalog),
      sessions: new Set()
    };
    this.surfaces.set(token, surface);
    return {
      socketPath: this.socketPath,
      token,
      unregister: () => {
        this.surfaces.delete(token);
        for (const session of [...surface.sessions]) void session.transport.close();
      },
      updateCatalog: (catalog) => {
        if (this.surfaces.get(token) !== surface) return;
        surface.catalog = structuredClone(catalog);
        for (const session of surface.sessions)
          void session.server.sendToolListChanged().catch(() => undefined);
      }
    };
  }
  async stop(): Promise<void> {
    this.surfaces.clear();
    await this.bridge?.stop();
    this.bridge = undefined;
    this.starting = undefined;
    this.socketPath = undefined;
  }
}
let singleton: PwrSnapToolRpcServer | undefined;
export function getToolRpcServer(): PwrSnapToolRpcServer {
  return (singleton ??= new PwrSnapToolRpcServer());
}
