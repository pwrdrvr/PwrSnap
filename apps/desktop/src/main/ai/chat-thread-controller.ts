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
  DynamicToolSpec,
  UserInput
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

/** The six `events:*Chat:*` channels a surface broadcasts on. Each
 *  surface (Library, Sizzle) passes its own set so one controller serves
 *  many surfaces. The Library + Sizzle channels share payload types, so
 *  the typed broadcast resolves to the same payload for either. */
export type ChatChannelSet = {
  threadUpdated:
    | typeof EVENT_CHANNELS.libraryChatThreadUpdated
    | typeof EVENT_CHANNELS.sizzleChatThreadUpdated;
  streamDelta:
    | typeof EVENT_CHANNELS.libraryChatStreamDelta
    | typeof EVENT_CHANNELS.sizzleChatStreamDelta;
  toolCall:
    | typeof EVENT_CHANNELS.libraryChatToolCall
    | typeof EVENT_CHANNELS.sizzleChatToolCall;
  messageCommitted:
    | typeof EVENT_CHANNELS.libraryChatMessageCommitted
    | typeof EVENT_CHANNELS.sizzleChatMessageCommitted;
  turnInterrupted:
    | typeof EVENT_CHANNELS.libraryChatTurnInterrupted
    | typeof EVENT_CHANNELS.sizzleChatTurnInterrupted;
  approvalRequested:
    | typeof EVENT_CHANNELS.libraryChatApprovalRequested
    | typeof EVENT_CHANNELS.sizzleChatApprovalRequested;
};

