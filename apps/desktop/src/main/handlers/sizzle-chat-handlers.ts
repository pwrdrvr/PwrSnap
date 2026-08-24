// Bus verbs for the Sizzle composer chat — the second surface on the
// shared chat substrate. Mirrors library-chat-handlers.ts: a lazily-built
// ChatThreadController singleton, the eight codex:sizzleChat:* verbs, and
// the same Default-Access posture (workspace-write + on-request, no
// exec environments, web search disabled). The agent's actions are the
// Sizzle tool catalog (see makeSizzleChatTools), scoped to the thread's
// project.

import { app, BrowserWindow } from "electron";
import type { ChatThreadController } from "@pwrdrvr/agent-client";
import type {
  ChatThreadSidecar,
  EventPayloads,
  PwrSnapError,
  Result,
  Settings,
  TypedEventChannel
} from "@pwrsnap/shared";
import {
  acpAgentIdFromThreadId,
  chatApprovalResponseSchema,
  EVENT_CHANNELS,
  err,
  ok
} from "@pwrsnap/shared";
import { bus, type CommandDispatchOptions } from "../command-bus";
import { getMainLogger } from "../log";
import { resolveCodexThreadConfigForCommand } from "../ai/codex-thread-config";
import { ChatThreadStore, rootKeyedChatThreadStore } from "../ai/chat-thread-store";
import { buildChatSurface } from "../ai/chat-controller-factory";
import {
  createKeyedChatControllerCache,
  type ChatBackendConfig,
  type KeyedChatControllerCache
} from "../ai/chat-controller-cache";
import { codexEnvForProfile } from "../ai/agent-kit-bindings";
import type { ChatBroadcast, ChatChannelSet } from "../ai/chat-event-adapter";
import { toLibraryThreadView } from "../ai/chat-event-adapter";
import {
  buildSizzleSystemPrompt,
  buildSizzleTurnContext
} from "../ai/sizzle-chat-system-prompt";
import { makeSizzleChatTools, SIZZLE_TOOL_LABELS } from "../ai/sizzle-tool-catalog";
import { getChatsRoot } from "../persistence/paths";
import { ChatApprovalBroker } from "../ai/chat-approval-broker";
import { ChatThreadAccess } from "../ai/chat-thread-access";

const log = getMainLogger("pwrsnap:sizzle-chat-handlers");
// Tool callbacks outlive sendMessage(), so retain the latest turn origin.
const activeSizzleToolContexts = new Map<string, CommandDispatchOptions>();

/** The Sizzle surface's broadcast channels (controller is parameterized). */
const SIZZLE_CHAT_CHANNELS: ChatChannelSet = {
  threadUpdated: EVENT_CHANNELS.sizzleChatThreadUpdated,
  streamDelta: EVENT_CHANNELS.sizzleChatStreamDelta,
  toolCall: EVENT_CHANNELS.sizzleChatToolCall,
  messageCommitted: EVENT_CHANNELS.sizzleChatMessageCommitted,
  turnInterrupted: EVENT_CHANNELS.sizzleChatTurnInterrupted,
  approvalRequested: EVENT_CHANNELS.sizzleChatApprovalRequested,
  approvalResolved: EVENT_CHANNELS.sizzleChatApprovalResolved,
  approvalSuperseded: EVENT_CHANNELS.sizzleChatApprovalSuperseded
};

// Tool-only agent (like Library): drop Codex's env-gated shell / exec /
// apply_patch tools and disable Codex prompt/tool scaffolding unrelated to
// PwrSnap's render dynamic tool. Rendering is a tool, not a shell call, so
// the agent needs no exec environment.
const SIZZLE_CHAT_THREAD_ENVIRONMENTS: unknown[] = [];

export type SizzleChatSettingsReader = () => Promise<Settings>;

function aiError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "ai", code, message });
}

