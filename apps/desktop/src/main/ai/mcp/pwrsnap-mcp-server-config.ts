// Per-chat stdio byte relay; all MCP handlers live in Electron main.
import type { AcpMcpServerConfig } from "@pwrdrvr/agent-acp";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { mcpExecutablePath } from "./mcp-executable";
import { getToolRpcServer } from "./pwrsnap-tool-rpc-server";
import { getMainLogger } from "../../log";

const log = getMainLogger("pwrsnap:mcp-config");

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
  await server.start();
  const registration = server.register({
    catalog: input.catalog,
    dispatchToolCall: input.dispatchToolCall,
    ...(input.label !== undefined ? { label: input.label } : {})
  });

  const config: AcpMcpServerConfig = {
    name: "pwrsnap",
    command: mcpExecutablePath(),
    args: ["--endpoint", registration.socketPath],
    env: {
      PWRSNAP_MCP_TOKEN: registration.token
    }
  };
  log.info("ACP MCP tool server configured", {
    socketPath: registration.socketPath,
    tools: input.catalog.length
  });
  return { config, unregister: registration.unregister };
}
