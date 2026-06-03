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

import { ChatThreadController, CodexThreadClient } from "@pwrdrvr/agent-client";
import type { ChatThreadControllerDeps } from "@pwrdrvr/agent-client";
import type { NormalizedApprovalDecision } from "@pwrdrvr/agent-core";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrsnap/codex-app-server-protocol/v2";
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
  /** Per-surface default model id for thread/start. Omit / undefined =
   *  use the Codex default (no `model` sent). Driven by Settings → AI's
   *  per-surface defaults (`ai.defaults.libraryChat` / `.sizzleChat`). */
  model?: string;
  /** Per-surface default model provider for thread/start. Omit /
   *  undefined = Codex default. */
  modelProvider?: string;
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
 *  omitted so the controller falls back to the Codex default
 *  (model / provider) or the kit default (effort = "medium"). Shared by
 *  the Library + Sizzle chat handlers so the mapping lives in one place. */
export function chatSurfaceDefaultsFromSettings(
  surface: AiSurfaceDefault
): { model?: string; modelProvider?: string; effort?: string } {
  return {
    ...(surface.model !== undefined && surface.model.length > 0
      ? { model: surface.model }
      : {}),
    ...(surface.provider !== undefined && surface.provider.length > 0
      ? { modelProvider: surface.provider }
      : {}),
    ...(surface.reasoning !== undefined ? { effort: surface.reasoning } : {})
  };
}

export function buildChatSurface(config: ChatSurfaceConfig): ChatSurface {
  const store = new ChatThreadStore({ chatsDir: config.chatsDir });
  const adapter = new ThreadStoreAdapter({ store, usageSurface: config.usageSurface });
  const client = new CodexThreadClient({
    command: config.command,
    clientName: PWRSNAP_CLIENT_NAME,
    clientTitle: PWRSNAP_CLIENT_TITLE,
    serviceName: PWRSNAP_SERVICE_NAME,
    logger: toAgentKitLogger(config.loggerScope)
  });

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
    // Per-surface defaults from Settings → AI. `effort` defaults to
    // "medium" (the kit's own default) when the surface has no pinned
    // reasoning; `model` / `modelProvider` are only forwarded when set so
    // an unset surface uses the Codex default rather than pinning one.
    effort: config.effort ?? "medium",
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.modelProvider !== undefined ? { modelProvider: config.modelProvider } : {}),
    logger: toAgentKitLogger(config.loggerScope)
  });
  controller.wire();

  return { controller };
}
