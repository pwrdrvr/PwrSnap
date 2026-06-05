// Builds a kit `ChatThreadController` for one PwrSnap chat surface (Library or
// Sizzle), wiring it to:
//   • a `CodexThreadClient` (the kit's `AgentBackend`),
//   • a `ThreadStoreAdapter` over PwrSnap's `ChatThreadStore` (+ usage),
//   • a per-surface event adapter that re-broadcasts the controller's neutral
//     events onto PwrSnap's six `events:*Chat:*` IPC channels,
//   • PwrSnap's system-prompt / turn-context builders, tool catalog + dispatch.
//
// Both handlers (library-chat, sizzle-chat) call this so the construction lives
// in exactly one place. The controller's neutral decision type differs from
// PwrSnap's; `toKitApprovalDecision` maps between them at the verb boundary.

import { join } from "node:path";
import { ChatThreadController, CodexThreadClient } from "@pwrdrvr/agent-client";
import type { ChatBackend, ChatThreadControllerDeps } from "@pwrdrvr/agent-client";
import type { AgentBackend, NormalizedApprovalDecision } from "@pwrdrvr/agent-core";
import {
  AcpAgentClient,
  AcpStdioJsonRpcTransport,
  discoverLocalAcpAgentInstances,
  strategyByBackendId,
  strategyById,
  type AcpMcpServerConfig,
  type DiscoveredAcpAgent,
  type DiscoveredAcpAgentGroup,
  type LocalAcpDiscoveryOptions
} from "@pwrdrvr/agent-acp";
import { resolveActiveAcpInstance } from "./acp-instance-resolver";
import { buildPwrSnapMcpServer } from "./mcp/pwrsnap-mcp-server-config";
import { acquireAcpAgentClient } from "./acp-agent-pool";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type {
  AiSurfaceDefault,
  AiUsageThreadSurface,
  ChatApprovalDecision,
  Settings
} from "@pwrsnap/shared";
import { ChatThreadStore } from "./chat-thread-store";
import { ThreadStoreAdapter } from "./thread-store-adapter";
import { makeChatBroadcast, type ChatBroadcast, type ChatChannelSet } from "./chat-event-adapter";
import { toAgentKitLogger, PWRSNAP_CLIENT_NAME, PWRSNAP_CLIENT_TITLE, PWRSNAP_SERVICE_NAME } from "./agent-kit-bindings";

/** PwrSnap's approval decision union → the kit's neutral decision. PwrSnap
 *  distinguishes "reject-layer" / "reject-run" at the renderer for the layer-
 *  level undo affordances, but at the Codex protocol boundary every non-approve
 *  decision is a deny; "deny" + both reject variants collapse to "denied". */
export function toKitApprovalDecision(decision: ChatApprovalDecision): NormalizedApprovalDecision {
  return decision === "approve" ? "approved" : "denied";
}

export type ChatSurfaceConfig = {
  /** Resolved codex command (binary path or "codex"). */
  command: string;
  /** Process env for the spawned Codex — carries CODEX_HOME for the selected
   *  auth profile (`codexEnvForProfile`). Omit for the default ~/.codex. */
  env?: NodeJS.ProcessEnv;
  /** ~/Documents/PwrSnap/Chats. */
  chatsDir: string;
  /** Reads the PwrSnap settings snapshot (frozen per turn by the controller). */
  readSettings: () => Promise<Settings>;
  /** The surface's six broadcast channels. */
  channels: ChatChannelSet;
  /** Typed broadcast to live renderers. */
  send: ChatBroadcast;
  /** Usage-accounting surface. */
  usageSurface: AiUsageThreadSurface;
  /** L1 + L2 system prompt builder. */
  buildSystemPrompt: (input: { settings: Settings; anchorId: string | null }) => string;
  /** Per-turn L3 runtime context (active capture / project). */
  buildTurnContext: (anchor: string) => string;
  /** Friendly activity-chip labels. */
  toolLabels: Record<string, string>;
  /** DynamicToolSpec[] registered on every thread/start. */
  catalog: DynamicToolSpec[];
  /** Routes a tool call back to the surface's allowlist. */
  dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Per-thread Codex config overlay (disable coding-agent scaffolding). */
  threadConfig: Record<string, unknown>;
  /** Thread environments. `[]` disables exec-environment access. */
  threadEnvironments: unknown[];
  /** The surface's configured chat BACKEND selector
   *  (`ai.defaults.<surface>.provider`). `"codex"` / `""` / `undefined` /
   *  any unknown value → the Codex backend (`CodexThreadClient`).
   *  `"acp:<id>"` → the matching discovered ACP agent
   *  (`AcpAgentClient`), falling back to Codex when that agent isn't
   *  installed. NOT a Codex `modelProvider` token — chat surfaces use the
   *  provider value to pick the backend, not to set a Codex sub-provider. */
  provider?: string;
  /** Per-surface default model id for thread/start. Omit / undefined =
   *  use the Codex default (no `model` sent). Driven by Settings → AI's
   *  per-surface defaults (`ai.defaults.libraryChat` / `.sizzleChat`). For
   *  the ACP backend this maps to a best-effort `session/set_model`. */
  model?: string;
  /** Per-surface default reasoning effort for turns. Omit / undefined =
   *  the kit's default ("medium"). */
  effort?: string;
  loggerScope: string;
};

