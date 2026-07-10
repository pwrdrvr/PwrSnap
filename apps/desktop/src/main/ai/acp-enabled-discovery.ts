import {
  BUILT_IN_ACP_STRATEGIES,
  strategyById,
  type AcpAgentStrategy,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import type { AcpAgentPreference, Settings } from "@pwrsnap/shared";

function enabledAcpAgentIdSet(settings: Settings): Set<string> {
  return new Set(settings.ai.acp.enabledAgentIds);
}

function overridesFromPreferences(
  agents: Record<string, AcpAgentPreference> | undefined,
  enabledIds: Set<string>
): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (agents === undefined) return overrides;
  for (const [id, pref] of Object.entries(agents)) {
    if (!enabledIds.has(id)) continue;
    const override = pref.overridePath?.trim();
    if (override) overrides[id] = override;
  }
  return overrides;
}

function withOverrides(
  strategies: readonly AcpAgentStrategy[],
  overrides: Record<string, string>
): LocalAcpDiscoveryOptions {
  return {
    strategies,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {})
  };
}

/** Discovery options for the user's enabled ACP agents only. Passing the
 * filtered strategy table into the kit prevents disabled agents from being
 * probed at all; filtering after discovery is too late for CLIs like Gemini
 * that may open auth UI during a probe. */
export function acpDiscoveryOptionsForEnabledAgents(
  settings: Settings
): LocalAcpDiscoveryOptions {
  const enabledIds = enabledAcpAgentIdSet(settings);
  return withOverrides(
    BUILT_IN_ACP_STRATEGIES.filter((strategy) => enabledIds.has(strategy.id)),
    overridesFromPreferences(settings.ai.acp.agents, enabledIds)
  );
}

/** Discovery options for the Settings install scanner. Unlike runtime paths,
 * this must probe every built-in strategy so a fresh user can discover an
 * installed-but-disabled agent and enable it. Manual override paths remain
 * gated by enablement so a disabled custom Gemini path is not invoked. */
export function acpDiscoveryOptionsForInstallScan(
  settings: Settings
): LocalAcpDiscoveryOptions {
  return withOverrides(
    BUILT_IN_ACP_STRATEGIES,
    overridesFromPreferences(settings.ai.acp.agents, enabledAcpAgentIdSet(settings))
  );
}

/** Discovery options for one enabled ACP agent. Returns null when the requested
 * agent is unknown or disabled, so callers can skip discovery/spawn entirely. */
export function acpDiscoveryOptionsForEnabledAgent(
  settings: Settings,
  agentId: string
): LocalAcpDiscoveryOptions | null {
  if (!enabledAcpAgentIdSet(settings).has(agentId)) return null;
  const strategy = strategyById(agentId);
  if (strategy === undefined) return null;
  const override = settings.ai.acp.agents?.[agentId]?.overridePath?.trim();
  return withOverrides(
    [strategy],
    override !== undefined && override.length > 0 ? { [agentId]: override } : {}
  );
}

export function enabledChatAcpAgentIdsInUse(settings: Settings): string[] {
  const enabledIds = enabledAcpAgentIdSet(settings);
  const providers = [
    settings.ai.defaults.libraryChat.provider,
    settings.ai.defaults.sizzleChat.provider
  ];
  return [
    ...new Set(
      providers
        .map((provider) =>
          provider !== undefined && provider.startsWith("acp:")
            ? provider.slice("acp:".length)
            : null
        )
        .filter((id): id is string => id !== null && enabledIds.has(id))
    )
  ];
}
