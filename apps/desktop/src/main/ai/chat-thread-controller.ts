// The integration heart of the Library Chat substrate. Ties together:
//   • CodexThreadClient   — one shared connection, many threads
//   • ChatThreadStore     — sidecar + journal persistence
//   • the tool catalog     — DynamicToolSpec[] + dispatch (empty in
//                            Phase 0; Phase 1 fills the allowlist)
//
// Load-bearing design (plan §F10):
//   • Per-thread TurnState in a Map<threadId, ...>, NEVER a singleton —
//     two threads can stream concurrently without cross-wiring.
//   • Settings are SNAPSHOTTED at turn start; a mid-turn Settings change
//     does not retro-apply to the in-flight turn.
//   • Approvals carry (threadId, turnId, approvalId); a late / mismatched
//     resolution is rejected, never resolves the wrong turn.
//   • The renderer is a VIEW of this controller's state — all mutation
//     flows main→renderer via the events:libraryChat:* broadcasts.
//
// Phase 0 scope: text chat works end-to-end (create → send → stream →
// commit). The tool catalog is empty, so the agent has no actions yet;
// Phase 1 populates LIBRARY_TOOL_ALLOWLIST and tool calls start routing
// through `dispatchToolCall`. Per-turn L3 context injection (active
// capture summary) is a documented Phase 4 follow-up — Phase 0 sets the
// system prompt (L1 + L2 user guidance) at thread/start.

import { randomUUID } from "node:crypto";
import type {
  ChatApprovalDecision,
  ChatApprovalRequest,
  ChatMessage,
  ChatThreadSidecar,
  EventPayloads,
  LibraryChatThreadStatus,
  LibraryChatThreadView,
  Settings,
  TypedEventChannel
} from "@pwrsnap/shared";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrsnap/codex-app-server-protocol/v2";
import type { CodexThreadClient } from "./codex-thread-client";
import type { ChatThreadStore } from "./chat-thread-store";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:chat-thread-controller");

/** Typed broadcast — only the libraryChat channels (+ any other typed
 *  channel) are accepted. Default impl sends to every BrowserWindow. */
export type ChatBroadcast = <C extends TypedEventChannel>(
  channel: C,
  payload: EventPayloads[C]
) => void;

/** Builds the per-thread system prompt (L1 base + L2 user guidance).
 *  Injected as `baseInstructions` at thread/start. */
export type ChatSystemPromptBuilder = (input: {
  settings: Settings;
  anchorCaptureId: string | null;
}) => string;

export type ChatThreadControllerDeps = {
  client: CodexThreadClient;
  store: ChatThreadStore;
  readSettings: () => Promise<Settings>;
  broadcast: ChatBroadcast;
  buildSystemPrompt: ChatSystemPromptBuilder;
  /** DynamicToolSpec[] registered on every thread/start. Empty in
   *  Phase 0. */
  catalog?: DynamicToolSpec[];
  /** Routes an incoming item/tool/call to the allowlist. Defaults to a
   *  no-tools responder when omitted (Phase 0). */
  dispatchToolCall?: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Default-Access policy applied to every chat thread. */
  approvalPolicy?: string;
  sandbox?: string;
  /** Injectable clock for tests. */
  now?: () => number;
};

/** Per-thread, in-flight turn state. */
type TurnState = {
  turnId: string;
  assistantMessageId: string;
  /** Accumulated streamed text for the in-flight assistant message. */
  buffer: string;
  /** Frozen at turn start — a mid-turn Settings change can't retro-apply. */
  settingsSnapshot: Settings;
};

/** A pending approval awaiting the user's decision. */
type PendingApproval = {
  threadId: string;
  turnId: string;
  approvalId: string;
  resolve: (decision: ChatApprovalDecision) => void;
};

const RATE_LIMIT_TURNS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

export class ChatThreadController {
  private readonly deps: Required<
    Pick<ChatThreadControllerDeps, "client" | "store" | "readSettings" | "broadcast" | "buildSystemPrompt">
  > &
    ChatThreadControllerDeps;
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Per-thread recent turn timestamps for rate limiting. */
  private readonly turnTimestamps = new Map<string, number[]>();
  private wired = false;

