// App-wide ACP agent process pool. An ACP agent is a long-lived OS process; one
// AcpAgentClient hosts many concurrent sessions (threads). Without pooling every
// surface (library chat, sizzle chat, enrichment, model-list) would spawn its
// own — so PwrSnap holds ONE warmed client per agent here and shares it.
//
// Per-surface tool sets ride per-thread (the controller's `threadMcpServers`),
// so library and sizzle threads on the SAME process each spawn their own MCP
// tools. Surfaces opt into `backendClientShared` so they don't clobber each
// other's single-handler registrations on the shared client.

import { join } from "node:path";
import {
  AcpAgentClient,
  AcpAgentClientPool,
  AcpConnection,
  discoverLocalAcpAgentInstances,
  strategyByBackendId,
  strategyById,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup
} from "@pwrdrvr/agent-acp";
import type { Settings } from "@pwrsnap/shared";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";
import {
  acpDiscoveryOptionsForEnabledAgent,
  enabledChatAcpAgentIdsInUse
} from "./acp-enabled-discovery";
import { PWRSNAP_CLIENT_NAME, PWRSNAP_CLIENT_TITLE, toAgentKitLogger } from "./agent-kit-bindings";
import { makePooledAcpApprovalHandler } from "./acp-approval-policy";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:acp-pool");

let pool: AcpAgentClientPool | undefined;

export function getAcpAgentPool(): AcpAgentClientPool {
  if (pool === undefined) {
    pool = new AcpAgentClientPool({ logger: toAgentKitLogger("pwrsnap:acp-pool") });
  }
  return pool;
}

/** Pool key: one shared process per (agent, resolved binary). Library + sizzle
 *  using the same Gemini binary share ONE process; switching the binary (an
 *  override) keys a different process. */
export function acpAgentPoolKey(agent: DiscoveredAcpAgent): string {
  return `${agent.strategyId}@${agent.command}`;
}

/** Construct (but don't warm) the shared client for an agent. NO client-level
 *  mcpServers — tools are attached per-thread by the surface. */
function makeAcpAgentClient(agent: DiscoveredAcpAgent, cwd: string): AcpAgentClient {
  const logger = toAgentKitLogger("pwrsnap:acp-pool");
  const strategy = strategyByBackendId(agent.backendId) ?? strategyById(agent.strategyId);
  if (strategy === undefined) {
    throw new Error(`no ACP strategy for discovered agent ${agent.backendId}`);
  }
  const transport = new AcpConnection({
    command: agent.command,
    args: agent.args,
    ...(Object.keys(agent.env).length > 0 ? { env: agent.env } : {}),
    logger
  });
  const client = new AcpAgentClient({
    transport,
    strategy,
    clientName: PWRSNAP_CLIENT_NAME,
    clientTitle: PWRSNAP_CLIENT_TITLE,
    // Small scratch cwd so the agent doesn't scan the app/repo tree on
    // session/new (multi-second + token bloat). All sessions share it.
    cwd,
    logger
  });
  // The pooled client is shared across surfaces, so the chat controller skips
  // its per-surface approval handler (`backendClientShared`). Register PwrSnap's
  // OWN client-level policy here: pre-approve our configured MCP tools, deny the
  // agent's built-in shell/file/web tools. The kit makes no trust decision — it
  // just forwards each permission request to this handler.
  client.onApprovalRequest(makePooledAcpApprovalHandler(logger));
  return client;
}

/** Acquire the shared, warmed client for an agent (creating + warming on first
 *  use; dedups concurrent acquires onto one spawn). */
export async function acquireAcpAgentClient(
  agent: DiscoveredAcpAgent,
  cwd: string
): Promise<AcpAgentClient> {
  return getAcpAgentPool().acquire(acpAgentPoolKey(agent), () => makeAcpAgentClient(agent, cwd));
}

/** Fire-and-forget warm-up (startup) — spawns + initializes the agent so the
 *  first chat/turn is instant. No-op if already warm/warming. */
export function warmAcpAgent(agent: DiscoveredAcpAgent, cwd: string): void {
  getAcpAgentPool().warm(acpAgentPoolKey(agent), () => makeAcpAgentClient(agent, cwd));
}

/** Close every pooled agent process (app quit). */
export async function closeAcpAgentPool(): Promise<void> {
  if (pool !== undefined) await pool.closeAll();
}

/**
 * Non-blocking startup warm-up: spawn + initialize every enabled ACP agent
 * configured for a chat surface and hold it in the pool, so the first chat
 * doesn't pay the multi-second spawn. Fire-and-forget per agent; failures are
 * logged.
 */
export async function warmConfiguredAcpAgents(input: {
  settings: Settings;
  chatsDir: string;
  discover?: (options?: {
    overrides?: Record<string, string>;
  }) => Promise<DiscoveredAcpAgentGroup[]>;
}): Promise<void> {
  const agentIds = enabledChatAcpAgentIdsInUse(input.settings);
  if (agentIds.length === 0) return;
  const cwd = join(input.chatsDir, ".acp-chat");
  const discover = input.discover ?? discoverLocalAcpAgentInstances;
  for (const agentId of agentIds) {
    try {
      const pref = input.settings.ai.acp.agents?.[agentId];
      const discoveryOptions = acpDiscoveryOptionsForEnabledAgent(input.settings, agentId);
      if (discoveryOptions === null) continue;
      const groups = await discover(discoveryOptions);
      const group = groups.find((g) => g.strategyId === agentId);
      if (group === undefined || group.instances.length === 0) continue;
      const active = resolveActiveAcpInstance(group.instances, pref);
      const agent: DiscoveredAcpAgent = {
        strategyId: group.strategyId,
        backendId: group.backendId,
        name: group.name,
        command: active.command,
        args: group.args,
        env: group.env,
        discoveredAt: group.discoveredAt,
        ...(active.version !== undefined ? { version: active.version } : {})
      };
      log.info("warming configured ACP agent", { agentId, command: agent.command });
      warmAcpAgent(agent, cwd);
    } catch (cause) {
      log.warn("warm configured ACP agent failed", {
        agentId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
}
