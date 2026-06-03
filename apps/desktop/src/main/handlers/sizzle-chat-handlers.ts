// Bus verbs for the Sizzle composer chat — the second surface on the
// shared chat substrate. Mirrors library-chat-handlers.ts: a lazily-built
// ChatThreadController singleton, the eight codex:sizzleChat:* verbs, and
// the same Default-Access posture (workspace-write + on-request, no
// exec environments, web search disabled). The agent's actions are the
// Sizzle tool catalog (see makeSizzleChatTools), scoped to the thread's
// project.

import { app, BrowserWindow } from "electron";
import { join } from "node:path";
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
import { PWRSNAP_CODEX_THREAD_CONFIG } from "../ai/codex-thread-config";
import { CodexThreadClient } from "../ai/codex-thread-client";
import { ChatThreadStore } from "../ai/chat-thread-store";
import {
  ChatThreadController,
  type ChatBroadcast,
  type ChatChannelSet
} from "../ai/chat-thread-controller";
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
const SIZZLE_CHAT_THREAD_CONFIG = PWRSNAP_CODEX_THREAD_CONFIG;
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

export function registerSizzleChatHandlers(params?: {
  controller?: ChatThreadController;
  settingsReader?: SizzleChatSettingsReader;
}): void {
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;

  // Lazily built on first use — no codex child at app start for users who
  // never open the composer chat.
  let controller: ChatThreadController | null = params?.controller ?? null;
  const getController = async (): Promise<ChatThreadController> => {
    if (controller !== null) return controller;
    const settings = await settingsReader();
    const chatsDir = join(app.getPath("documents"), "PwrSnap", "Chats");
    const client = new CodexThreadClient({ command: codexCommandForSettings(settings) });
    const store = new ChatThreadStore({ chatsDir });
    const tools = makeSizzleChatTools({
      // The thread's anchor holds the project id; mutations bind to it.
      resolveProjectId: async (threadId) => (await store.get(threadId))?.anchorCaptureId ?? null
    });
    controller = new ChatThreadController({
      client,
      store,
      readSettings: settingsReader,
      broadcast,
      buildSystemPrompt: buildSizzleSystemPrompt,
      channels: SIZZLE_CHAT_CHANNELS,
      usageSurface: "sizzle-chat",
      buildTurnContext: buildSizzleTurnContext,
      toolLabels: SIZZLE_TOOL_LABELS,
      catalog: tools.catalog,
      dispatchToolCall: tools.dispatch,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      threadConfig: SIZZLE_CHAT_THREAD_CONFIG,
      threadEnvironments: SIZZLE_CHAT_THREAD_ENVIRONMENTS
    });
    controller.wire();
    return controller;
  };

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
      const c = await getController();
      const threads = await c.listThreads({
        includeArchived: req.includeArchived ?? false,
        anchorCaptureId: req.anchorCaptureId
      });
      return ok({ threads });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:create", async (req) => {
    try {
      const c = await getController();
      const view = await c.createThread({
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.anchorCaptureId !== undefined ? { anchorCaptureId: req.anchorCaptureId } : {})
      });
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:send", async (req) => {
    try {
      const c = await getController();
      const result = await c.sendMessage({
        threadId: req.threadId,
        text: req.text,
        ...(req.anchorCaptureId !== undefined ? { anchorCaptureId: req.anchorCaptureId } : {})
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
      const c = await getController();
      const messages = await c.getHistory(req.threadId);
      return ok({ messages });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:rename", async (req) => {
    try {
      const c = await getController();
      const view = await c.rename(req.threadId, req.name);
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:archive", async (req) => {
    try {
      const c = await getController();
      const view = await c.archive(req.threadId, req.archived);
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:interrupt", async (req) => {
    try {
      const c = await getController();
      await c.interrupt(req.threadId);
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:sizzleChat:approval", async (req) => {
    try {
      const c = await getController();
      await c.resolveApproval({
        threadId: req.threadId,
        turnId: req.turnId,
        approvalId: req.approvalId,
        decision: req.decision
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
 * Best-effort fork of visible Sizzle chat threads from one project to
 * another. The Codex fork preserves model-visible history; copying the local
 * journal preserves the PwrSnap chat transcript UI for the new reel.
 */
export async function forkProjectChats(
  sourceProjectId: string,
  targetProjectId: string
): Promise<void> {
  const store = new ChatThreadStore({ chatsDir: chatsDirPath() });
  const sourceThreads = await store.list({
    includeArchived: false,
    anchorCaptureId: sourceProjectId
  });
  if (sourceThreads.length === 0) return;

  const settings = await defaultSettingsReader();
  const client = new CodexThreadClient({ command: codexCommandForSettings(settings) });
  const baseInstructions = buildSizzleSystemPrompt({
    settings,
    anchorCaptureId: targetProjectId
  });

  try {
    for (const source of sourceThreads) {
      const preparedDir = await store.prepareThreadDir(source.name);
      let forked: {
        threadId: string;
        model: string;
        modelProvider: string;
        serviceTier: string | null;
      };
      try {
        forked = await client.forkThread({
          sourceThreadId: source.threadId,
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          baseInstructions,
          cwd: preparedDir.path,
          runtimeWorkspaceRoots: [preparedDir.path],
          config: SIZZLE_CHAT_THREAD_CONFIG
        });
      } catch (cause) {
        await store.discardPreparedThreadDir(preparedDir).catch(() => undefined);
        throw cause;
      }
      await client.clearThreadGitInfo(forked.threadId).catch((cause) => {
        log.warn("forked sizzle chat git metadata clear failed", {
          threadId: forked.threadId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
      await store.create({
        threadId: forked.threadId,
        name: source.name,
        anchorCaptureId: targetProjectId,
        preparedDir
      });
      const journal = await store.readJournal(source.threadId);
      for (const entry of journal) {
        await store.journalAppend(forked.threadId, entry);
      }
    }
  } finally {
    await client.close().catch((cause) => {
      log.warn("forked sizzle chat client close failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
  }
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