export type ChatSurface = {
  controller: ChatThreadController<Settings>;
};

/** Map a Settings per-surface default onto the chat-surface's kit knobs.
 *  Only carries a key when the user pinned a value — an unset leaf is
 *  omitted so the controller falls back to the Codex / kit defaults.
 *  Shared by the Library + Sizzle chat handlers so the mapping lives in
 *  one place.
 *
 *  NOTE on `provider`: for a chat surface, `provider` is the BACKEND
 *  selector (`codex` / `acp:<id>`), not a Codex `modelProvider` token, so
 *  it is forwarded as `provider` (which `buildChatSurface` resolves into a
 *  `CodexThreadClient` or an `AcpAgentClient`) — NOT mapped to a Codex
 *  `modelProvider`. The empty string / "codex" both mean "use Codex". */
export function chatSurfaceDefaultsFromSettings(
  surface: AiSurfaceDefault
): { provider?: string; model?: string; effort?: string } {
  return {
    ...(surface.provider !== undefined && surface.provider.length > 0
      ? { provider: surface.provider }
      : {}),
    ...(surface.model !== undefined && surface.model.length > 0
      ? { model: surface.model }
      : {}),
    ...(surface.reasoning !== undefined ? { effort: surface.reasoning } : {})
  };
}

/** Seams the backend resolver depends on, injectable for tests. Production
 *  uses the kit's real `discoverLocalAcpAgents` + concrete client classes. */
export type ChatBackendDeps = {
  /** Local ACP discovery (multi-instance). Defaults to the kit's
   *  `discoverLocalAcpAgentInstances`. */
  discoverAcpAgentInstances?: (
    options?: LocalAcpDiscoveryOptions
  ) => Promise<DiscoveredAcpAgentGroup[]>;
  /** Codex backend factory. Defaults to constructing a `CodexThreadClient`. */
  makeCodexClient?: (input: {
    command: string;
    env?: NodeJS.ProcessEnv;
    loggerScope: string;
  }) => ChatBackend;
  /** ACP backend factory. Defaults to acquiring the SHARED pooled
   *  `AcpAgentClient` for the agent and building this surface's per-thread MCP
   *  tool bridge. Returns the client plus the surface's `mcpServers` (attached
   *  per-thread, since one client serves multiple surfaces). */
  makeAcpClient?: (input: {
    agent: DiscoveredAcpAgent;
    loggerScope: string;
    cwd: string;
    catalog: DynamicToolSpec[];
    dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  }) => AcpBackendResult | Promise<AcpBackendResult>;
};

export type AcpBackendResult = {
  client: ChatBackend;
  /** This surface's MCP servers, forwarded per-thread (the shared client has
   *  none at the client level). */
  mcpServers: AcpMcpServerConfig[];
};

