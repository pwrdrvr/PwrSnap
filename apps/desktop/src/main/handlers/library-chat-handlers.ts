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
import { PWRSNAP_CODEX_THREAD_CONFIG } from "../ai/codex-thread-config";
import {
  buildChatSurface,
  toKitApprovalDecision
} from "../ai/chat-controller-factory";
import type { ChatBroadcast, ChatChannelSet } from "../ai/chat-event-adapter";
import { toChatMessage, toLibraryThreadView } from "../ai/chat-event-adapter";
import { buildLibrarySystemPrompt } from "../ai/library-chat-system-prompt";
import { buildLibraryToolCatalog } from "../ai/library-tool-catalog";
import { dispatchLibraryToolCall } from "../ai/library-tool-catalog";

const log = getMainLogger("pwrsnap:library-chat-handlers");

// PwrSnap's chat is an IMAGE assistant, not a coding agent. Codex has several
// separate prompt/tool sources, so we send both an empty environment list and a
// restrictive config overlay:
//
//   • EMPTY `environments` disables exec-environment access. The shell /
//     unified_exec + apply_patch tool specs are gated on
//     `tool_environment_mode().has_environment()` (spec_plan.rs:547/621),
//     and `from_count(0) == None == !has_environment` — so an empty list
//     drops all three. Our DYNAMIC tools are added before that gate, so
//     they survive.
//   • The config overlay disables web search plus Codex's permissions, apps,
//     skills, plugins, tool-suggest, hosted image-generation, goals, and
//     environment-context scaffolding.
//
// The system prompt also forbids claiming/using any coding capability,
// as a backstop. (`baseInstructions` already fully REPLACES Codex's
// default coding-agent prompt — the Responses `instructions` field is
// `base_instructions.text` verbatim.)
const LIBRARY_CHAT_THREAD_CONFIG = PWRSNAP_CODEX_THREAD_CONFIG;

/** The Library surface's broadcast channels (the controller is surface-
 *  parameterized — see `ChatChannelSet`). */
const LIBRARY_CHAT_CHANNELS: ChatChannelSet = {
  threadUpdated: EVENT_CHANNELS.libraryChatThreadUpdated,
  streamDelta: EVENT_CHANNELS.libraryChatStreamDelta,
  toolCall: EVENT_CHANNELS.libraryChatToolCall,
  messageCommitted: EVENT_CHANNELS.libraryChatMessageCommitted,
  turnInterrupted: EVENT_CHANNELS.libraryChatTurnInterrupted,
  approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested
};

/** Friendly activity-chip labels for the Library tool catalog. */
const LIBRARY_TOOL_LABELS: Record<string, string> = {
  library_list: "Listed captures",
  library_search: "Searched the library",
  capture_metadata: "Read capture details",
  read_ocr_text: "Read the capture text",
  list_layers: "Read the layers",
  list_layer_capabilities: "Checked capabilities",
  render_composite: "Looked at the canvas",
  open_in_library: "Opened in Library",
  open_editor: "Opened the editor",
  draw_arrow: "Drew an arrow",
  draw_text: "Added a text label",
  draw_highlight: "Added a highlight",
  draw_rect: "Drew a rectangle",
  draw_square: "Drew a square",
  draw_circle: "Drew a circle",
  draw_oval: "Drew an oval",
  draw_parallelogram: "Drew a parallelogram",
  redact: "Blacked out a region",
  blur: "Blurred a region",
  crop: "Cropped the image",
  update_layer: "Updated a layer",
  delete_layer: "Deleted a layer",
  reorder_layer: "Reordered a layer",
  reorder_layers: "Reordered layers",
  add_tag: "Added a tag",
  remove_tag: "Removed a tag"
};

/** The per-turn active-capture context (L3), sent as its own leading
 *  turn item — NOT the committed user message. The `<runtime_context>`
 *  wrapper + the "not user-authored" note tell the agent this is app-
 *  generated framing, not the user's words. Resolves "this image / here /
 *  it" to the capture the user is viewing so edit tools get the right
 *  `capture_id`. Injected into the shared controller via `buildTurnContext`. */