  constructor(deps: ChatThreadControllerDeps) {
    this.deps = deps;
  }

  /** Wire the shared client's subscription hooks ONCE. Idempotent. */
  wire(): void {
    if (this.wired) return;
    this.wired = true;
    const { client } = this.deps;
    client.onAgentMessageDelta((event) => this.onDelta(event.threadId, event.turnId, event.delta));
    client.onTurnCompleted((event) => {
      void this.onTurnCompleted(event.threadId, event.turnId, event.status);
    });
    client.onToolCall((params) => this.onToolCall(params));
    client.onApprovalRequest((method, params) => this.onApprovalRequest(method, params));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // ---- thread lifecycle ----

  async createThread(name?: string): Promise<LibraryChatThreadView> {
    const settings = await this.deps.readSettings();
    const baseInstructions = this.deps.buildSystemPrompt({
      settings,
      anchorCaptureId: null
    });
    const started = await this.deps.client.startThread({
      ...(this.deps.approvalPolicy !== undefined ? { approvalPolicy: this.deps.approvalPolicy } : {}),
      ...(this.deps.sandbox !== undefined ? { sandbox: this.deps.sandbox } : {}),
      baseInstructions,
      ...(this.deps.catalog !== undefined ? { dynamicTools: this.deps.catalog } : {})
    });
    const displayName = name && name.trim().length > 0 ? name.trim() : this.defaultName();
    const sidecar = await this.deps.store.create({ threadId: started.threadId, name: displayName });
    const view = this.toView(sidecar);
    this.deps.broadcast(EVENT_CHANNELS.libraryChatThreadUpdated, { thread: view });
    return view;
  }

  async listThreads(includeArchived = false): Promise<LibraryChatThreadView[]> {
    const sidecars = await this.deps.store.list();
    return sidecars
      .filter((s) => includeArchived || !s.archived)
      .map((s) => this.toView(s));
  }

  async rename(threadId: string, name: string): Promise<LibraryChatThreadView> {
    const sidecar = await this.deps.store.update(threadId, { name: name.trim() });
    const view = this.toView(sidecar);
    this.deps.broadcast(EVENT_CHANNELS.libraryChatThreadUpdated, { thread: view });
    return view;
  }

  async archive(threadId: string, archived: boolean): Promise<LibraryChatThreadView> {
    const sidecar = await this.deps.store.update(threadId, { archived });
    if (archived) await this.deps.client.archiveThread(threadId).catch(() => undefined);
    const view = this.toView(sidecar);
    this.deps.broadcast(EVENT_CHANNELS.libraryChatThreadUpdated, { thread: view });
    return view;
  }

  // ---- turns ----

  async sendMessage(input: {
    threadId: string;
    text: string;
    anchorCaptureId?: string | null;
  }): Promise<{ turnId: string }> {
    const { threadId } = input;
    if (this.turns.has(threadId)) {
      throw new Error("a turn is already in progress for this thread");
    }
    this.enforceRateLimit(threadId);

    if (input.anchorCaptureId !== undefined) {
      await this.deps.store.update(threadId, { anchorCaptureId: input.anchorCaptureId });
      if (input.anchorCaptureId !== null) {
        await this.deps.store.appendFocus(threadId, input.anchorCaptureId);
      }
    }

    // Persist + broadcast the user message BEFORE starting the turn so
    // a dispatch failure doesn't lose the typed prompt (plan §F10 T5).
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: [{ kind: "text", text: input.text }],
      status: "complete",
      createdAt: new Date(this.now()).toISOString()
    };
    await this.commitMessage(threadId, userMessage);

    const settingsSnapshot = await this.deps.readSettings();

    let turnId: string;
    try {
      const started = await this.deps.client.startTurn({
        threadId,
        input: [{ type: "text", text: input.text, text_elements: [] }],
        effort: "medium"
      });
      turnId = started.turnId;
    } catch (cause) {
      // Mark a placeholder assistant message failed so the UI shows Retry.
      const failed: ChatMessage = {
        id: randomUUID(),
        role: "assistant",
        content: [{ kind: "text", text: "" }],
        status: "failed",
        createdAt: new Date(this.now()).toISOString()
      };
      await this.commitMessage(threadId, failed);
      log.warn("chat turn start failed", {
        threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      throw cause;
    }

    const assistantMessageId = randomUUID();
    this.turns.set(threadId, {
      turnId,
      assistantMessageId,
      buffer: "",
      settingsSnapshot
    });
    this.recordTurn(threadId);
    await this.broadcastThreadStatus(threadId, { kind: "streaming", turnId });
    return { turnId };
  }

  async getHistory(threadId: string): Promise<ChatMessage[]> {
    return this.readJournalMessages(threadId);
  }

  async interrupt(threadId: string): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return;
    await this.deps.client.interruptTurn(threadId).catch(() => undefined);
    await this.finalizeAssistant(threadId, "interrupted");
    this.deps.broadcast(EVENT_CHANNELS.libraryChatTurnInterrupted, {
      threadId,
      turnId: turn.turnId,
      reason: "user_interrupted"
    });
  }

  // ---- approval flow ----

  async resolveApproval(input: {
    threadId: string;
    turnId: string;
    approvalId: string;
    decision: ChatApprovalDecision;
  }): Promise<void> {
    const key = approvalKey(input.threadId, input.turnId, input.approvalId);
    const pending = this.pendingApprovals.get(key);
    if (pending === undefined) {
      log.warn("resolveApproval: no matching pending approval (stale?)", { key });
      return;
    }
    this.pendingApprovals.delete(key);
    pending.resolve(input.decision);
  }

  // ---- client subscription handlers ----

  private onDelta(threadId: string, turnId: string, delta: string): void {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    turn.buffer += delta;
    this.deps.broadcast(EVENT_CHANNELS.libraryChatStreamDelta, {
      threadId,
      turnId,
      messageId: turn.assistantMessageId,
      delta
    });
  }

  private async onTurnCompleted(threadId: string, turnId: string, status: string): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    await this.finalizeAssistant(threadId, status === "completed" ? "complete" : "interrupted");
  }