const broadcast: ChatBroadcast = <C extends TypedEventChannel>(
  channel: C,
  payload: EventPayloads[C]
): void => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (cause) {
      log.warn("sizzle chat window broadcast failed", {
        channel,
        windowId: win.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
};

async function defaultSettingsReader(): Promise<Settings> {
  const result = await bus.dispatch("settings:read", {}, { principal: "ipc" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function codexCommandForSettings(settings: Settings): string {
  return settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
    ? settings.codex.pinnedPath
    : "codex";
}

// Module-level so the `forkProjectChats` export (called when a reel is
// duplicated) shares the same lazily-built controller as the bus verbs.
let sizzleSettingsReader: SizzleChatSettingsReader = defaultSettingsReader;
// A test-injected controller pins every config to that instance (no rebuild, no
// real Codex child) — existing handler tests rely on this.
let injectedSizzleController: ChatThreadController<Settings> | null = null;
let sizzleCache: KeyedChatControllerCache<ChatThreadController<Settings>> | null = null;
// Root-keyed so it follows a runtime captures-location flip (Documents denial
// or a Settings change) instead of writing threads to the old root.
let sizzleStore: (() => ChatThreadStore) | null = null;
let sizzleAccess: ChatThreadAccess | null = null;
let sizzleApprovalBroker: ChatApprovalBroker | null = null;

function getSizzleStore(): ChatThreadStore {
  sizzleStore ??= rootKeyedChatThreadStore(getChatsRoot);
  return sizzleStore();
}

function getSizzleAccess(): ChatThreadAccess {
  sizzleAccess ??= new ChatThreadAccess({
    surface: "sizzle",
    store: getSizzleStore,
    loggerScope: "pwrsnap:sizzle-chat-access"
  });
  return sizzleAccess;
}

function getSizzleApprovalBroker(): ChatApprovalBroker {
  sizzleApprovalBroker ??= new ChatApprovalBroker({
    surface: "sizzle",
    loggerScope: "pwrsnap:sizzle-chat-approval",
    emitResolved: (event) => {
      if (getSizzleAccess().shouldBroadcastToHuman(event.threadId)) {
        broadcast(SIZZLE_CHAT_CHANNELS.approvalResolved, event);
      }
    },
    emitSuperseded: (event) => {
      if (getSizzleAccess().shouldBroadcastToHuman(event.threadId)) {
        broadcast(SIZZLE_CHAT_CHANNELS.approvalSuperseded, event);
      }
    },
    pendingChanged: (threadId) => {
      const view = getSizzleAccess().humanViewForThread(threadId);
      const broker = sizzleApprovalBroker;
      if (view !== null && broker !== null) {
        broadcast(SIZZLE_CHAT_CHANNELS.threadUpdated, {
          thread: broker.decorateThread(view)
        });
      }
    }
  });
  return sizzleApprovalBroker;
}

/** ONE Sizzle controller per distinct (provider, model, reasoning) config, so
 *  each thread routes to the backend it was created with. Mirrors the Library
 *  surface; created on first use, capturing the current settings reader. */
function getSizzleCache(): KeyedChatControllerCache<ChatThreadController<Settings>> {
  if (sizzleCache !== null) return sizzleCache;
  const readSettings = sizzleSettingsReader;
  sizzleCache = createKeyedChatControllerCache<ChatThreadController<Settings>>({
    readSettings,
    settingsSignature: (s) =>
      JSON.stringify({
        command: codexCommandForSettings(s),
        profile: s.codex.profile ?? null,
        acpAgents: s.ai.acp.agents ?? null,
        acpEnabled: s.ai.acp.enabledAgentIds ?? null,
        // The chats root moves at runtime when a Documents denial flips the
        // captures-location fallback. Keying on it disposes + rebuilds every
        // controller against the new root, instead of leaving cached ones
        // writing threads to the location that just proved inaccessible.
        chatsDir: getChatsRoot()
      }),
    build: async (config, settings) => {
      const chatsDir = getChatsRoot();
      const projectStore = new ChatThreadStore({ chatsDir });
      const tools = makeSizzleChatTools({
        resolveProjectId: async (threadId) =>
          (await projectStore.get(threadId))?.anchorCaptureId ?? null
      }, (threadId) => activeSizzleToolContexts.get(threadId) ?? { principal: "ipc" });
      const command = codexCommandForSettings(settings);
      const env = codexEnvForProfile(settings.codex.profile);
      const surface = await buildChatSurface({
        command,
        env,
        chatsDir,
        readSettings,
        channels: SIZZLE_CHAT_CHANNELS,
        send: broadcast,
        approvalBroker: getSizzleApprovalBroker(),
        threadAccess: getSizzleAccess(),
        usageSurface: "sizzle-chat",
        buildSystemPrompt: ({ settings: s, anchorId }) =>
          buildSizzleSystemPrompt({ settings: s, anchorCaptureId: anchorId }),
        buildTurnContext: buildSizzleTurnContext,
        toolLabels: SIZZLE_TOOL_LABELS,
        catalog: tools.catalog,
        dispatchToolCall: tools.dispatch,
        threadConfig: resolveCodexThreadConfigForCommand(command, env),
        threadEnvironments: SIZZLE_CHAT_THREAD_ENVIRONMENTS,
        // The THREAD's chosen config (null → backend default).
        ...(config.provider !== null && config.provider !== "" ? { provider: config.provider } : {}),
        ...(config.model !== null && config.model !== "" ? { model: config.model } : {}),
        ...(config.reasoning !== null && config.reasoning !== "" ? { effort: config.reasoning } : {}),
        loggerScope: "pwrsnap:sizzle-chat"
      });
      return { controller: surface.controller, dispose: surface.dispose };
    }
  });
  return sizzleCache;
}

/** Route to the controller for a backend config (injected wins in tests). */
async function sizzleControllerFor(
  config: ChatBackendConfig
): Promise<ChatThreadController<Settings>> {
  if (injectedSizzleController !== null) return injectedSizzleController;
  return getSizzleCache().get(config);
}

/** The Sizzle surface's Settings-default config. */
async function defaultSizzleConfig(): Promise<ChatBackendConfig> {
  const d = (await sizzleSettingsReader()).ai?.defaults?.sizzleChat;
  return {
    provider: d?.provider !== undefined && d.provider !== "" ? d.provider : "codex",
    model: d?.model !== undefined && d.model !== "" ? d.model : null,
    reasoning: d?.reasoning ?? null
  };
}

/** An existing thread's persisted config, else provider-from-id + defaults. */
function configForSizzleSidecar(sidecar: ChatThreadSidecar): ChatBackendConfig {
  const agentId = acpAgentIdFromThreadId(sidecar.threadId);
  return {
    provider: sidecar.provider ?? (agentId !== null ? `acp:${agentId}` : "codex"),
    model: sidecar.model,
    reasoning: sidecar.reasoning
  };
}

/** Back-compat for `forkProjectChats`: any controller can drive the fork
 *  (it operates on the shared store). Uses the surface default config. */
async function getSizzleController(): Promise<ChatThreadController<Settings>> {
  return sizzleControllerFor(await defaultSizzleConfig());
}

/** Fork every chat thread anchored to a source project into a freshly-anchored
 *  set on a target project — invoked when a reel is duplicated so its chats come
 *  along. Delegates to the kit controller's `forkThreadsForAnchor`. */
export async function forkProjectChats(
  sourceProjectId: string,
  targetProjectId: string
): Promise<void> {
  const controller = await getSizzleController();
  // Project duplication is a human app operation. Filter the controller's
  // adapter list/create context to NULL ownership so an MCP-owned journal can
  // never be copied into a human-visible thread.
  await getSizzleAccess().runCreate(null, () =>
    controller.forkThreadsForAnchor({
      sourceAnchorId: sourceProjectId,
      targetAnchorId: targetProjectId
    }).then(() => undefined)
  );
}

export function registerSizzleChatHandlers(params?: {
  controller?: ChatThreadController<Settings>;
  settingsReader?: SizzleChatSettingsReader;
  /** Unit-test seams. Production always uses the root-keyed store and broker. */
  store?: ChatThreadStore;
  access?: ChatThreadAccess;
  approvalBroker?: ChatApprovalBroker;
}): void {
  sizzleSettingsReader = params?.settingsReader ?? defaultSettingsReader;
  injectedSizzleController = params?.controller ?? null;
  // Re-registration (tests) starts from a fresh cache + store so it doesn't
  // reuse state built against a previous settings reader.
  sizzleCache = null;
  sizzleStore = params?.store !== undefined ? () => params.store as ChatThreadStore : null;
  sizzleAccess = params?.access ?? null;
  sizzleApprovalBroker = params?.approvalBroker ?? null;
  app?.once?.("before-quit", () => {
    if (sizzleCache !== null) void sizzleCache.reset();
  });

  bus.register("codex:sizzleChat:list", async (req, ctx) => {
    const actor = getSizzleAccess().actorFor(ctx);
    if (!actor.ok) return actor;
    // Sizzle threads are ALWAYS project-scoped. The substrate's
    // chat_threads table is shared with the Library surface, so an
    // unscoped list would mix in Library (or null-anchor) threads. A
    // Sizzle thread always carries a project id in its anchor, so a
    // missing/empty anchor can only mean "nothing for this surface".
    if (typeof req.anchorCaptureId !== "string" || req.anchorCaptureId.length === 0) {
      return ok({ threads: [] });
    }
    const listed = await getSizzleAccess().list(ctx, {
      includeArchived: req.includeArchived ?? false,
      anchorCaptureId: req.anchorCaptureId
    });
    if (!listed.ok) return listed;
    return ok({
      threads: listed.value.map((sidecar) =>
        getSizzleApprovalBroker().decorateThread(getSizzleAccess().viewFor(sidecar))
      )
    });
  });

  bus.register("codex:sizzleChat:create", async (req, ctx) => {
    try {
      if (typeof req.anchorCaptureId !== "string" || !req.anchorCaptureId.startsWith("sz_")) {
        return err({
          kind: "validation",
          code: "sizzle_chat_project_required",
          message: "A Sizzle chat must belong to a Sizzle project."
        });
      }
      const projectId = req.anchorCaptureId;
      const actor = getSizzleAccess().actorFor(ctx);
      if (!actor.ok) return actor;
      const d = await defaultSizzleConfig();
      const config: ChatBackendConfig = {
        provider: req.provider !== undefined && req.provider !== "" ? req.provider : d.provider,
        model: req.model !== undefined && req.model !== "" ? req.model : d.model,
        reasoning: req.reasoning !== undefined && req.reasoning !== "" ? req.reasoning : d.reasoning
      };
      const c = await sizzleControllerFor(config);
      const view = await getSizzleAccess().runCreate(actor.value.ownerClientId, () =>
        c.createThread({
          ...(req.name !== undefined ? { name: req.name } : {}),
          anchorId: projectId
        })
      );
      // Production's adapter persisted config + exact owner in the INITIAL
      // INSERT before the first event; read the authoritative row back.
      if (injectedSizzleController === null) {
        const sidecar = await getSizzleAccess().require(view.threadId, ctx);
        if (!sidecar.ok) return sidecar;
        return ok(
          getSizzleApprovalBroker().decorateThread(getSizzleAccess().viewFor(sidecar.value))
        );
      }
      return ok(getSizzleApprovalBroker().decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:send", async (req, ctx) => {
    try {
      const authorized = await getSizzleAccess().require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      if (
        req.anchorCaptureId !== undefined &&
        req.anchorCaptureId !== authorized.value.anchorCaptureId
      ) {
        return err({
          kind: "validation",
          code: "sizzle_chat_project_mismatch",
          message: "This Sizzle chat belongs to a different project."
        });
      }
      getSizzleApprovalBroker().openThread(req.threadId);
      const c = await sizzleControllerFor(configForSizzleSidecar(authorized.value));
      const commandContext: CommandDispatchOptions = {
        principal: ctx.principal,
        ...(ctx.localAgent !== undefined ? { localAgent: ctx.localAgent } : {}),
        ...(ctx.sourceWindowId !== undefined ? { sourceWindowId: ctx.sourceWindowId } : {}),
        ...(ctx.sourceBounds !== undefined ? { sourceBounds: ctx.sourceBounds } : {})
      };
      activeSizzleToolContexts.set(req.threadId, commandContext);
      const result = await c.sendMessage({
        threadId: req.threadId,
        text: req.text,
        ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
      });
      return ok(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("rate limit")) return aiError("rate_limited", message);
      if (message.includes("already in progress")) return aiError("turn_in_progress", message);
      if (message.includes("thread not found")) {
        return aiError("thread_not_found", "This chat thread could not be reopened.");
      }
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:history", async (req, ctx) => {
    const authorized = await getSizzleAccess().require(req.threadId, ctx);
    if (!authorized.ok) return authorized;
    const messages = await getSizzleAccess().history(authorized.value);
    return messages.ok ? ok({ messages: messages.value }) : messages;
  });

  bus.register("codex:sizzleChat:rename", async (req, ctx) => {
    try {
      const authorized = await getSizzleAccess().require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const config = configForSizzleSidecar(authorized.value);
      const c = await sizzleControllerFor(config);
      const view = await c.rename(req.threadId, req.name);
      return ok(getSizzleApprovalBroker().decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:archive", async (req, ctx) => {
    try {
      const authorized = await getSizzleAccess().require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const config = configForSizzleSidecar(authorized.value);
      const c = await sizzleControllerFor(config);
      const view = await c.archive(req.threadId, req.archived);
      // Commit broker lifecycle only after the controller/store transition is
      // acknowledged, preserving live approvals on archive failure and the
      // closed state on unarchive failure.
      if (req.archived) await getSizzleApprovalBroker().closeThread(req.threadId);
      else getSizzleApprovalBroker().openThread(req.threadId);
      return ok(getSizzleApprovalBroker().decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:interrupt", async (req, ctx) => {
    try {
      const authorized = await getSizzleAccess().require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const c = await sizzleControllerFor(configForSizzleSidecar(authorized.value));
      await c.interrupt(req.threadId);
      await getSizzleApprovalBroker().closeThread(req.threadId);
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:approval", async (req, ctx) => {
    const response = chatApprovalResponseSchema.safeParse(req);
    if (!response.success) {
      return err({
        kind: "validation",
        code: "invalid_approval_response",
        message: "The approval response was malformed."
      });
    }
    const authorized = await getSizzleAccess().require(response.data.threadId, ctx);
    if (!authorized.ok) return authorized;
    return getSizzleApprovalBroker().resolve({
      threadId: response.data.threadId,
      turnId: response.data.turnId,
      approvalId: response.data.approvalId,
      decision: response.data.decision
    });
  });
}

function codexUnreachable(cause: unknown): Result<never, PwrSnapError> {
  const message = cause instanceof Error ? cause.message : String(cause);
  log.warn("sizzle chat handler failed", { message });
  return err({
    kind: "ai",
    code: "codex_unreachable",
    message: `Sizzle chat is unavailable: ${message}`,
    cause
  });
}

function chatsDirPath(): string {
  return getChatsRoot();
}

/**
 * Delete every chat thread (index row + on-disk dir) anchored to a Sizzle
 * project. Called from the sizzle:delete cascade so deleting a reel leaves
 * no orphan chat dir (locked decision #6). Best-effort + idempotent; uses
 * a throwaway store over the shared DB (no controller / codex needed).
 */
export async function cleanupProjectChats(projectId: string): Promise<void> {
  const store = new ChatThreadStore({ chatsDir: chatsDirPath() });
  const threads = await store.list({ includeArchived: true, anchorCaptureId: projectId });
  for (const t of threads) {
    if (sizzleApprovalBroker !== null) {
      await sizzleApprovalBroker.closeThread(t.threadId);
    }
    await store.delete(t.threadId);
    sizzleAccess?.forget(t.threadId);
  }
}
