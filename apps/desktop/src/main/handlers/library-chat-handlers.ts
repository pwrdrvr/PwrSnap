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
import type { ChatThreadController } from "@pwrdrvr/agent-client";
import type {
  EventPayloads,
  ChatThreadSidecar,
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
import {
  buildChatSurface,
  interruptChatThreadAcknowledged
} from "../ai/chat-controller-factory";
import {
  createKeyedChatControllerCache,
  type ChatBackendConfig
} from "../ai/chat-controller-cache";
import { rootKeyedChatThreadStore } from "../ai/chat-thread-store";
import { codexEnvForProfile } from "../ai/agent-kit-bindings";
import type { ChatBroadcast, ChatChannelSet } from "../ai/chat-event-adapter";
import { toLibraryThreadView } from "../ai/chat-event-adapter";
import { buildLibrarySystemPrompt } from "../ai/library-chat-system-prompt";
import { buildLibraryToolCatalog } from "../ai/library-tool-catalog";
import { dispatchLibraryToolCall } from "../ai/library-tool-catalog";
import { getChatsRoot } from "../persistence/paths";
import { ChatApprovalBroker } from "../ai/chat-approval-broker";
import { ChatThreadAccess } from "../ai/chat-thread-access";

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

/** The Library surface's broadcast channels (the controller is surface-
 *  parameterized — see `ChatChannelSet`). */
const LIBRARY_CHAT_CHANNELS: ChatChannelSet = {
  threadUpdated: EVENT_CHANNELS.libraryChatThreadUpdated,
  streamDelta: EVENT_CHANNELS.libraryChatStreamDelta,
  toolCall: EVENT_CHANNELS.libraryChatToolCall,
  messageCommitted: EVENT_CHANNELS.libraryChatMessageCommitted,
  turnInterrupted: EVENT_CHANNELS.libraryChatTurnInterrupted,
  approvalRequested: EVENT_CHANNELS.libraryChatApprovalRequested,
  approvalResolved: EVENT_CHANNELS.libraryChatApprovalResolved,
  approvalSuperseded: EVENT_CHANNELS.libraryChatApprovalSuperseded
};

/** Friendly activity-chip labels for the Library tool catalog. */
const LIBRARY_TOOL_LABELS: Record<string, string> = {
  library_list: "Listed captures",
  library_search: "Searched the library",
  capture_metadata: "Read capture details",
  read_ocr_text: "Read the capture text",
  list_layers: "Listed existing layers",
  editing_capabilities: "Checked capabilities",
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
    try {
      win.webContents.send(channel, payload);
    } catch (cause) {
      // One renderer disappearing between isDestroyed() and send must not
      // prevent sibling windows from receiving the terminal lifecycle event.
      log.warn("library chat window broadcast failed", {
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

export function registerLibraryChatHandlers(params?: {
  controller?: ChatThreadController<Settings>;
  settingsReader?: LibraryChatSettingsReader;
}): void {
  const settingsReader = params?.settingsReader ?? defaultSettingsReader;
  // Reads each thread's persisted backend config (for routing) + writes it on
  // create. Root-keyed so it follows a runtime captures-location flip.
  const store = rootKeyedChatThreadStore(getChatsRoot);
  const access = new ChatThreadAccess({
    surface: "library",
    store,
    loggerScope: "pwrsnap:library-chat-access"
  });
  const approvalBroker = new ChatApprovalBroker({
    surface: "library",
    loggerScope: "pwrsnap:library-chat-approval",
    emitResolved: (event) => {
      if (access.shouldBroadcastToHuman(event.threadId)) {
        broadcast(LIBRARY_CHAT_CHANNELS.approvalResolved, event);
      }
    },
    emitSuperseded: (event) => {
      if (access.shouldBroadcastToHuman(event.threadId)) {
        broadcast(LIBRARY_CHAT_CHANNELS.approvalSuperseded, event);
      }
    },
    pendingChanged: (threadId) => {
      const view = access.humanViewForThread(threadId);
      if (view !== null) {
        broadcast(LIBRARY_CHAT_CHANNELS.threadUpdated, {
          thread: approvalBroker.decorateThread(view)
        });
      }
    }
  });
  // sendMessage returns at turn start; backend tool calls arrive later. Keep
  // the last turn origin per thread until a subsequent send replaces it.
  const activeToolContexts = new Map<string, CommandDispatchOptions>();

  // ONE controller per distinct (provider, model, reasoning) config. Each thread
  // routes to the controller matching ITS config, so different threads on this
  // surface can run on different backends. ACP processes are shared by the agent
  // pool; only Codex spawns a child per config. A settings-level change (codex
  // command/profile/ACP paths) disposes + rebuilds all of them.
  const cache = createKeyedChatControllerCache<ChatThreadController<Settings>>({
    readSettings: settingsReader,
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
      const command = codexCommandForSettings(settings);
      const env = codexEnvForProfile(settings.codex.profile);
      const surface = await buildChatSurface({
        command,
        env,
        chatsDir: getChatsRoot(),
        readSettings: settingsReader,
        channels: LIBRARY_CHAT_CHANNELS,
        send: broadcast,
        approvalBroker,
        threadAccess: access,
        usageSurface: "library-chat",
        buildSystemPrompt: ({ settings: s, anchorId }) =>
          buildLibrarySystemPrompt({ settings: s, anchorCaptureId: anchorId }),
        buildTurnContext: buildCurrentCaptureContext,
        toolLabels: LIBRARY_TOOL_LABELS,
        catalog: buildLibraryToolCatalog(),
        dispatchToolCall: (toolCall) =>
          dispatchLibraryToolCall(
            toolCall,
            undefined,
            activeToolContexts.get(toolCall.threadId) ?? { principal: "ipc" }
          ),
        threadConfig: resolveCodexThreadConfigForCommand(command, env),
        threadEnvironments: LIBRARY_CHAT_THREAD_ENVIRONMENTS,
        // The THREAD's chosen config (not the surface default) — null leaves
        // omitted so the kit/backend default applies.
        ...(config.provider !== null && config.provider !== "" ? { provider: config.provider } : {}),
        ...(config.model !== null && config.model !== "" ? { model: config.model } : {}),
        ...(config.reasoning !== null && config.reasoning !== "" ? { effort: config.reasoning } : {}),
        loggerScope: "pwrsnap:library-chat"
      });
      return { controller: surface.controller, dispose: surface.dispose };
    }
  });
  app?.once?.("before-quit", () => {
    void cache.reset();
  });

  // A test-injected controller pins every config to that instance (no rebuild,
  // no real backend) — existing handler tests rely on this.
  const injected = params?.controller ?? null;
  const controllerFor = async (
    config: ChatBackendConfig
  ): Promise<ChatThreadController<Settings>> =>
    injected !== null ? injected : cache.get(config);

  /** The surface's Settings-default config (seeds a new chat + the list view). */
  const defaultConfig = async (): Promise<ChatBackendConfig> => {
    const d = (await settingsReader()).ai?.defaults?.libraryChat;
    return {
      provider: d?.provider !== undefined && d.provider !== "" ? d.provider : "codex",
      model: d?.model !== undefined && d.model !== "" ? d.model : null,
      reasoning: d?.reasoning ?? null
    };
  };

  /** Resolve an authorized EXISTING thread's backend config. Authorization
   *  always supplies the authoritative sidecar first; no store failure may be
   *  converted into a default/human-owned thread. */
  const configForSidecar = (sidecar: ChatThreadSidecar): ChatBackendConfig => {
    const agentId = acpAgentIdFromThreadId(sidecar.threadId);
    return {
      provider: sidecar.provider ?? (agentId !== null ? `acp:${agentId}` : "codex"),
      model: sidecar.model,
      reasoning: sidecar.reasoning
    };
  };

  bus.register("codex:libraryChat:list", async (req, ctx) => {
    const listed = await access.list(ctx, {
      includeArchived: req.includeArchived ?? false,
      ...(req.anchorCaptureId !== undefined ? { anchorCaptureId: req.anchorCaptureId } : {})
    });
    if (!listed.ok) return listed;
    return ok({
      threads: listed.value.map((sidecar) => approvalBroker.decorateThread(access.viewFor(sidecar)))
    });
  });

  bus.register("codex:libraryChat:create", async (req, ctx) => {
    try {
      if (req.anchorCaptureId?.startsWith("sz_") === true) {
        return err({
          kind: "validation",
          code: "library_chat_capture_required",
          message: "A Library chat cannot be attached to a Sizzle project."
        });
      }
      const actor = access.actorFor(ctx);
      if (!actor.ok) return actor;
      const d = await defaultConfig();
      // The chosen config: chips override, else the Settings default.
      const config: ChatBackendConfig = {
        provider: req.provider !== undefined && req.provider !== "" ? req.provider : d.provider,
        model: req.model !== undefined && req.model !== "" ? req.model : d.model,
        reasoning: req.reasoning !== undefined && req.reasoning !== "" ? req.reasoning : d.reasoning
      };
      const c = await controllerFor(config);
      const view = await access.runCreate(actor.value.ownerClientId, () =>
        c.createThread({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.anchorCaptureId !== undefined ? { anchorId: req.anchorCaptureId } : {})
        })
      );
      // The production adapter put backend config + exact owner in the INITIAL
      // INSERT before createThread emitted its first event. Read that row back
      // for the response (injected tests have no production adapter/store).
      if (injected === null) {
        const sidecar = await access.require(view.threadId, ctx);
        if (!sidecar.ok) return sidecar;
        return ok(approvalBroker.decorateThread(access.viewFor(sidecar.value)));
      }
      return ok(approvalBroker.decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:send", async (req, ctx) => {
    try {
      const authorized = await access.require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      if (req.anchorCaptureId?.startsWith("sz_") === true) {
        return err({
          kind: "validation",
          code: "library_chat_capture_required",
          message: "A Library chat cannot be moved to a Sizzle project."
        });
      }
      approvalBroker.openThread(req.threadId);
      const c = await controllerFor(configForSidecar(authorized.value));
      const commandContext: CommandDispatchOptions = {
        principal: ctx.principal,
        ...(ctx.localAgent !== undefined ? { localAgent: ctx.localAgent } : {}),
        ...(ctx.sourceWindowId !== undefined ? { sourceWindowId: ctx.sourceWindowId } : {}),
        ...(ctx.sourceBounds !== undefined ? { sourceBounds: ctx.sourceBounds } : {})
      };
      activeToolContexts.set(req.threadId, commandContext);
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

  bus.register("codex:libraryChat:wait", async (req, ctx) => {
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 600_000, 1_000), 600_000);
    const deadline = Date.now() + timeoutMs;
    try {
      const authorized = await access.require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const config = configForSidecar(authorized.value);
      const c = await controllerFor(config);
      while (true) {
        if (ctx.signal.aborted) {
          return aiError("edit_cancelled", "The image-edit request was cancelled.");
        }
        const thread = (await access.runCreate(authorized.value.ownerClientId, () =>
          c.listThreads({ includeArchived: true })
        ))
          .find((candidate) => candidate.threadId === req.threadId);
        if (thread === undefined) {
          return aiError("thread_not_found", "This chat thread could not be reopened.");
        }
        const view = approvalBroker.decorateThread(toLibraryThreadView(thread, config));
        if (view.status.kind === "idle") {
          const messages = await access.history(authorized.value);
          if (!messages.ok) return messages;
          return ok({
            thread: view,
            messages: messages.value
          });
        }
        if (Date.now() >= deadline) {
          return aiError(
            "edit_timeout",
            "The PwrSnap image edit did not finish within 10 minutes."
          );
        }
        await waitForTurnProgress(ctx.signal);
      }
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:history", async (req, ctx) => {
    const authorized = await access.require(req.threadId, ctx);
    if (!authorized.ok) return authorized;
    const messages = await access.history(authorized.value);
    return messages.ok ? ok({ messages: messages.value }) : messages;
  });

  bus.register("codex:libraryChat:rename", async (req, ctx) => {
    try {
      const authorized = await access.require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const config = configForSidecar(authorized.value);
      const c = await controllerFor(config);
      const view = await c.rename(req.threadId, req.name);
      return ok(approvalBroker.decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:archive", async (req, ctx) => {
    try {
      const authorized = await access.require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const config = configForSidecar(authorized.value);
      const c = await controllerFor(config);
      if (req.archived) {
        // Archiving is a quiescing lifecycle operation, not just metadata.
        // Truthful interrupt (owned by #488's session controller) must
        // acknowledge backend cancellation before broker denial can resume an
        // awaiting model. Only then may the thread become hidden.
        if (approvalBroker.pendingForThread(req.threadId) !== null) {
          await interruptChatThreadAcknowledged(c, req.threadId);
        } else {
          await c.interrupt(req.threadId);
        }
        await approvalBroker.closeThread(req.threadId);
      }
      const view = await c.archive(req.threadId, req.archived);
      if (!req.archived) approvalBroker.openThread(req.threadId);
      return ok(approvalBroker.decorateThread(toLibraryThreadView(view, config)));
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:interrupt", async (req, ctx) => {
    try {
      const authorized = await access.require(req.threadId, ctx);
      if (!authorized.ok) return authorized;
      const c = await controllerFor(configForSidecar(authorized.value));
      if (approvalBroker.pendingForThread(req.threadId) !== null) {
        await interruptChatThreadAcknowledged(c, req.threadId);
      } else {
        await c.interrupt(req.threadId);
      }
      // Do not deny or terminalize the pending approval unless interruption
      // was acknowledged by the controller.
      await approvalBroker.closeThread(req.threadId);
      return ok(undefined);
    } catch (cause) {
      return codexUnreachable(cause);
    }
  });

  bus.register("codex:libraryChat:approval", async (req, ctx) => {
    const response = chatApprovalResponseSchema.safeParse(req);
    if (!response.success) {
      return err({
        kind: "validation",
        code: "invalid_approval_response",
        message: "The approval response was malformed."
      });
    }
    const authorized = await access.require(response.data.threadId, ctx);
    if (!authorized.ok) return authorized;
    return approvalBroker.resolve({
      threadId: response.data.threadId,
      turnId: response.data.turnId,
      approvalId: response.data.approvalId,
      decision: response.data.decision
    });
  });
}

async function waitForTurnProgress(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 200);
    const onAbort = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
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