export type ChatThreadControllerDeps = {
  client: CodexThreadClient;
  store: ChatThreadStore;
  readSettings: () => Promise<Settings>;
  broadcast: ChatBroadcast;
  buildSystemPrompt: ChatSystemPromptBuilder;
  /** The surface's broadcast channels (Library vs Sizzle). */
  channels: ChatChannelSet;
  /** Per-turn runtime context (L3), framed as system-generated and sent
   *  as a leading turn item — never folded into the user's message. For
   *  Library this is the `<current_capture>` block; for Sizzle the active
   *  project. Omit for no per-turn context. Receives the turn's anchor. */
  buildTurnContext?: (anchor: string) => string;
  /** Friendly present-tense labels for tool activity chips, keyed by
   *  tool name. Falls back to the raw tool name when unmapped. */
  toolLabels?: Record<string, string>;
  /** DynamicToolSpec[] registered on every thread/start. Empty in
   *  Phase 0. */
  catalog?: DynamicToolSpec[];
  /** Routes an incoming item/tool/call to the allowlist. Defaults to a
   *  no-tools responder when omitted (Phase 0). */
  dispatchToolCall?: (params: DynamicToolCallParams) => Promise<DynamicToolCallResponse>;
  /** Default-Access policy applied to every chat thread. */
  approvalPolicy?: string;
  sandbox?: string;
  /** Per-thread Codex config overlay applied on every thread/start —
   *  e.g. `web_search = "disabled"` so the agent doesn't advertise web
   *  search. */
  threadConfig?: Record<string, unknown>;
  /** Thread environments. `[]` disables exec-environment access, which
   *  drops Codex's built-in shell / unified_exec / apply_patch tools
   *  (they're env-gated) while leaving our dynamic tools intact — so the
   *  agent presents only PwrSnap's tools. */
  threadEnvironments?: unknown[];
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

  async createThread(opts: {
    name?: string;
    anchorCaptureId?: string | null;
  } = {}): Promise<LibraryChatThreadView> {
    const anchorCaptureId = opts.anchorCaptureId ?? null;
    const settings = await this.deps.readSettings();
    const baseInstructions = this.deps.buildSystemPrompt({ settings, anchorCaptureId });
    const displayName =
      opts.name && opts.name.trim().length > 0 ? opts.name.trim() : this.defaultName();
    const preparedDir = await this.deps.store.prepareThreadDir(displayName);
    let started: { threadId: string };
    try {
      started = await this.deps.client.startThread({
        ...(this.deps.approvalPolicy !== undefined ? { approvalPolicy: this.deps.approvalPolicy } : {}),
        ...(this.deps.sandbox !== undefined ? { sandbox: this.deps.sandbox } : {}),
        baseInstructions,
        cwd: preparedDir.path,
        runtimeWorkspaceRoots: [preparedDir.path],
        serviceName: "pwrsnap",
        ...(this.deps.catalog !== undefined ? { dynamicTools: this.deps.catalog } : {}),
        ...(this.deps.threadConfig !== undefined ? { config: this.deps.threadConfig } : {}),
        ...(this.deps.threadEnvironments !== undefined
          ? { environments: this.deps.threadEnvironments }
          : {})
      });
    } catch (cause) {
      await this.deps.store.discardPreparedThreadDir(preparedDir).catch(() => undefined);
      throw cause;
    }
    await this.deps.client.clearThreadGitInfo(started.threadId).catch((cause) => {
      log.warn("chat thread git metadata clear failed", {
        threadId: started.threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
    // Glue the thread to the capture it was started from (plan: chats
    // are scoped to an asset — the thread list shows only this capture's
    // threads, so "what is this thread about" is never ambiguous). Null
    // anchor = a library-wide thread (no capture focused at creation).
    // The anchor is written in the same insert as the rest of the row —
    // one write, not create-then-update.
    const sidecar = await this.deps.store.create({
      threadId: started.threadId,
      name: displayName,
      anchorCaptureId,
      preparedDir
    });
    const view = this.toView(sidecar);
    this.deps.broadcast(this.deps.channels.threadUpdated, { thread: view });
    return view;
  }

  async listThreads(opts: {
    includeArchived?: boolean;
    anchorCaptureId?: string | null;
  } = {}): Promise<LibraryChatThreadView[]> {
    // Filtering (archived + anchor scoping) is pushed into the store's
    // indexed SQL — no full-table scan in TS. When an anchor is supplied
    // the list is scoped to that capture's threads (chats are glued to
    // assets); when omitted, every anchor is listed.
    const sidecars = await this.deps.store.list({
      includeArchived: opts.includeArchived ?? false,
      ...(opts.anchorCaptureId !== undefined ? { anchorCaptureId: opts.anchorCaptureId } : {})
    });
    return sidecars.map((s) => this.toView(s));
  }

  async rename(threadId: string, name: string): Promise<LibraryChatThreadView> {
    const sidecar = await this.deps.store.update(threadId, { name: name.trim() });
    const view = this.toView(sidecar);
    this.deps.broadcast(this.deps.channels.threadUpdated, { thread: view });
    return view;
  }

  async archive(threadId: string, archived: boolean): Promise<LibraryChatThreadView> {
    const sidecar = await this.deps.store.update(threadId, { archived });
    if (archived) await this.deps.client.archiveThread(threadId).catch(() => undefined);
    const view = this.toView(sidecar);
    this.deps.broadcast(this.deps.channels.threadUpdated, { thread: view });
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

    // Per-turn active-capture context (which capture is on screen) goes
    // in a SEPARATE leading turn item, explicitly framed as system-
    // generated and NOT folded into the user's text. Why:
    //   • the agent must not read app-context as the user's words;
    //   • the static system prompt (baseInstructions) stays byte-
    //     identical across turns so Codex can prompt-cache it — dynamic
    //     state rides the turn instead;
    //   • it's emitted only for the CURRENT turn (never accumulated), so
    //     the thread carries no stale `<current_capture>` blocks.
    // Without it the agent has no idea which capture is focused and
    // guesses via library_list — that's how an edit lands on the wrong
    // image. The committed/displayed user message stays the raw
    // `input.text`. Pattern mirrors OpenClaw's runtime-context message.
    const anchorForTurn = input.anchorCaptureId ?? null;
    const turnInput: UserInput[] = [];
    if (anchorForTurn !== null && this.deps.buildTurnContext !== undefined) {
      turnInput.push({
        type: "text",
        text: this.deps.buildTurnContext(anchorForTurn),
        text_elements: []
      });
    }
    turnInput.push({ type: "text", text: input.text, text_elements: [] });

    let turnId: string;
    try {
      const started = await this.deps.client.startTurn({
        threadId,
        input: turnInput,
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
    this.deps.broadcast(this.deps.channels.turnInterrupted, {
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
    this.deps.broadcast(this.deps.channels.streamDelta, {
      threadId,
      turnId,
      messageId: turn.assistantMessageId,
      delta
    });
  }

  private async onTurnCompleted(threadId: string, turnId: string, status: string): Promise<void> {
    const turn = this.turns.get(threadId);
    if (turn === undefined || turn.turnId !== turnId) return;
    await this.finalizeAssistant(threadId, mapTurnStatus(status));
  }

  private async onToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const response = this.deps.dispatchToolCall
      ? await this.deps.dispatchToolCall(params)
      : ({
          contentItems: [
            { type: "inputText", text: "PwrSnap has no tools enabled for this chat yet." }
          ],
          success: false
        } satisfies DynamicToolCallResponse);
    // Surface the tool invocation to the chat UI as it happens (the
    // "Drew an arrow" / "Searched the library" activity chips + the
    // working indicator). Without this the turn looks frozen while the
    // agent runs tools before producing text.
    this.deps.broadcast(this.deps.channels.toolCall, {
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
      tool: params.tool,
      ok: response.success,
      summary: humanizeToolCall(params.tool, response.success, this.deps.toolLabels)
    });
    return response;
  }

  private async onApprovalRequest(method: string, params: unknown): Promise<unknown> {
    // Best-effort extraction of (threadId, turnId) from the params; Codex
    // shapes vary by approval method. We always mint our own approvalId.
    const p = (params ?? {}) as Record<string, unknown>;
    let threadId = typeof p.threadId === "string" ? p.threadId : "";
    let turnId = typeof p.turnId === "string" ? p.turnId : "";

    // Codex doesn't always tag an approval with its (threadId, turnId).
    // Without a threadId the renderer can't match the approval to a
    // visible thread, so the promise below would never resolve and the
    // turn would hang forever. Recover the only-possible thread when
    // exactly one turn is in flight; otherwise auto-DENY (Default Access
    // never auto-APPROVES) with a warning rather than deadlocking.
    if (threadId.length === 0) {
      if (this.turns.size === 1) {
        const [[onlyThreadId, onlyTurn]] = [...this.turns.entries()];
        threadId = onlyThreadId;
        if (turnId.length === 0) turnId = onlyTurn.turnId;
      } else {
        log.warn("approval request without a routable threadId — auto-denying", {
          method,
          inFlightTurns: this.turns.size
        });
        return { decision: "denied" };
      }
    }

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
      this.deps.broadcast(this.deps.channels.approvalRequested, request);
      void this.broadcastThreadStatus(threadId, { kind: "awaiting_approval", approvalId });
    });

    const turn = this.turns.get(threadId);
    void this.broadcastThreadStatus(
      threadId,
      turn ? { kind: "streaming", turnId: turn.turnId } : { kind: "idle" }
    );
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
    this.deps.broadcast(this.deps.channels.messageCommitted, { threadId, message });
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
    this.deps.broadcast(this.deps.channels.threadUpdated, {
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
    return `Chat ${localDateStamp(new Date(this.now()))}`;
  }
}

/** Local-timezone `YYYY-MM-DD` stamp. Deliberately NOT `toISOString()`
 *  (which is UTC): a chat created at 10pm in New York must read as that
 *  day, not tomorrow's UTC date. Uses the runtime's local components. */
export function localDateStamp(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function approvalKey(threadId: string, turnId: string, approvalId: string): string {
  return `${threadId}::${turnId}::${approvalId}`;
}

/** Map a Codex turn-completion status onto the message lifecycle. A turn
 *  that genuinely errored must read as "failed" so the UI offers Retry —
 *  only an explicit interrupt/abort/cancel is "interrupted". Anything
 *  unrecognized is treated as a failure so a silent error never
 *  masquerades as a clean stop. */
function mapTurnStatus(status: string): ChatMessage["status"] {
  switch (status) {
    case "completed":
      return "complete";
    case "interrupted":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    default:
      return "failed";
  }
}

/** Friendly present-tense label for a tool invocation, shown as an
 *  activity chip in the chat while the turn runs. The surface supplies
 *  the label map (`toolLabels` dep); falls back to the raw tool name for
 *  unmapped tools. The `ok` flag lets a failed call read "couldn't …". */
function humanizeToolCall(tool: string, ok: boolean, labels: Record<string, string> = {}): string {
  const label = labels[tool] ?? tool;
  return ok ? label : `Couldn't: ${label.toLowerCase()}`;
}
