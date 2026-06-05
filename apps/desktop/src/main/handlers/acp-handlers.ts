// ACP agent discovery for Settings → AI.
//
// One command-bus verb — `acp:discover` — wraps `@pwrdrvr/agent-acp`'s local
// discovery so the renderer can list which built-in ACP agents (Gemini /
// Grok / Kimi / Qwen) are installed on this machine, see EVERY instance of
// each (every `PATH` match + fallback + a passing override), pick one, or set
// a manual override. Enabling / picking / overriding is a plain `settings:write`
// patch to `ai.acp.*` (existing verb) — there is no separate mutation command;
// the persisted state IS the selection. This module is read-only and never
// spawns an agent in ACP server mode: the kit probes each strategy's CLI with
// `--version` / `--help` only.
//
// `discoverLocalAcpAgentInstances` returns one group per installed agent, each
// with all passing instances. We diff that against `BUILT_IN_ACP_STRATEGIES`
// and emit a not-installed entry (with an install hint) for every strategy the
// discovery didn't return. The user's per-agent override path (from
// `ai.acp.agents`) is fed into discovery so an override outside `PATH` is still
// probed; the active instance is resolved from the override / picked path /
// first found.

import {
  AcpOneShotClient,
  AcpStdioJsonRpcTransport,
  BUILT_IN_ACP_STRATEGIES,
  discoverLocalAcpAgentInstances,
  strategyById,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import { err, ok } from "@pwrsnap/shared";
import type {
  AcpAgentDiscovery,
  AcpAgentDiscoveryEntry,
  AcpAgentInstance,
  AcpAgentModelList,
  AcpAgentModelOption,
  AcpAgentPreference,
  PwrSnapError,
  Result,
  Settings
} from "@pwrsnap/shared";
import { app } from "electron";
import { join } from "node:path";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { resolveActiveAcpInstance } from "../ai/acp-instance-resolver";
import {
  PWRSNAP_CLIENT_NAME,
  PWRSNAP_CLIENT_TITLE,
  toAgentKitLogger
} from "../ai/agent-kit-bindings";

const log = getMainLogger("pwrsnap:acp-handlers");

/** Injectable discovery seam for tests. Production uses the kit's
 *  `discoverLocalAcpAgentInstances` (default `execFile`-backed probe). */
export type AcpDiscoverInstances = (
  options?: LocalAcpDiscoveryOptions
) => Promise<DiscoveredAcpAgentGroup[]>;

/** Injectable settings reader. Production reads via the command bus. */
export type AcpSettingsReader = () => Promise<Settings>;

async function defaultSettingsReader(): Promise<Settings> {
  const result = await bus.dispatch("settings:read", {}, { principal: "ipc" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** A short, human-facing hint for installing an absent agent. The kit
 *  carries `repositoryUrl` per strategy; surface it when present so the
 *  Settings UI can point the user somewhere useful. */
function installHintForStrategy(repositoryUrl: string | undefined): string {
  return repositoryUrl !== undefined && repositoryUrl.length > 0
    ? `Not installed — see ${repositoryUrl}`
    : "Not installed";
}

/** Per-agent override paths from settings, shaped for the kit's `overrides`
 *  option (id → trimmed override path). */
function overridesFromSettings(
  agents: Record<string, AcpAgentPreference> | undefined
): Record<string, string> {
  const overrides: Record<string, string> = {};
  if (agents === undefined) return overrides;
  for (const [id, pref] of Object.entries(agents)) {
    const override = pref.overridePath?.trim();
    if (override) overrides[id] = override;
  }
  return overrides;
}

/** Map the kit's instance groups + the full strategy table + the user's
 *  per-agent preferences onto the protocol's per-agent discovery entries
 *  (installed and not). */
function toDiscovery(
  groups: DiscoveredAcpAgentGroup[],
  agents: Record<string, AcpAgentPreference> | undefined
): AcpAgentDiscovery {
  const byId = new Map<string, DiscoveredAcpAgentGroup>();
  for (const group of groups) byId.set(group.strategyId, group);

  const result: AcpAgentDiscoveryEntry[] = BUILT_IN_ACP_STRATEGIES.map(
    (strategy): AcpAgentDiscoveryEntry => {
      const group = byId.get(strategy.id);
      const pref = agents?.[strategy.id];
      if (group !== undefined && group.instances.length > 0) {
        const instances: AcpAgentInstance[] = group.instances.map((inst) => ({
          command: inst.command,
          source: inst.source,
          ...(inst.version !== undefined ? { version: inst.version } : {})
        }));
        const active = resolveActiveAcpInstance(instances, pref);
        return {
          id: strategy.id,
          displayName: strategy.displayName,
          installed: true,
          instances,
          activeCommand: active.command,
          ...(active.version !== undefined ? { version: active.version } : {}),
          detail: active.command
        };
      }
      return {
        id: strategy.id,
        displayName: strategy.displayName,
        installed: false,
        instances: [],
        detail: installHintForStrategy(strategy.repositoryUrl)
      };
    }
  );

  return { agents: result };
}

export function registerAcpHandlers(params?: {
  discover?: AcpDiscoverInstances;
  readSettings?: AcpSettingsReader;
}): void {
  const discover = params?.discover ?? discoverLocalAcpAgentInstances;
  const readSettings = params?.readSettings ?? defaultSettingsReader;

  bus.register("acp:discover", async (): Promise<
    Result<AcpAgentDiscovery, PwrSnapError>
  > => {
    let agents: Record<string, AcpAgentPreference> | undefined;
    try {
      agents = (await readSettings()).ai.acp.agents;
    } catch (cause) {
      // Settings unreadable is non-fatal for discovery — proceed with no
      // overrides rather than failing the whole list.
      log.warn("acp:discover: settings read failed; discovering without overrides", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      agents = undefined;
    }

    let groups: DiscoveredAcpAgentGroup[];
    try {
      groups = await discover({ overrides: overridesFromSettings(agents) });
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
    return ok(toDiscovery(groups, agents));
  });

  // Session cache: listing models spawns the agent + opens a session (seconds),
  // so memoize per agent. Cleared on app restart; the renderer re-fetches when
  // the user switches providers, hitting the cache after the first spawn.
  const modelCache = new Map<string, AcpAgentModelOption[]>();

  bus.register("acp:models", async (req): Promise<
    Result<AcpAgentModelList, PwrSnapError>
  > => {
    const agentId = req.agentId;
    const cached = modelCache.get(agentId);
    if (cached !== undefined) return ok({ agentId, models: cached });

    let settings: Settings;
    try {
      settings = await readSettings();
    } catch (cause) {
      return err({
        kind: "settings",
        code: "read_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
    const pref = settings.ai.acp.agents?.[agentId];
    const override = pref?.overridePath?.trim();
    const strategy = strategyById(agentId);
    if (strategy === undefined) {
      return err({ kind: "settings", code: "acp_unknown_agent", message: `Unknown ACP agent ${agentId}` });
    }

    let groups: DiscoveredAcpAgentGroup[];
    try {
      groups = await discover(override ? { overrides: { [agentId]: override } } : {});
    } catch (cause) {
      return err({
        kind: "settings",
        code: "acp_discovery_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    }
    const group = groups.find((g) => g.strategyId === agentId);
    if (group === undefined || group.instances.length === 0) {
      // Not installed → empty list (the UI falls back to "Default").
      return ok({ agentId, models: [] });
    }
    const active = resolveActiveAcpInstance(
      group.instances.map((inst) => ({
        command: inst.command,
        source: inst.source,
        ...(inst.version !== undefined ? { version: inst.version } : {})
      })),
      pref
    );
    const cwd = join(app.getPath("documents"), "PwrSnap", "Chats", ".acp-models");
    const logger = toAgentKitLogger("pwrsnap:acp-models");
    const client = new AcpOneShotClient({
      transport: new AcpStdioJsonRpcTransport({
        command: active.command,
        args: [...group.args],
        ...(Object.keys(group.env).length > 0 ? { env: group.env } : {}),
        logger
      }),
      strategy,
      clientName: PWRSNAP_CLIENT_NAME,
      clientTitle: PWRSNAP_CLIENT_TITLE,
      cwd,
      logger
    });
    try {
      const models = await client.listModels();
      const options: AcpAgentModelOption[] = models.map((m) => ({
        id: m.id,
        label: m.label ?? m.id,
        ...(m.description !== undefined ? { description: m.description } : {})
      }));
      modelCache.set(agentId, options);
      return ok({ agentId, models: options });
    } catch (cause) {
      log.warn("acp:models: listing failed", {
        agentId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "ai",
        code: "acp_models_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        cause
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });
}
