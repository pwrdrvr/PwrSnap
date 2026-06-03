// ACP agent discovery for Settings → AI.
//
// One command-bus verb — `acp:discover` — wraps `@pwrdrvr/agent-acp`'s local
// discovery so the renderer can list which built-in ACP agents (Gemini /
// Grok / Kimi / Qwen) are installed on this machine and let the user enable
// the ones they want. Enabling is a plain `settings:write` patch to
// `ai.acp.enabledAgentIds` (existing verb) — there is no separate "enable"
// command; the persisted set IS the selection. This module is read-only and
// never spawns an agent in ACP server mode: the kit probes each strategy's
// CLI with `--version` / `--help` only.
//
// `discoverLocalAcpAgents` returns ONLY installed agents (each strategy
// whose probe passed). To surface the full known list — installed and not —
// we diff the discovery result against `BUILT_IN_ACP_STRATEGIES` and emit a
// not-installed entry (with an install hint) for every strategy the
// discovery didn't return. A probe that throws for one agent is isolated by
// the kit (that strategy yields no result), so it reads as not-installed
// rather than failing the whole list.

import {
  BUILT_IN_ACP_STRATEGIES,
  discoverLocalAcpAgents,
  type DiscoveredAcpAgent,
  type LocalAcpAgentProbe
} from "@pwrdrvr/agent-acp";
import { err, ok } from "@pwrsnap/shared";
import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:acp-handlers");

/** Injectable discovery seam for tests. Production uses the kit's
 *  `discoverLocalAcpAgents` (default `execFile`-backed probe). */
export type AcpDiscover = (options?: {
  probe?: LocalAcpAgentProbe;
}) => Promise<DiscoveredAcpAgent[]>;

/** A short, human-facing hint for installing an absent agent. The kit
 *  carries `repositoryUrl` per strategy; surface it when present so the
 *  Settings UI can point the user somewhere useful. */
function installHintForStrategy(repositoryUrl: string | undefined): string {
  return repositoryUrl !== undefined && repositoryUrl.length > 0
    ? `Not installed — see ${repositoryUrl}`
    : "Not installed";
}

/** Map the kit's installed-agent list + the full strategy table onto the
 *  protocol's per-agent discovery entries (installed and not). */
function toDiscovery(installed: DiscoveredAcpAgent[]): AcpAgentDiscovery {
  const byId = new Map<string, DiscoveredAcpAgent>();
  for (const agent of installed) byId.set(agent.strategyId, agent);

  const agents: AcpAgentDiscoveryEntry[] = BUILT_IN_ACP_STRATEGIES.map(
    (strategy): AcpAgentDiscoveryEntry => {
      const found = byId.get(strategy.id);
      if (found !== undefined) {
        return {
          id: strategy.id,
          displayName: strategy.displayName,
          installed: true,
          ...(found.version !== undefined ? { version: found.version } : {}),
          detail: found.command
        };
      }
      return {
        id: strategy.id,
        displayName: strategy.displayName,
        installed: false,
        detail: installHintForStrategy(strategy.repositoryUrl)
      };
    }
  );

  return { agents };
}

export function registerAcpHandlers(params?: { discover?: AcpDiscover }): void {
  const discover = params?.discover ?? discoverLocalAcpAgents;

  bus.register("acp:discover", async (): Promise<
    Result<AcpAgentDiscovery, PwrSnapError>
  > => {
    let installed: DiscoveredAcpAgent[];
    try {
      installed = await discover();
    } catch (cause) {
      // The kit isolates per-strategy probe failures internally, so a
      // throw here is an unexpected, list-wide failure (e.g. a bug in the
      // discovery itself) — surface it rather than claim "none installed".
      log.warn("acp:discover: local discovery failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "settings",
        code: "acp_discovery_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
    return ok(toDiscovery(installed));
  });
}
