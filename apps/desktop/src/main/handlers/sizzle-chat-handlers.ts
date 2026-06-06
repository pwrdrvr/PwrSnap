// Bus verbs for the Sizzle composer chat — the second surface on the
// shared chat substrate. Mirrors library-chat-handlers.ts: a lazily-built
// ChatThreadController singleton, the eight codex:sizzleChat:* verbs, and
// the same Default-Access posture (workspace-write + on-request, no
// exec environments, web search disabled). The agent's actions are the
// Sizzle tool catalog (see makeSizzleChatTools), scoped to the thread's
// project.

import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import type { ChatThreadController } from "@pwrdrvr/agent-client";
import type {
  EventPayloads,
  PwrSnapError,
  Result,
  Settings,
  TypedEventChannel
} from "@pwrsnap/shared";
import { EVENT_CHANNELS, err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { resolveCodexThreadConfigForCommand } from "../ai/codex-thread-config";
import { ChatThreadStore } from "../ai/chat-thread-store";
import {
  buildChatSurface,
  chatControllerSignature,
  chatSurfaceDefaultsFromSettings,
  toKitApprovalDecision
} from "../ai/chat-controller-factory";
import {
  createChatControllerCache,
  type ChatControllerCache
} from "../ai/chat-controller-cache";
import { codexEnvForProfile } from "../ai/agent-kit-bindings";
import type { ChatBroadcast, ChatChannelSet } from "../ai/chat-event-adapter";
import { toChatMessage, toLibraryThreadView } from "../ai/chat-event-adapter";
import {
  buildSizzleSystemPrompt,
  buildSizzleTurnContext
} from "../ai/sizzle-chat-system-prompt";
import { makeSizzleChatTools, SIZZLE_TOOL_LABELS } from "../ai/sizzle-tool-catalog";

const log = getMainLogger("pwrsnap:sizzle-chat-handlers");

/** The Sizzle surface's broadcast channels (controller is parameterized). */
const SIZZLE_CHAT_CHANNELS: ChatChannelSet = {
  threadUpdated: EVENT_CHANNELS.sizzleChatThreadUpdated,
  streamDelta: EVENT_CHANNELS.sizzleChatStreamDelta,
  toolCall: EVENT_CHANNELS.sizzleChatToolCall,
  messageCommitted: EVENT_CHANNELS.sizzleChatMessageCommitted,
  turnInterrupted: EVENT_CHANNELS.sizzleChatTurnInterrupted,
  approvalRequested: EVENT_CHANNELS.sizzleChatApprovalRequested
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
    win.webContents.send(channel, payload);
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
// A test-injected controller pins the surface to that instance (no rebuild, no
// real Codex child) — existing handler tests rely on this.
let injectedSizzleController: ChatThreadController<Settings> | null = null;
let sizzleCache: ChatControllerCache<ChatThreadController<Settings>> | null = null;

/** The signature-aware cache that rebuilds the Sizzle controller whenever the
 *  backend-affecting settings change (provider / model / reasoning / codex
 *  command+profile). Created on first use, capturing the current settings
 *  reader. Mirrors the Library surface. */
function getSizzleCache(): ChatControllerCache<ChatThreadController<Settings>> {
  if (sizzleCache !== null) return sizzleCache;
  const readSettings = sizzleSettingsReader;
  sizzleCache = createChatControllerCache<ChatThreadController<Settings>>({
    readSettings,
    signature: (settings) => chatControllerSignature(settings, "sizzleChat"),
    build: async (settings) => {
      const chatsDir = join(app.getPath("documents"), "PwrSnap", "Chats");
      // A throwaway store solely to resolve a thread's anchored project id for
      // the Sizzle tool catalog. The controller's own store (built inside
      // buildChatSurface) is what persists threads; this reads the same SQLite
      // index/rows, so the lookup is consistent.
      const projectStore = new ChatThreadStore({ chatsDir });
      const tools = makeSizzleChatTools({
        // The thread's anchor holds the project id; mutations bind to it.
        resolveProjectId: async (threadId) =>
          (await projectStore.get(threadId))?.anchorCaptureId ?? null
      });
      const command = codexCommandForSettings(settings);
      const env = codexEnvForProfile(settings.codex.profile);
      const surface = await buildChatSurface({
        command,
        env,
        chatsDir,
        readSettings,
        channels: SIZZLE_CHAT_CHANNELS,
        send: broadcast,
        usageSurface: "sizzle-chat",
        buildSystemPrompt: ({ settings: s, anchorId }) =>
          buildSizzleSystemPrompt({ settings: s, anchorCaptureId: anchorId }),
        buildTurnContext: buildSizzleTurnContext,
        toolLabels: SIZZLE_TOOL_LABELS,
        catalog: tools.catalog,
        dispatchToolCall: tools.dispatch,
        // Overlay shape selected for the running Codex build (schema churns).
        threadConfig: resolveCodexThreadConfigForCommand(command, env),
        threadEnvironments: SIZZLE_CHAT_THREAD_ENVIRONMENTS,
        // Per-surface default provider / model / reasoning from Settings → AI
        // (`ai.defaults.sizzleChat`). `provider` selects the chat backend
        // (Codex vs an enabled ACP agent); unset falls back to Codex / kit.
        ...chatSurfaceDefaultsFromSettings(settings.ai.defaults.sizzleChat),
        loggerScope: "pwrsnap:sizzle-chat"
      });
      return { controller: surface.controller, dispose: surface.dispose };
    }
  });
  return sizzleCache;
}

/** Lazily build the Sizzle controller, rebuilding when the backend config
 *  changes — no codex child at app start for users who never open the
 *  composer chat. */
async function getSizzleController(): Promise<ChatThreadController<Settings>> {
  if (injectedSizzleController !== null) return injectedSizzleController;
  return getSizzleCache().get();
}

/** Fork every chat thread anchored to a source project into a freshly-anchored
 *  set on a target project — invoked when a reel is duplicated so its chats come
 *  along. Delegates to the kit controller's `forkThreadsForAnchor`. */
export async function forkProjectChats(
  sourceProjectId: string,
  targetProjectId: string
): Promise<void> {
  const controller = await getSizzleController();
  await controller.forkThreadsForAnchor({
    sourceAnchorId: sourceProjectId,
    targetAnchorId: targetProjectId
  });
}

export function registerSizzleChatHandlers(params?: {
  controller?: ChatThreadController<Settings>;
  settingsReader?: SizzleChatSettingsReader;
}): void {
  sizzleSettingsReader = params?.settingsReader ?? defaultSettingsReader;
  injectedSizzleController = params?.controller ?? null;
  // Re-registration (tests) starts from a fresh cache so it doesn't reuse a
  // controller built against a previous settings reader.
  sizzleCache = null;

  bus.register("codex:sizzleChat:list", async (req) => {
    // Sizzle threads are ALWAYS project-scoped. The substrate's
    // chat_threads table is shared with the Library surface, so an
    // unscoped list would mix in Library (or null-anchor) threads. A
    // Sizzle thread always carries a project id in its anchor, so a
    // missing/empty anchor can only mean "nothing for this surface".
    if (typeof req.anchorCaptureId !== "string" || req.anchorCaptureId.length === 0) {
      return ok({ threads: [] });
    }
    try {
      const c = await getSizzleController();
      const threads = await c.listThreads({
        includeArchived: req.includeArchived ?? false,
        anchorId: req.anchorCaptureId
      });
      return ok({ threads: threads.map((t) => toLibraryThreadView(t)) });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:create", async (req) => {
    try {
      const c = await getSizzleController();
      const view = await c.createThread({
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
      });
      return ok(toLibraryThreadView(view));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:send", async (req) => {
    try {
      const c = await getSizzleController();
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

  bus.register("codex:sizzleChat:history", async (req) => {
    try {
      const c = await getSizzleController();
      const messages = await c.getHistory(req.threadId);
      return ok({ messages: messages.map(toChatMessage) });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:rename", async (req) => {
    try {
      const c = await getSizzleController();
      const view = await c.rename(req.threadId, req.name);
      return ok(toLibraryThreadView(view));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:archive", async (req) => {
    try {
      const c = await getSizzleController();
      const view = await c.archive(req.threadId, req.archived);
      return ok(toLibraryThreadView(view));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:interrupt", async (req) => {
    try {
      const c = await getSizzleController();
      await c.interrupt(req.threadId);
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:approval", async (req) => {
    try {
      const c = await getSizzleController();
      await c.resolveApproval({
        threadId: req.threadId,
        turnId: req.turnId,
        approvalId: req.approvalId,
        decision: toKitApprovalDecision(req.decision)
      });
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
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
  return join(app.getPath("documents"), "PwrSnap", "Chats");
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
    await store.delete(t.threadId);
  }
}
