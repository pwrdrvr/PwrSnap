import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import {
  EVENT_CHANNELS,
  err,
  ok,
  type ChatApprovalDecision,
  type ChatTurnInputItem,
  type EventPayloads,
  type PwrSnapError,
  type Result,
  type Settings,
  type SizzleProject,
  type TypedEventChannel
} from "@pwrsnap/shared";
import { CodexAppServerClient, type ChatApprovalAsk } from "../ai/codex-client";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { getChatStore, type ChatStore } from "./chat-store";
import { createChatScratchDir, deleteChatScratchDir } from "./scratch-dir";
import { createSizzleToolDispatcher } from "./sizzle-tools";

const log = getMainLogger("pwrsnap:chat-manager");

// Base instructions for the Sizzle chat agent. It works ONLY on the one
// project this session is scoped to; all mutation tools are pre-bound to
// that projectId. Read tools span the whole library.
const SIZZLE_CHAT_INSTRUCTIONS = [
  "You are PwrSnap's Sizzle Reel composer assistant. You help the user",
  "turn their screen captures into a narrated video reel.",
  "",
  "Use `library_search` and `library_get_metadata` to find relevant",
  "captures across the user's whole library, then build the reel with the",
  "`scenes_*` and `scene_set_*` tools. Each scene pairs one capture with a",
  "narrator script line and a transition. Order scenes to tell a coherent",
  "story. When the user describes a video, search for the screens they",
  "mention, propose a scene list, write concise spoken-style script lines",
  "(1-2 sentences each), and set sensible transitions. Use `project_get`",
  "to inspect the current state before editing. Only call `project_render`",
  "when the user explicitly asks to render.",
  "",
  "All scene edits apply to the current project only. Keep responses short."
].join("\n");

export type ChatManagerDeps = {
  clientFactory?: (command: string) => CodexAppServerClient;
  settingsReader?: () => Promise<Settings>;
  store?: ChatStore;
};

type PendingApproval = { resolve: (decision: ChatApprovalDecision) => void };