  private async onToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (this.deps.dispatchToolCall) {
      return this.deps.dispatchToolCall(params);
    }
    // Phase 0: no tools registered. Tell the agent so it self-corrects.
    return {
      contentItems: [
        {
          type: "inputText",
          text: "PwrSnap has no tools enabled for this chat yet."
        }
      ],
      success: false
    };
  }

  private async onApprovalRequest(method: string, params: unknown): Promise<unknown> {
    // Best-effort extraction of (threadId, turnId) from the params; Codex
    // shapes vary by approval method. We always mint our own approvalId.
    const p = (params ?? {}) as Record<string, unknown>;
    const threadId = typeof p.threadId === "string" ? p.threadId : "";
    const turnId = typeof p.turnId === "string" ? p.turnId : "";
    const approvalId = randomUUID();
    const summary = typeof p.summary === "string" ? p.summary : `Approve: ${method}`;
    const detail = typeof p.detail === "string" ? p.detail : undefined;

    const request: ChatApprovalRequest = {
      threadId,
      turnId,
      approvalId,
      summary,
      ...(detail !== undefined ? { detail } : {})
    };

    const decision = await new Promise<ChatApprovalDecision>((resolve) => {
      this.pendingApprovals.set(approvalKey(threadId, turnId, approvalId), {
        threadId,
        turnId,
        approvalId,
        resolve
      });
      this.deps.broadcast(EVENT_CHANNELS.libraryChatApprovalRequested, request);
      if (threadId.length > 0) {
        void this.broadcastThreadStatus(threadId, { kind: "awaiting_approval", approvalId });
      }
    });

    if (threadId.length > 0) {
      const turn = this.turns.get(threadId);
      void this.broadcastThreadStatus(
        threadId,
        turn ? { kind: "streaming", turnId: turn.turnId } : { kind: "idle" }
      );
    }
    // Map our decision to Codex's expected approval response. Codex's
    // approval responses are method-specific; for Phase 0 we return a
    // generic { decision } the client passes through. The exact shape
    // is refined when the mutating tool catalog lands (Phase 2).
    return { decision: decision === "approve" ? "approved" : "denied" };
  }

  // ---- internals ----

  private async finalizeAssistant(threadId: string, status: ChatMessage["status"]): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined) return;
    this.turns.delete(threadId);
    const message: ChatMessage = {
      id: turn.assistantMessageId,
      role: "assistant",
      content: [{ kind: "text", text: turn.buffer }],
      status,
      createdAt: new Date(this.now()).toISOString()
    };
    await this.commitMessage(threadId, message);
    await this.broadcastThreadStatus(threadId, { kind: "idle" });
  }

  private async commitMessage(threadId: string, message: ChatMessage): Promise<void> {
    await this.deps.store.journalAppend(threadId, { kind: "message", message });
    this.deps.broadcast(EVENT_CHANNELS.libraryChatMessageCommitted, { threadId, message });
  }

  private async readJournalMessages(threadId: string): Promise<ChatMessage[]> {
    // The store owns journal IO; for Phase 0 we re-read the journal file
    // and pull out message entries. The store exposes attachmentsDir +
    // journalAppend; reading is done here via the same file path
    // convention. Kept minimal — full rollout history is Codex's job.
    const entries = await this.deps.store.readJournal(threadId).catch(() => []);
    const messages: ChatMessage[] = [];
    for (const entry of entries) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        (entry as { kind?: unknown }).kind === "message"
      ) {
        const m = (entry as { message?: unknown }).message;
        if (m !== undefined) messages.push(m as ChatMessage);
      }
    }
    return messages;
  }

  private enforceRateLimit(threadId: string): void {
    const stamps = this.turnTimestamps.get(threadId) ?? [];
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    const recent = stamps.filter((t) => t >= cutoff);
    if (recent.length >= RATE_LIMIT_TURNS) {
      throw new Error(
        `rate limit: max ${RATE_LIMIT_TURNS} turns per minute for this thread`
      );
    }
  }

  private recordTurn(threadId: string): void {
    const stamps = this.turnTimestamps.get(threadId) ?? [];
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    const recent = stamps.filter((t) => t >= cutoff);
    recent.push(this.now());
    this.turnTimestamps.set(threadId, recent);
  }

  private async broadcastThreadStatus(
    threadId: string,
    status: LibraryChatThreadStatus
  ): Promise<void> {
    const sidecar = await this.deps.store.get(threadId);
    if (sidecar === null) return;
    this.deps.broadcast(EVENT_CHANNELS.libraryChatThreadUpdated, {
      thread: this.toView(sidecar, status)
    });
  }

  private toView(sidecar: ChatThreadSidecar, status?: LibraryChatThreadStatus): LibraryChatThreadView {
    const resolved: LibraryChatThreadStatus =
      status ?? (this.turns.has(sidecar.threadId)
        ? { kind: "streaming", turnId: this.turns.get(sidecar.threadId)!.turnId }
        : { kind: "idle" });
    return {
      threadId: sidecar.threadId,
      name: sidecar.name,
      createdAt: sidecar.createdAt,
      modifiedAt: sidecar.modifiedAt,
      anchorCaptureId: sidecar.anchorCaptureId,
      archived: sidecar.archived,
      pinned: sidecar.pinned,
      lastMessagePreview: "",
      status: resolved
    };
  }

  private defaultName(): string {
    const d = new Date(this.now());
    const date = d.toISOString().slice(0, 10);
    return `Chat ${date}`;
  }
}

function approvalKey(threadId: string, turnId: string, approvalId: string): string {
  return `${threadId}::${turnId}::${approvalId}`;
}
