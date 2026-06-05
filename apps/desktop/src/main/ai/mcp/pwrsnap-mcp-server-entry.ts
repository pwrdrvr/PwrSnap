// pwrsnap-mcp-server — the stdio MCP server an ACP agent (Gemini/Qwen) spawns
// to reach PwrSnap's chat tools. It is a SEPARATE PROCESS from PwrSnap main
// (the agent owns its lifecycle), spawned via Electron-as-Node:
//
//   command = process.execPath  (env ELECTRON_RUN_AS_NODE=1)
//   args    = [<this file, built by electron-vite>]
//   env     = { PWRSNAP_MCP_SOCKET, PWRSNAP_MCP_TOKEN }
//
// It exposes PwrSnap's tool catalog over MCP (tools/list, tools/call) and
// forwards every call to PwrSnap main over the token-authed UDS
// (ToolRpcClient → PwrSnapToolRpcServer → dispatchToolCall → command-bus[mcp]).
//
// CRITICAL: stdout is the MCP protocol channel. NOTHING may write to stdout
// except the SDK transport — all diagnostics go to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { DynamicToolCallParams, DynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import { ToolRpcClient } from "./pwrsnap-tool-rpc-client";
import { toCallToolResult, toMcpTool } from "./mcp-translate";

function logStderr(message: string, extra?: unknown): void {
  // stderr only — stdout is reserved for the MCP transport.
  const suffix = extra === undefined ? "" : ` ${JSON.stringify(extra)}`;
  process.stderr.write(`[pwrsnap-mcp] ${message}${suffix}\n`);
}

async function main(): Promise<void> {
  const socketPath = process.env.PWRSNAP_MCP_SOCKET;
  const token = process.env.PWRSNAP_MCP_TOKEN;
  if (!socketPath || !token) {
    logStderr("missing PWRSNAP_MCP_SOCKET / PWRSNAP_MCP_TOKEN — refusing to start");
    process.exit(1);
  }

  const rpc = new ToolRpcClient({ socketPath, token });

  // Fetch the catalog once at startup. If main isn't reachable, fail fast — the
  // agent surfaces an empty/erroring tool server rather than hanging.
  let catalog: DynamicToolSpec[];
  try {
    catalog = await rpc.list();
  } catch (cause) {
    logStderr("failed to fetch tool catalog", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    process.exit(1);
  }
  const byName = new Map(catalog.map((t) => [t.name, t]));
  logStderr("catalog loaded", { tools: catalog.map((t) => t.name) });

  const server = new Server(
    { name: "pwrsnap", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.map(toMcpTool)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = byName.get(request.params.name);
    const params: DynamicToolCallParams = {
      // dispatchLibraryToolCall keys on tool/namespace/arguments only; the
      // thread/turn/call ids are unused by the dispatcher, so stub them.
      threadId: "",
      turnId: "",
      callId: `mcp-${request.params.name}`,
      namespace: spec?.namespace ?? null,
      tool: request.params.name,
      arguments: (request.params.arguments ?? {}) as DynamicToolCallParams["arguments"]
    };
    try {
      const response = await rpc.call(params);
      return toCallToolResult(response);
    } catch (cause) {
      // Never throw out of the handler — return an error result the agent can
      // recover from on its next turn.
      const message = cause instanceof Error ? cause.message : String(cause);
      logStderr("tool call failed", { tool: request.params.name, message });
      return {
        content: [{ type: "text", text: `tool call failed: ${message}` }],
        isError: true
      };
    }
  });

  await server.connect(new StdioServerTransport());
  logStderr("ready");
}

void main().catch((cause) => {
  logStderr("fatal", { message: cause instanceof Error ? cause.message : String(cause) });
  process.exit(1);
});