function broadcast<C extends TypedEventChannel>(channel: C, payload: EventPayloads[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function codexCommandForSettings(settings: Settings): string {
  return settings.codex.mode === "pinned" && settings.codex.pinnedPath !== ""
    ? settings.codex.pinnedPath
    : "codex";
}

function mapError(error: unknown, code: string): PwrSnapError {
  return {
    kind: "unknown",
    code,
    message: error instanceof Error ? error.message : String(error),
    cause: error
  };
}

/**
 * Owns the long-lived chat Codex client + per-session/turn bookkeeping
 * for the Sizzle composer chat. One instance process-wide (see
 * {@link getSizzleChatManager}); the codex:* chat verbs delegate here and
 * sizzle:delete calls {@link cleanupProjectChat}.
 */
export class SizzleChatManager {
  private client: CodexAppServerClient | null = null;
  /** sessionId → threadId for sessions live in THIS app run. */
  private readonly live = new Map<string, string>();
  /** `${sessionId}:${turnId}` → AbortController for in-flight turns. */
  private readonly turns = new Map<string, AbortController>();
  /** `${sessionId}:${turnId}:${requestId}` → parked approval resolver. */
  private readonly approvals = new Map<string, PendingApproval>();

  private readonly clientFactory: (command: string) => CodexAppServerClient;
  private readonly settingsReader: () => Promise<Settings>;
  // Resolved lazily: the singleton ChatStore reads `app.getPath` in its
  // constructor, so building it at manager-construction time would force
  // an Electron dependency just to REGISTER the bus handlers (the
  // enrichment-handler tests register without a chat manager and have no
  // `app` mock). Defer until a chat verb actually runs.
  private storeRef: ChatStore | null;

  constructor(deps: ChatManagerDeps = {}) {
    this.clientFactory =
      deps.clientFactory ?? ((command) => new CodexAppServerClient({ command }));
    this.settingsReader =
      deps.settingsReader ??
      (async () => {
        const r = await bus.dispatch("settings:read", {}, { principal: "ipc" });
        if (!r.ok) throw new Error(r.error.message);
        return r.value;
      });
    this.storeRef = deps.store ?? null;
  }

  private get store(): ChatStore {
    if (this.storeRef === null) this.storeRef = getChatStore();
    return this.storeRef;
  }

  private async getClient(): Promise<CodexAppServerClient> {
    if (this.client !== null) return this.client;
    const settings = await this.settingsReader();
    this.client = this.clientFactory(codexCommandForSettings(settings));
    return this.client;
  }

  private async projectById(projectId: string): Promise<SizzleProject | null> {
    const r = await bus.dispatch("sizzle:list", {}, { principal: "ipc" });
    if (!r.ok) return null;
    return r.value.projects.find((p) => p.id === projectId) ?? null;
  }

  /** Get-or-create the chat session for a project. */
  async newSession(
    projectId: string
  ): Promise<Result<{ sessionId: string; threadId: string }, PwrSnapError>> {
    const project = await this.projectById(projectId);
    if (project === null) {
      return err({ kind: "validation", code: "not_found", message: `project ${projectId} not found` });
    }

    const existing = await this.store.getByProjectId(projectId);
    if (existing !== null) {
      const liveThread = this.live.get(existing.sessionId);
      if (liveThread !== undefined) {
        // Already open this app run — hand back the live session.
        return ok({ sessionId: existing.sessionId, threadId: liveThread });
      }
    }

    let scratchDir: string;
    try {
      scratchDir = existing?.scratchDir ?? (await createChatScratchDir({ projectName: project.name }));
    } catch (error) {
      return err(mapError(error, "chat_scratch_dir_failed"));
    }
    const sessionId = existing?.sessionId ?? `chat_${randomUUID().slice(0, 12)}`;
    const createdAt = existing?.createdAt ?? new Date().toISOString();

    const dispatcher = createSizzleToolDispatcher(projectId);

    try {
      const client = await this.getClient();
      const { threadId } = await client.startChatSession({
        sessionId,
        cwd: scratchDir,
        baseInstructions: SIZZLE_CHAT_INSTRUCTIONS,
        dynamicTools: dispatcher.tools,
        onToolCall: async (call) => {
          const result = await dispatcher.dispatch(call);
          broadcast(EVENT_CHANNELS.codexToolCall, {
            sessionId,
            turnId: call.turnId,
            toolCall: {
              callId: call.callId,
              tool: call.tool,
              argumentsJson: safeStringify(call.arguments),
              ok: result.response.success,
              summary: result.summary
            }
          });
          return result.response;
        },
        onApprovalRequest: (turnId, ask) => this.parkApproval(sessionId, turnId, ask)
      });

      await this.store.upsert({ projectId, sessionId, threadId, scratchDir, createdAt });
      this.live.set(sessionId, threadId);
      return ok({ sessionId, threadId });
    } catch (error) {
      return err(mapError(error, "chat_session_start_failed"));
    }
  }

  private parkApproval(
    sessionId: string,
    turnId: string,
    ask: ChatApprovalAsk
  ): Promise<ChatApprovalDecision> {
    broadcast(EVENT_CHANNELS.codexApprovalRequest, {
      sessionId,
      turnId,
      requestId: ask.requestId,
      request: {
        requestId: ask.requestId,
        kind: ask.kind,
        reason: ask.reason,
        command: ask.command,
        cwd: ask.cwd,
        availableDecisions: ask.availableDecisions
      }
    });
    return new Promise<ChatApprovalDecision>((resolve) => {
      this.approvals.set(approvalKey(sessionId, turnId, ask.requestId), { resolve });
    });
  }

  async sendTurn(
    sessionId: string,
    input: ChatTurnInputItem[]
  ): Promise<Result<{ turnId: string }, PwrSnapError>> {
    if (!this.live.has(sessionId)) {
      return err({
        kind: "validation",
        code: "session_not_open",
        message: "chat session is not open — start a new session first"
      });
    }
    const abort = new AbortController();
    const holder = { turnId: "" };
    try {
      const client = await this.getClient();
      const { turnId } = await client.startChatTurn({
        sessionId,
        input,
        signal: abort.signal,
        onDelta: (itemId, delta) => {
          broadcast(EVENT_CHANNELS.codexStreamDelta, {
            sessionId,
            turnId: holder.turnId,
            itemId,
            delta
          });
        },
        onComplete: (result) => {
          this.turns.delete(turnKey(sessionId, holder.turnId));
          this.resolvePendingApprovalsForTurn(sessionId, holder.turnId, "cancel");
          broadcast(EVENT_CHANNELS.codexTurnComplete, {
            sessionId,
            turnId: holder.turnId,
            status: result.status,
            ...(result.finalMessage.length > 0 ? { finalMessage: result.finalMessage } : {}),
            ...(result.error !== undefined ? { error: result.error } : {})
          });
        }
      });
      holder.turnId = turnId;
      this.turns.set(turnKey(sessionId, turnId), abort);
      return ok({ turnId });
    } catch (error) {
      return err(mapError(error, "chat_turn_failed"));
    }
  }

  submitApproval(
    sessionId: string,
    turnId: string,
    requestId: string,
    decision: ChatApprovalDecision
  ): Result<void, PwrSnapError> {
    const key = approvalKey(sessionId, turnId, requestId);
    const pending = this.approvals.get(key);
    if (pending !== undefined) {
      this.approvals.delete(key);
      pending.resolve(decision);
    }
    return ok(undefined);
  }

  cancelTurn(sessionId: string, turnId: string): Result<void, PwrSnapError> {
    this.turns.get(turnKey(sessionId, turnId))?.abort();
    // Unblock any approval the agent was waiting on so the JSON-RPC reply
    // resolves and the turn can actually wind down.
    this.resolvePendingApprovalsForTurn(sessionId, turnId, "cancel");
    return ok(undefined);
  }

  async closeSession(sessionId: string): Promise<Result<void, PwrSnapError>> {
    this.resolvePendingApprovalsForSession(sessionId, "cancel");
    for (const [key, abort] of this.turns) {
      if (key.startsWith(`${sessionId}:`)) abort.abort();
    }
    this.live.delete(sessionId);
    if (this.client !== null) {
      await this.client.closeChatSession(sessionId).catch((error: unknown) => {
        log.warn("closeChatSession failed", {
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }
    return ok(undefined);
  }

  /** Cascade for sizzle:delete — close the live session, delete the
   *  scratch dir, drop the store row. No-op when the project never had a
   *  chat. */
  async cleanupProjectChat(projectId: string): Promise<void> {
    const row = await this.store.getByProjectId(projectId);
    if (row === null) return;
    await this.closeSession(row.sessionId);
    await this.store.deleteByProjectId(projectId);
    await deleteChatScratchDir({ dir: row.scratchDir }).catch((error: unknown) => {
      log.warn("scratch dir delete failed", {
        projectId,
        dir: row.scratchDir,
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private resolvePendingApprovalsForTurn(
    sessionId: string,
    turnId: string,
    decision: ChatApprovalDecision
  ): void {
    const prefix = `${sessionId}:${turnId}:`;
    for (const [key, pending] of this.approvals) {
      if (key.startsWith(prefix)) {
        this.approvals.delete(key);
        pending.resolve(decision);
      }
    }
  }

  private resolvePendingApprovalsForSession(
    sessionId: string,
    decision: ChatApprovalDecision
  ): void {
    const prefix = `${sessionId}:`;
    for (const [key, pending] of this.approvals) {
      if (key.startsWith(prefix)) {
        this.approvals.delete(key);
        pending.resolve(decision);
      }
    }
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

function approvalKey(sessionId: string, turnId: string, requestId: string): string {
  return `${sessionId}:${turnId}:${requestId}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

let singleton: SizzleChatManager | null = null;
export function getSizzleChatManager(): SizzleChatManager {
  if (singleton === null) singleton = new SizzleChatManager();
  return singleton;
}
