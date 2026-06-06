// Builds the `AcpMcpServerConfig` that tells an ACP chat agent (Gemini/Qwen)
// how to spawn PwrSnap's MCP tool server, and registers the surface's tools
// with the callback RPC server. One place that ties together:
//
//   PwrSnapToolRpcServer (UDS, this process)
//     ← spawned MCP server (pwrsnap-mcp-server.js, Electron-as-Node)
//        ← the ACP agent (spawns it from the returned config)
//
// The agent runs `command + args` with `env`, so we point `command` at the
// PwrSnap binary itself (`process.execPath`) with `ELECTRON_RUN_AS_NODE=1`,
// which runs the bundled MCP entry as plain Node — no separate `node` on the
// user's PATH required, in dev or packaged.

import { join } from "node:path";
import { app } from "electron";
import type { AcpMcpServerConfig } from "@pwrdrvr/agent-acp";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { getToolRpcServer } from "./pwrsnap-tool-rpc-server";
import { getMainLogger } from "../../log";

const log = getMainLogger("pwrsnap:mcp-config");

/** Absolute path to the built MCP server entry. `__dirname` is the compiled
 *  main bundle dir (`out/main`) in both dev and packaged builds — the entry is
 *  emitted there as `pwrsnap-mcp-server.js` (see electron.vite.config.ts). */
function mcpServerEntryPath(): string {
  return join(__dirname, "pwrsnap-mcp-server.js");
}

export type PwrSnapMcpServer = {
  /** The config to hand the ACP agent (`AcpAgentClient({ mcpServers })`). */
  config: AcpMcpServerConfig;
  /** Drop the surface's token. Call on chat-surface teardown. */
  unregister: () => void;
};

/** Start (idempotent) the tool RPC server, register this surface's tools, and
 *  return the spawn config + an `unregister`. Returns `null` when the surface
 *  has no tools (no point spawning an empty server). */
export async function buildPwrSnapMcpServer(input: {
  catalog: DynamicToolSpec[];
  dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Log attribution for this token — surface + agent, e.g. "library-chat/grok". */
  label?: string;
}): Promise<PwrSnapMcpServer | null> {
  if (input.catalog.length === 0) return null;

  const server = getToolRpcServer();
  await server.start(join(app.getPath("userData"), "mcp"));
  const registration = server.register({
    catalog: input.catalog,
    dispatchToolCall: input.dispatchToolCall,
    ...(input.label !== undefined ? { label: input.label } : {})
  });

  const config: AcpMcpServerConfig = {
    name: "pwrsnap",
    command: process.execPath,
    args: [mcpServerEntryPath()],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      PWRSNAP_MCP_SOCKET: registration.socketPath,
      PWRSNAP_MCP_TOKEN: registration.token
    }
  };
  log.info("ACP MCP tool server configured", {
    socketPath: registration.socketPath,
    tools: input.catalog.length
  });
  return { config, unregister: registration.unregister };
}
