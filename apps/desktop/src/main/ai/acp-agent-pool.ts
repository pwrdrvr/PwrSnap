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
  AcpStdioJsonRpcTransport,
  discoverLocalAcpAgentInstances,
  strategyByBackendId,
  strategyById,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup
} from "@pwrdrvr/agent-acp";
import type { Settings } from "@pwrsnap/shared";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";
import { PWRSNAP_CLIENT_NAME, PWRSNAP_CLIENT_TITLE, toAgentKitLogger } from "./agent-kit-bindings";
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
  const transport = new AcpStdioJsonRpcTransport({
    command: agent.command,
    args: agent.args,
    ...(Object.keys(agent.env).length > 0 ? { env: agent.env } : {}),
    logger
  });
  return new AcpAgentClient({
    transport,
    strategy,
    clientName: PWRSNAP_CLIENT_NAME,
    clientTitle: PWRSNAP_CLIENT_TITLE,
    // Auto-approve PwrSnap's own MCP tools; the agent's OWN tools (shell/file/
    // web) get no host handler on the shared client, so the kit cancels them.
    autoApproveConfiguredMcpTools: true,
    // Small scratch cwd so the agent doesn't scan the app/repo tree on
    // session/new (multi-second + token bloat). All sessions share it.
    cwd,
    logger
  });
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

/** Strategy ids configured as the provider for a surface that USES the pool —
 *  the long-lived chat surfaces (library / sizzle). Enrichment runs as a
 *  one-shot client (not pooled yet), so warming an enrichment-only agent would
 *  spawn an unused process; it's excluded until enrichment shares the pool. An
 *  agent installed but not selected for chat (e.g. Kimi) is never spawned. */
function configuredAcpAgentIds(settings: Settings): string[] {
  const providers = [
    settings.ai.defaults.libraryChat.provider,
    settings.ai.defaults.sizzleChat.provider
  ];
  return [
    ...new Set(
      providers
        .map((p) => (p !== undefined && p.startsWith("acp:") ? p.slice("acp:".length) : null))
        .filter((id): id is string => id !== null)
    )
  ];
}

/**
 * Non-blocking startup warm-up: spawn + initialize every ACP agent configured
 * for a surface and hold it in the pool, so the first chat / enrichment doesn't
 * pay the multi-second spawn. Fire-and-forget per agent; failures are logged.
 */
export async function warmConfiguredAcpAgents(input: {
  settings: Settings;
  chatsDir: string;
  discover?: (options?: {
    overrides?: Record<string, string>;
  }) => Promise<DiscoveredAcpAgentGroup[]>;
}): Promise<void> {
  const agentIds = configuredAcpAgentIds(input.settings);
  if (agentIds.length === 0) return;
  const cwd = join(input.chatsDir, ".acp-chat");
  const discover = input.discover ?? discoverLocalAcpAgentInstances;
  for (const agentId of agentIds) {
    try {
      const pref = input.settings.ai.acp.agents?.[agentId];
      const override = pref?.overridePath?.trim();
      const groups = await discover(override ? { overrides: { [agentId]: override } } : {});
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
