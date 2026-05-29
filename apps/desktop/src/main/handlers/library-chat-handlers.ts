// Bus handlers for the Library Chat (`codex:libraryChat:*`). Owns the
// lazily-constructed singleton ChatThreadController and wires it to the
// shared CodexThreadClient + ChatThreadStore with Default-Access policy.
//
// Default Access (plan §"Approval policy"): approvalPolicy "on-request",
// sandbox "workspace-write" scoped to the chat dir. The renderer surfaces
// any approval ServerRequest; the user decides. Full Access is never
// exposed.
//
// Storage: ~/Documents/PwrSnap/Chats/ (founder decision 2026-05-28).
// The .metadata_never_index Spotlight-skip sentinel is dropped by the
// store on first thread creation; the first write triggers the macOS TCC
// prompt for ~/Documents (expected — surfaced during onboarding).

import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import type {
  EventPayloads,
  PwrSnapError,
  Result,
  Settings,
  TypedEventChannel
} from "@pwrsnap/shared";
import { err, ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { CodexThreadClient } from "../ai/codex-thread-client";
import { ChatThreadStore } from "../ai/chat-thread-store";
import {
  ChatThreadController,
  type ChatBroadcast
} from "../ai/chat-thread-controller";
import { buildLibrarySystemPrompt } from "../ai/library-chat-system-prompt";
import { buildLibraryToolCatalog } from "../ai/library-tool-catalog";
import { dispatchLibraryToolCall } from "../ai/library-tool-catalog";

const log = getMainLogger("pwrsnap:library-chat-handlers");

export type LibraryChatSettingsReader = () => Promise<Settings>;

function aiError(code: string, message: string): Result<never, PwrSnapError> {
  return err({ kind: "ai", code, message });
}

/** Typed broadcast to every live BrowserWindow. */
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

export function registerLibraryChatHandlers(params?: {
  controller?: ChatThreadController;
  settingsReader?: LibraryChatSettingsReader;
}): void {
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;

  // Lazily build the singleton on first use. Building it eagerly would
  // spawn a codex child at app start even for users who never open chat;
  // lazy keeps startup lean and lets the first dispatch surface a clean
  // "codex unreachable" error instead of a boot crash.
  let controller: ChatThreadController | null = params?.controller ?? null;
  const getController = async (): Promise<ChatThreadController> => {
    if (controller !== null) return controller;
    const settings = await settingsReader();
    const chatsDir = join(app.getPath("documents"), "PwrSnap", "Chats");
    const client = new CodexThreadClient({ command: codexCommandForSettings(settings) });
    const store = new ChatThreadStore({ chatsDir });
    controller = new ChatThreadController({
      client,
      store,
      readSettings: settingsReader,
      broadcast,
      buildSystemPrompt: buildLibrarySystemPrompt,
      catalog: buildLibraryToolCatalog(),
      dispatchToolCall: dispatchLibraryToolCall,
      // Default Access.
      approvalPolicy: "on-request",
      sandbox: "workspace-write"
    });
    controller.wire();
    return controller;
  };

  bus.register("codex:libraryChat:list", async (req) => {
    try {
      const c = await getController();
      const threads = await c.listThreads(req.includeArchived ?? false);
      return ok({ threads });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:create", async (req) => {
    try {
      const c = await getController();
      const view = await c.createThread(req.name);
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:send", async (req) => {
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
      if (message.includes("rate limit")) {
        return aiError("rate_limited", message);
      }
      if (message.includes("already in progress")) {
        return aiError("turn_in_progress", message);
      }
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:history", async (req) => {
    try {
      const c = await getController();
      const messages = await c.getHistory(req.threadId);
      return ok({ messages });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:rename", async (req) => {
    try {
      const c = await getController();
      const view = await c.rename(req.threadId, req.name);
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:archive", async (req) => {
    try {
      const c = await getController();
      const view = await c.archive(req.threadId, req.archived);
      return ok(view);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:interrupt", async (req) => {
    try {
      const c = await getController();
      await c.interrupt(req.threadId);
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:approval", async (req) => {
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
  log.warn("library chat handler failed", { message });
  return err({
    kind: "ai",
    code: "codex_unreachable",
    message: `Library chat is unavailable: ${message}`,
    cause
  });
}