function buildCurrentCaptureContext(captureId: string): string {
  return (
    `<runtime_context source="pwrsnap" note="runtime-generated, not user-authored">\n` +
    `<current_capture id="${captureId}">\n` +
    `The user is viewing this capture right now. "this", "this image", ` +
    `"this capture", "here", "it" all refer to ${captureId}. Pass ` +
    `capture_id="${captureId}" to your edit / redact / draw / metadata ` +
    `tools unless the user explicitly names a different capture — do NOT ` +
    `pick a capture from library_list when this block is present.\n` +
    `</current_capture>\n` +
    `</runtime_context>`
  );
}
const LIBRARY_CHAT_THREAD_ENVIRONMENTS: unknown[] = [];

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
  controller?: ChatThreadController<Settings>;
  settingsReader?: LibraryChatSettingsReader;
}): void {
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;

  // Lazily build the singleton on first use. Building it eagerly would
  // spawn a codex child at app start even for users who never open chat;
  // lazy keeps startup lean and lets the first dispatch surface a clean
  // "codex unreachable" error instead of a boot crash.
  let controller: ChatThreadController<Settings> | null = params?.controller ?? null;
  const getController = async (): Promise<ChatThreadController<Settings>> => {
    if (controller !== null) return controller;
    const settings = await settingsReader();
    const chatsDir = join(app.getPath("documents"), "PwrSnap", "Chats");
    const surface = buildChatSurface({
      command: codexCommandForSettings(settings),
      chatsDir,
      readSettings: settingsReader,
      channels: LIBRARY_CHAT_CHANNELS,
      send: broadcast,
      usageSurface: "library-chat",
      // The kit's prompt builder passes `anchorId`; PwrSnap's builder takes
      // `anchorCaptureId` — same value, renamed.
      buildSystemPrompt: ({ settings: s, anchorId }) =>
        buildLibrarySystemPrompt({ settings: s, anchorCaptureId: anchorId }),
      buildTurnContext: buildCurrentCaptureContext,
      toolLabels: LIBRARY_TOOL_LABELS,
      catalog: buildLibraryToolCatalog(),
      dispatchToolCall: dispatchLibraryToolCall,
      // Drop Codex's built-in coding tools — PwrSnap chat is image-only.
      threadConfig: LIBRARY_CHAT_THREAD_CONFIG,
      threadEnvironments: LIBRARY_CHAT_THREAD_ENVIRONMENTS,
      loggerScope: "pwrsnap:library-chat"
    });
    controller = surface.controller;
    return controller;
  };

  bus.register("codex:libraryChat:list", async (req) => {
    try {
      const c = await getController();
      const threads = await c.listThreads({
        includeArchived: req.includeArchived ?? false,
        ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
      });
      return ok({ threads: threads.map(toLibraryThreadView) });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:create", async (req) => {
    try {
      const c = await getController();
      const view = await c.createThread({
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
      });
      return ok(toLibraryThreadView(view));
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
        ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
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
      if (message.includes("thread not found")) {
        return aiError("thread_not_found", "This chat thread could not be reopened.");
      }
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:history", async (req) => {
    try {
      const c = await getController();
      const messages = await c.getHistory(req.threadId);
      return ok({ messages: messages.map(toChatMessage) });
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:rename", async (req) => {
    try {
      const c = await getController();
      const view = await c.rename(req.threadId, req.name);
      return ok(toLibraryThreadView(view));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:archive", async (req) => {
    try {
      const c = await getController();
      const view = await c.archive(req.threadId, req.archived);
      return ok(toLibraryThreadView(view));
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
  log.warn("library chat handler failed", { message });
  return err({
    kind: "ai",
    code: "codex_unreachable",
    message: `Library chat is unavailable: ${message}`,
    cause
  });
}
