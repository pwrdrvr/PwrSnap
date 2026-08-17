// App-wide ACP agent process pool. An ACP agent is a long-lived OS process; one
// AcpAgentClient hosts many concurrent sessions (threads). There is exactly ONE
// process per (agent, resolved binary) app-wide — library chat, sizzle chat,
// capture enrichment, and Settings model listing ALL ride the same pooled
// client; none of them spawns its own (and never a short-lived per-run one).
//
// Start policy: an agent process starts ONLY when something actually routes to
// that agent (a chat surface built for it, an enrichment run on it, a model
// listing for it). There is no boot-time warm and no cross-surface fan-out —
// an agent that is installed and even enabled but never invoked is NEVER
// spawned. Once started, the process is retained for the app lifetime and
// closed at quit via `closeAcpAgentPool`.
//
// Per-surface tool sets ride per-thread (the controller's `threadMcpServers`),
// so library and sizzle threads on the SAME process each spawn their own MCP
// tools. Surfaces opt into `backendClientShared` so they don't clobber each
// other's single-handler registrations on the shared client.

import { mkdir } from "node:fs/promises";
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
import { acpDiscoveryOptionsForEnabledAgent } from "./acp-enabled-discovery";
import { PWRSNAP_CLIENT_NAME, PWRSNAP_CLIENT_TITLE, toAgentKitLogger } from "./agent-kit-bindings";
import { makePooledAcpApprovalHandler } from "./acp-approval-policy";
import { agentScratchJail } from "./enrichment-sandbox";

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

/**
 * The shared scratch cwd every pooled ACP session uses — chat AND capture
 * enrichment, since they share one process.
 *
 * It keeps the agent from scanning a real workspace on `session/new`
 * (multi-second + token bloat), but on the ACP path it is also a SECURITY
 * control, and one of only two we have. ACP has no sandbox concept: the kit
 * drops `sandbox` / `approvalPolicy` / `workspaceRoots` as Codex-only, so
 * `cwd` plus the per-thread `mcpServers` set — backed by the host approval
 * handler — is the whole posture. See AGENTS.md § "Capture enrichment runs in
 * a sandbox jail".
 *
 * Takes NO arguments on purpose. It used to be `acpPoolScratchCwd(chatsDir)`,
 * and every caller passed `~/Documents/PwrSnap/Chats` — putting the agent's
 * cwd one directory above the user's captures, inside the TCC-gated Documents
 * tree, with the doc comment reduced to asking callers to please pass the same
 * value (the pool key ignores cwd, so the first acquirer fixes it for
 * everyone). A parameterless jail makes that class of mistake unrepresentable.
 */
export function acpPoolScratchCwd(): string {
  return agentScratchJail(".acp-scratch");
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

/** Acquire the shared client for an agent — creating + spawning on first
 *  use; dedups concurrent acquires onto one spawn. This is the ONLY way an
 *  ACP agent process starts. */
export async function acquireAcpAgentClient(
  agent: DiscoveredAcpAgent
): Promise<AcpAgentClient> {
  const cwd = acpPoolScratchCwd();
  // tmpdir can be reaped between sessions — the agent's cwd must exist before
  // `session/new`, and nothing else creates it.
  await mkdir(cwd, { recursive: true });
  return getAcpAgentPool().acquire(acpAgentPoolKey(agent), () => makeAcpAgentClient(agent, cwd));
}

/** Close every pooled agent process (app quit). */
export async function closeAcpAgentPool(): Promise<void> {
  if (pool !== undefined) await pool.closeAll();
}

/**
 * Resolve the user's ACTIVE install of one enabled ACP agent (override →
 * picked path → first found), or null when the agent is disabled, unknown, or
 * not installed. Shared by every surface that routes to an agent (chat backend
 * resolution, enrichment, model listing) so they all resolve the same binary
 * and therefore key the SAME pooled process.
 */
export async function resolveEnabledAcpAgent(input: {
  settings: Settings;
  agentId: string;
  discover?: (options?: {
    overrides?: Record<string, string>;
  }) => Promise<DiscoveredAcpAgentGroup[]>;
}): Promise<DiscoveredAcpAgent | null> {
  const { settings, agentId } = input;
  const discoveryOptions = acpDiscoveryOptionsForEnabledAgent(settings, agentId);
  if (discoveryOptions === null) return null;
  const discover = input.discover ?? discoverLocalAcpAgentInstances;
  const groups = await discover(discoveryOptions);
  const group = groups.find((g) => g.strategyId === agentId);
  if (group === undefined || group.instances.length === 0) return null;
  const active = resolveActiveAcpInstance(group.instances, settings.ai.acp.agents?.[agentId]);
  return {
    strategyId: group.strategyId,
    backendId: group.backendId,
    name: group.name,
    command: active.command,
    args: group.args,
    env: group.env,
    discoveredAt: group.discoveredAt,
    ...(active.version !== undefined ? { version: active.version } : {})
  };
}