function defaultMakeCodexClient(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  loggerScope: string;
}): ChatBackend {
  return new CodexThreadClient({
    command: input.command,
    ...(input.env !== undefined ? { env: input.env } : {}),
    clientName: PWRSNAP_CLIENT_NAME,
    clientTitle: PWRSNAP_CLIENT_TITLE,
    serviceName: PWRSNAP_SERVICE_NAME,
    logger: toAgentKitLogger(input.loggerScope)
  });
}

async function defaultMakeAcpClient(input: {
  agent: DiscoveredAcpAgent;
  loggerScope: string;
  cwd: string;
  catalog: DynamicToolSpec[];
  dispatchToolCall: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
}): Promise<AcpBackendResult> {
  const logger = toAgentKitLogger(input.loggerScope);
  // Build THIS surface's MCP tool bridge (its own socket token → its own tools).
  // Best-effort — if it can't be set up, chat still works, just without tools.
  let mcpServers: AcpMcpServerConfig[] = [];
  try {
    const mcp = await buildPwrSnapMcpServer({
      catalog: input.catalog,
      dispatchToolCall: input.dispatchToolCall
    });
    // The MCP server config rides per-thread via the controller's
    // `threadMcpServers`, so each surface's threads spawn its tools on the
    // SHARED process. (The token's unregister is dropped: surfaces are
    // app-lifetime, and the RPC server is stopped wholesale at app quit.)
    if (mcp !== null) mcpServers = [mcp.config];
  } catch (cause) {
    logger.warn?.("acp chat: MCP tool bridge setup failed; tools disabled", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  // Acquire the SHARED, warmed client for this agent (one process per agent,
  // reused across surfaces + warmed at startup) instead of spawning a new one.
  const client = await acquireAcpAgentClient(input.agent, input.cwd);
  return { client, mcpServers };
}

/** Resolve the surface's `AgentBackend` from its configured provider.
 *  `codex` / `""` / `undefined` / unknown → Codex. `acp:<id>` → the matching
 *  discovered ACP agent, falling back to Codex with a warning when that agent
 *  isn't installed (so the surface never crashes on a stale/uninstalled
 *  selection). */
type ResolvedChatBackend = {
  client: ChatBackend;
  /** Per-thread MCP servers (ACP shared client); absent for Codex. */
  threadMcpServers?: AcpMcpServerConfig[];
  /** True when `client` is a shared (pooled) ACP process — the controller skips
   *  single-handler registration to avoid clobbering a sibling surface. */
  shared: boolean;
};

async function resolveChatBackend(
  config: ChatSurfaceConfig,
  deps: ChatBackendDeps
): Promise<ResolvedChatBackend> {
  const makeCodex = deps.makeCodexClient ?? defaultMakeCodexClient;
  const codex = (): ResolvedChatBackend => ({
    client: makeCodex({
      command: config.command,
      ...(config.env !== undefined ? { env: config.env } : {}),
      loggerScope: config.loggerScope
    }),
    shared: false
  });

  const provider = config.provider;
  if (provider === undefined || provider === "" || provider === "codex") {
    return codex();
  }
  if (!provider.startsWith("acp:")) {
    // Unknown / legacy free-text provider — treat as Codex (the chat surface
    // never sends a non-`acp:` value as a Codex modelProvider anymore).
    return codex();
  }

  const log = toAgentKitLogger(config.loggerScope);
  const discover = deps.discoverAcpAgentInstances ?? discoverLocalAcpAgentInstances;
  const strategyId = provider.slice("acp:".length);

  // Honor the user's per-agent path choice (Settings → AI → ACP agents): a
  // manual override is fed into discovery so it's probed even outside PATH; the
  // active instance (override → picked → first) is resolved by the SAME helper
  // the discovery handler uses, so the spawned binary matches the "Using" badge.
  const pref = (await config.readSettings()).ai.acp.agents?.[strategyId];
  const override = pref?.overridePath?.trim();

  let groups: DiscoveredAcpAgentGroup[];
  try {
    groups = await discover(override ? { overrides: { [strategyId]: override } } : {});
  } catch (cause) {
    log.warn("chat backend: ACP discovery failed; falling back to Codex", {
      provider,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return codex();
  }
  const group = groups.find(
    (g) => g.backendId === provider || g.strategyId === strategyId
  );
  if (group === undefined || group.instances.length === 0) {
    log.warn("chat backend: ACP agent not installed; falling back to Codex", {
      provider
    });
    return codex();
  }
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
  const makeAcp = deps.makeAcpClient ?? defaultMakeAcpClient;
  // Pin the ACP session to a dedicated scratch dir under ~/Documents/PwrSnap/
  // Chats so the agent doesn't scan the app/repo tree for "workspace context"
  // (the cause of the multi-second chat stall). One shared dir is fine — chat
  // tools reach PwrSnap over the bridge, not the agent's filesystem cwd.
  const acpCwd = join(config.chatsDir, ".acp-chat");
  const result = await makeAcp({
    agent,
    loggerScope: config.loggerScope,
    cwd: acpCwd,
    catalog: config.catalog,
    dispatchToolCall: config.dispatchToolCall
  });
  return {
    client: result.client,
    ...(result.mcpServers.length > 0 ? { threadMcpServers: result.mcpServers } : {}),
    shared: true
  };
}

export async function buildChatSurface(
  config: ChatSurfaceConfig,
  deps: ChatBackendDeps = {}
): Promise<ChatSurface> {
  const store = new ChatThreadStore({ chatsDir: config.chatsDir });
  const adapter = new ThreadStoreAdapter({ store, usageSurface: config.usageSurface });
  const resolved = await resolveChatBackend(config, deps);
  const client: AgentBackend = resolved.client;

  // The kit controller swallows `thread_settings` into a private map and only
  // forwards `model` on recordUsage. Tee the backend's settings events into
  // the store adapter so usage rows still persist provider + serviceTier.
  client.onEvent((event) => {
    if (event.kind === "thread_settings") {
      adapter.setThreadModelMeta(event.settings.threadId, {
        modelProvider: event.settings.modelProvider ?? null,
        serviceTier: event.settings.serviceTier ?? null
      });
    }
  });

  const broadcast = makeChatBroadcast(config.channels, config.send);

  const controller = new ChatThreadController<Settings>({
    client,
    store: adapter,
    readSettings: config.readSettings,
    broadcast,
    buildSystemPrompt: config.buildSystemPrompt,
    buildTurnContext: config.buildTurnContext,
    // PwrSnap's catalog/dispatch are typed against @pwrsnap's protocol package;
    // the kit is typed against @pwrdrvr's. The two DynamicTool* shapes are
    // structurally identical (define-tool already round-trips them) — cast at
    // this single boundary to the kit dep's own field types.
    catalog: config.catalog as unknown as NonNullable<
      ChatThreadControllerDeps<Settings>["catalog"]
    >,
    dispatchToolCall: config.dispatchToolCall as unknown as NonNullable<
      ChatThreadControllerDeps<Settings>["dispatchToolCall"]
    >,
    toolLabels: config.toolLabels,
    // Default Access.
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    serviceName: PWRSNAP_SERVICE_NAME,
    threadConfig: config.threadConfig,
    threadEnvironments: config.threadEnvironments,
    // ACP: this surface's MCP tools ride per-thread on the SHARED agent process,
    // and the controller skips single-handler registration so it doesn't clobber
    // a sibling surface sharing the same client. (Both undefined for Codex.)
    ...(resolved.threadMcpServers !== undefined
      ? { threadMcpServers: resolved.threadMcpServers }
      : {}),
    ...(resolved.shared ? { backendClientShared: true } : {}),
    // Per-surface defaults from Settings → AI. `effort` defaults to
    // "medium" (the kit's own default) when the surface has no pinned
    // reasoning; `model` is only forwarded when set so an unset surface
    // uses the backend's default rather than pinning one. The Codex
    // `modelProvider` is no longer driven here — a chat surface's
    // `provider` selects the BACKEND (Codex vs ACP), not a Codex
    // sub-provider; both backends ignore options they don't use.
    effort: config.effort ?? "medium",
    ...(config.model !== undefined ? { model: config.model } : {}),
    logger: toAgentKitLogger(config.loggerScope)
  });
  controller.wire();

  return { controller };
}
