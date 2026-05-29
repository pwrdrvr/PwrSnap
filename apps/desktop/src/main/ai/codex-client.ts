import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  InitializeParams,
  InitializeResponse,
  ResponseItem,
  ServerNotification,
  ServerRequest
} from "@pwrsnap/codex-app-server-protocol";
import type {
  AgentMessageDeltaNotification,
  AskForApproval,
  CommandExecutionApprovalDecision,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  FileChangeApprovalDecision,
  ItemCompletedNotification,
  SandboxMode,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartResponse
} from "@pwrsnap/codex-app-server-protocol/v2";
import type {
  ChatApprovalDecision,
  ChatApprovalRequest,
  ChatTurnInputItem,
  EnrichmentResult,
  PwrSnapError
} from "@pwrsnap/shared";
import { JsonRpcConnection, type JsonRpcTransport } from "../codex-app-server/json-rpc";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";
import { getMainLogger } from "../log";
import {
  CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
  CAPTURE_ENRICHMENT_SCHEMA,
  buildCaptureEnrichmentPrompt,
  type CaptureEnrichmentPromptMetadata,
  parseCaptureEnrichmentResponse
} from "./enrichment-schema";

const codexClientLog = getMainLogger("pwrsnap:codex-client");

export type CodexClientTransportFactory = (command: string) => JsonRpcTransport;

export type CodexCaptureEnrichmentRequest = {
  imagePaths: readonly string[];
  metadata: CaptureEnrichmentPromptMetadata;
  abortSignal?: AbortSignal;
};

export type CodexCaptureEnrichmentResponse = {
  result: EnrichmentResult;
  threadId: string;
  turnId: string;
  userAgent: string;
};

export type CodexAppServerClientOptions = {
  command: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  transportFactory?: CodexClientTransportFactory;
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  agentMessages: string[];
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ── Persistent chat sessions (PR-3) ──────────────────────────────────
// The enrichment path above runs one ephemeral turn per client. The
// chat path below keeps a long-lived thread per session and multiplexes
// many sessions over one connection. Notifications + server-initiated
// requests are routed to the right session by `threadId`, then to the
// right turn by `turnId`.

/** A dynamic-tool invocation the agent made this turn — handed to the
 *  session's `onToolCall` for servicing. */
export type ChatToolDispatch = {
  turnId: string;
  callId: string;
  tool: string;
  namespace: string | null;
  arguments: unknown;
};

/** A normalized escalation the agent requested. The session's
 *  `onApprovalRequest` surfaces it to the user and returns a decision. */
export type ChatApprovalAsk = {
  requestId: string;
  /** Raw Codex protocol method, e.g. `item/commandExecution/requestApproval`. */
  method: string;
  kind: ChatApprovalRequest["kind"];
  reason: string | null;
  command: string | null;
  cwd: string | null;
  availableDecisions: ChatApprovalDecision[];
};

export type ChatTurnCompletion = {
  status: "ok" | "cancelled" | "failed";
  finalMessage: string;
  error?: PwrSnapError;
};

export type StartChatSessionParams = {
  /** Stable session id (the chat-store persistence key). */
  sessionId: string;
  /** Scratch directory the agent operates in. */
  cwd: string;
  model?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: AskForApproval;
  baseInstructions?: string;
  dynamicTools: DynamicToolSpec[];
  onToolCall: (call: ChatToolDispatch) => Promise<DynamicToolCallResponse>;
  onApprovalRequest: (
    turnId: string,
    ask: ChatApprovalAsk
  ) => Promise<ChatApprovalDecision>;
};

export type StartChatTurnParams = {
  sessionId: string;
  input: readonly ChatTurnInputItem[];
  signal: AbortSignal;
  onDelta: (itemId: string, delta: string) => void;
  onComplete: (result: ChatTurnCompletion) => void;
};

type ChatTurnRuntime = {
  turnId: string;
  /** Live delta accumulation keyed by itemId — used as the finalMessage
   *  fallback when no agentMessage `item/completed` arrived. */
  deltaByItem: Map<string, string>;
  /** Authoritative completed agent messages, in arrival order. */
  messages: string[];
  settled: boolean;
  onDelta: (itemId: string, delta: string) => void;
  onComplete: (result: ChatTurnCompletion) => void;
};

type ChatSessionRuntime = {
  sessionId: string;
  threadId: string;
  cwd: string;
  onToolCall: StartChatSessionParams["onToolCall"];
  onApprovalRequest: StartChatSessionParams["onApprovalRequest"];
  turns: Map<string, ChatTurnRuntime>;
};

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly transportFactory: CodexClientTransportFactory;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private pendingTurn: PendingTurn | null = null;
  private readonly chatSessions = new Map<string, ChatSessionRuntime>();
  private readonly threadToSession = new Map<string, string>();

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.transportFactory =
      options.transportFactory ??
      ((command) => new StdioJsonRpcTransport({ command }));
  }

  async enrichCapture(
    request: CodexCaptureEnrichmentRequest
  ): Promise<CodexCaptureEnrichmentResponse> {
    const connection = await this.getConnection();
    const initialized = await this.initialize();
    let threadId: string | null = null;
    let turnId: string | null = null;
    let aborted = false;

    const abortHandler = (): void => {
      aborted = true;
      if (threadId && turnId) {
        void connection
          .request("turn/interrupt", { threadId, turnId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            codexClientLog.warn("turn interrupt failed", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
    };

    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    try {
      if (request.abortSignal?.aborted) {
        throw new DOMException("capture enrichment aborted", "AbortError");
      }
      if (request.imagePaths.length === 0) {
        throw new Error("capture enrichment requires at least one image input");
      }
      const imageDataUrls = await Promise.all(request.imagePaths.map((path) => imagePathToDataUrl(path)));

      const threadResponse = (await connection.request(
        "thread/start",
        {
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS
        },
        this.requestTimeoutMs
      )) as ThreadStartResponse;
      threadId = threadResponse.thread.id;

      const turnResponse = (await connection.request(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: buildCaptureEnrichmentPrompt(request.metadata),
              text_elements: []
            },
            ...imageDataUrls.map((url) => ({
              type: "image",
              url
            }))
          ],
          effort: "low",
          outputSchema: CAPTURE_ENRICHMENT_SCHEMA
        },
        this.requestTimeoutMs
      )) as TurnStartResponse;
      turnId = turnResponse.turn.id;

      if (request.abortSignal?.aborted || aborted) {
        throw new DOMException("capture enrichment aborted", "AbortError");
      }

      const rawText = await this.waitForTurn(threadId, turnId);
      const result = parseCaptureEnrichmentResponse(rawText);
      return {
        result,
        threadId,
        turnId,
        userAgent: initialized.userAgent
      };
    } finally {
      request.abortSignal?.removeEventListener("abort", abortHandler);
      if (threadId) {
        await connection
          .request("thread/archive", { threadId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            codexClientLog.warn("thread archive failed", {
              threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
    }
  }

  /**
   * Open a persistent chat thread for a session. Sandboxed
   * (`workspace-write` + `on-request` by default) with the supplied
   * dynamic-tool manifest. Returns once `thread/start` lands; turns are
   * driven separately via {@link startChatTurn}.
   */
  async startChatSession(
    params: StartChatSessionParams
  ): Promise<{ sessionId: string; threadId: string }> {
    const connection = await this.getConnection();
    await this.initialize();
    const threadResponse = (await connection.request(
      "thread/start",
      {
        cwd: params.cwd,
        approvalPolicy: params.approvalPolicy ?? "on-request",
        sandbox: params.sandbox ?? "workspace-write",
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.baseInstructions !== undefined
          ? { baseInstructions: params.baseInstructions }
          : {}),
        dynamicTools: params.dynamicTools
      },
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    const threadId = threadResponse.thread.id;
    this.chatSessions.set(params.sessionId, {
      sessionId: params.sessionId,
      threadId,
      cwd: params.cwd,
      onToolCall: params.onToolCall,
      onApprovalRequest: params.onApprovalRequest,
      turns: new Map()
    });
    this.threadToSession.set(threadId, params.sessionId);
    return { sessionId: params.sessionId, threadId };
  }

  /**
   * Start a turn on an open chat session. Resolves with the `turnId`
   * once `turn/start` lands; streaming text arrives via `onDelta` and
   * the turn settles through `onComplete`. There is intentionally NO
   * completion timeout — an agent turn can legitimately block for
   * minutes on an inline approval card; cancellation is the user's job
   * (abort the supplied signal).
   */
  async startChatTurn(params: StartChatTurnParams): Promise<{ turnId: string }> {
    const session = this.chatSessions.get(params.sessionId);
    if (session === undefined) {
      throw new Error(`codex chat session not found: ${params.sessionId}`);
    }
    const connection = await this.getConnection();
    const turnResponse = (await connection.request(
      "turn/start",
      {
        threadId: session.threadId,
        input: params.input.map(toTurnInput)
      },
      this.requestTimeoutMs
    )) as TurnStartResponse;
    const turnId = turnResponse.turn.id;

    const runtime: ChatTurnRuntime = {
      turnId,
      deltaByItem: new Map(),
      messages: [],
      settled: false,
      onDelta: params.onDelta,
      onComplete: params.onComplete
    };
    session.turns.set(turnId, runtime);

    const onAbort = (): void => {
      void connection
        .request("turn/interrupt", { threadId: session.threadId, turnId }, this.requestTimeoutMs)
        .catch((error: unknown) => {
          codexClientLog.warn("chat turn interrupt failed", {
            turnId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    };
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
    }

    return { turnId };
  }

  /** Archive a chat session's thread and forget its routing. Safe to
   *  call for an unknown sessionId (no-op). */
  async closeChatSession(sessionId: string): Promise<void> {
    const session = this.chatSessions.get(sessionId);
    if (session === undefined) return;
    this.chatSessions.delete(sessionId);
    this.threadToSession.delete(session.threadId);
    const connection = this.connection;
    if (connection !== null) {
      await connection
        .request("thread/archive", { threadId: session.threadId }, this.requestTimeoutMs)
        .catch((error: unknown) => {
          codexClientLog.warn("chat thread archive failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.initializeResponse = null;
    this.chatSessions.clear();
    this.threadToSession.clear();
    if (connection) {
      await connection.close();
    }
  }

  private async initialize(): Promise<InitializeResponse> {
    if (this.initializeResponse) {
      return this.initializeResponse;
    }

    const connection = await this.getConnection();
    const params: InitializeParams = {
      clientInfo: {
        name: "pwrsnap",
        title: "PwrSnap",
        version: "1.0.0-alpha.3"
      },
      capabilities: {
        experimentalApi: true
      }
    };
    const response = (await connection.request(
      "initialize",
      params,
      this.requestTimeoutMs
    )) as InitializeResponse;
    this.initializeResponse = response;
    return response;
  }

  private async getConnection(): Promise<JsonRpcConnection> {
    if (this.connection) {
      return this.connection;
    }

    const connection = new JsonRpcConnection(
      this.transportFactory(this.options.command),
      this.requestTimeoutMs,
      undefined,
      { logContext: { owner: "capture-enrichment" } }
    );
    connection.setNotificationHandler((method, params) => {
      this.handleNotification(method, params);
    });
    connection.setRequestHandler((method, params) => this.handleServerRequest(method, params));
    await connection.connect();
    this.connection = connection;
    return connection;
  }

  private waitForTurn(threadId: string, turnId: string): Promise<string> {
    if (this.pendingTurn) {
      throw new Error("codex capture enrichment already has an active turn");
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurn = null;
        reject(new Error("codex capture enrichment timed out"));
      }, this.turnTimeoutMs);
      this.pendingTurn = {
        threadId,
        turnId,
        agentMessages: [],
        resolve,
        reject,
        timer
      };
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/agentMessage/delta") {
      this.handleChatDelta(params as AgentMessageDeltaNotification);
      return;
    }
    if (method === "item/completed") {
      // Enrichment + chat threads are mutually exclusive per client
      // instance; each handler no-ops for the other's threadId.
      this.handleItemCompleted(params as ItemCompletedNotification);
      this.handleChatItemCompleted(params as ItemCompletedNotification);
      return;
    }
    if (method === "rawResponseItem/completed") {
      this.handleRawResponseItemCompleted(params as ServerNotification["params"]);
      return;
    }
    if (method === "turn/completed") {
      this.handleTurnCompleted(params as TurnCompletedNotification);
      this.handleChatTurnCompleted(params as TurnCompletedNotification);
    }
  }

  private sessionByThread(threadId: string | undefined): ChatSessionRuntime | null {
    if (threadId === undefined) return null;
    const sessionId = this.threadToSession.get(threadId);
    if (sessionId === undefined) return null;
    return this.chatSessions.get(sessionId) ?? null;
  }

  private handleChatDelta(params: AgentMessageDeltaNotification): void {
    const session = this.sessionByThread(params.threadId);
    const turn = session?.turns.get(params.turnId);
    if (session === null || turn === undefined) return;
    const prev = turn.deltaByItem.get(params.itemId) ?? "";
    turn.deltaByItem.set(params.itemId, prev + params.delta);
    turn.onDelta(params.itemId, params.delta);
  }

  private handleChatItemCompleted(params: ItemCompletedNotification): void {
    const session = this.sessionByThread(params.threadId);
    const turn = session?.turns.get(params.turnId);
    if (session === null || turn === undefined) return;
    if (params.item.type === "agentMessage") {
      turn.messages.push(params.item.text);
    }
  }

  private handleChatTurnCompleted(params: TurnCompletedNotification): void {
    const session = this.sessionByThread(params.threadId);
    const turn = session?.turns.get(params.turn.id);
    if (session === null || turn === undefined || turn.settled) return;
    turn.settled = true;
    session.turns.delete(turn.turnId);

    const finalMessage =
      turn.messages.length > 0
        ? turn.messages.join("\n\n")
        : [...turn.deltaByItem.values()].join("");

    if (params.turn.status === "failed") {
      turn.onComplete({
        status: "failed",
        finalMessage,
        error: {
          kind: "unknown",
          code: "chat_turn_failed",
          message: params.turn.error?.message ?? "chat turn failed"
        }
      });
      return;
    }
    if (params.turn.status === "interrupted") {
      turn.onComplete({ status: "cancelled", finalMessage });
      return;
    }
    turn.onComplete({ status: "ok", finalMessage });
  }

  private handleItemCompleted(params: ItemCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) {
      return;
    }
    if (params.item.type === "agentMessage") {
      pending.agentMessages.push(params.item.text);
    }
  }

  private handleRawResponseItemCompleted(params: ServerNotification["params"]): void {
    const pending = this.pendingTurn;
    if (!pending || typeof params !== "object" || params === null) {
      return;
    }
    const maybe = params as { threadId?: unknown; turnId?: unknown; item?: ResponseItem };
    if (maybe.threadId !== pending.threadId || maybe.turnId !== pending.turnId) {
      return;
    }
    const item = maybe.item;
    if (item?.type !== "message" || item.role !== "assistant") {
      return;
    }
    const text = item.content
      .filter((content) => content.type === "output_text")
      .map((content) => content.text)
      .join("");
    if (text) {
      pending.agentMessages.push(text);
    }
  }

  private handleTurnCompleted(params: TurnCompletedNotification): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turn.id !== pending.turnId) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTurn = null;

    if (params.turn.status === "failed") {
      pending.reject(new Error(params.turn.error?.message ?? "codex capture enrichment failed"));
      return;
    }
    if (params.turn.status === "interrupted") {
      pending.reject(new DOMException("capture enrichment aborted", "AbortError"));
      return;
    }

    const rawText = pending.agentMessages.at(-1)?.trim();
    if (!rawText) {
      pending.reject(new Error("codex capture enrichment returned no assistant message"));
      return;
    }
    pending.resolve(rawText);
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "item/tool/call") {
      return this.handleDynamicToolCall(params as DynamicToolCallParams);
    }
    if (method.endsWith("/requestApproval")) {
      return this.handleApprovalRequest(method, params);
    }

    const maybe = params as ServerRequest["params"];
    if (maybe !== undefined) {
      codexClientLog.debug("unhandled codex server request", { method });
    }
    return {};
  }

  private async handleDynamicToolCall(
    params: DynamicToolCallParams
  ): Promise<DynamicToolCallResponse> {
    const session = this.sessionByThread(params?.threadId);
    if (session === null) {
      // Enrichment threads expose no tools.
      return {
        contentItems: [
          {
            type: "inputText",
            text: "PwrSnap capture enrichment does not expose tools during this background run."
          }
        ],
        success: false
      };
    }
    try {
      return await session.onToolCall({
        turnId: params.turnId,
        callId: params.callId,
        tool: params.tool,
        namespace: params.namespace,
        arguments: params.arguments
      });
    } catch (error) {
      return {
        contentItems: [
          {
            type: "inputText",
            text: `Tool "${params.tool}" failed: ${error instanceof Error ? error.message : String(error)}`
          }
        ],
        success: false
      };
    }
  }

  /**
   * Relay a sandbox-escalation request to the session's
   * `onApprovalRequest` and map the user's decision back to the Codex
   * protocol reply. v1 surfaces command-execution + file-change
   * escalations (both reply with a simple `{ decision }`); permissions /
   * elicitation requests aren't exercised by the media agent and are
   * declined without prompting.
   */
  private async handleApprovalRequest(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as {
      threadId?: string;
      turnId?: string;
      itemId?: string;
      approvalId?: string | null;
      reason?: string | null;
      command?: string | null;
      cwd?: string | null;
    };
    const kind: ChatApprovalRequest["kind"] = method.includes("commandExecution")
      ? "command"
      : method.includes("fileChange")
        ? "fileChange"
        : method.includes("permissions")
          ? "permissions"
          : "generic";
    const session = this.sessionByThread(p.threadId);
    if (session === null || (kind !== "command" && kind !== "fileChange")) {
      codexClientLog.debug("declining unsurfaced approval request", { method, kind });
      return kind === "command"
        ? { decision: "decline" satisfies CommandExecutionApprovalDecision }
        : kind === "fileChange"
          ? { decision: "decline" satisfies FileChangeApprovalDecision }
          : {};
    }
    const requestId =
      typeof p.approvalId === "string" && p.approvalId.length > 0
        ? `${p.itemId ?? "item"}:${p.approvalId}`
        : (p.itemId ?? `req-${randomUUID().slice(0, 12)}`);
    const ask: ChatApprovalAsk = {
      requestId,
      method,
      kind,
      reason: typeof p.reason === "string" ? p.reason : null,
      command: typeof p.command === "string" ? p.command : null,
      cwd: typeof p.cwd === "string" ? p.cwd : null,
      availableDecisions: ["approve", "approveForSession", "decline", "cancel"]
    };
    let decision: ChatApprovalDecision;
    try {
      decision = await session.onApprovalRequest(p.turnId ?? "", ask);
    } catch (error) {
      codexClientLog.warn("approval relay failed; cancelling", {
        method,
        error: error instanceof Error ? error.message : String(error)
      });
      decision = "cancel";
    }
    return kind === "command"
      ? { decision: toCommandDecision(decision) }
      : { decision: toFileChangeDecision(decision) };
  }
}

function toTurnInput(
  item: ChatTurnInputItem
): { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string } {
  if (item.type === "text") {
    return { type: "text", text: item.text, text_elements: [] };
  }
  return { type: "image", url: item.url };
}

function toCommandDecision(d: ChatApprovalDecision): CommandExecutionApprovalDecision {
  switch (d) {
    case "approve":
      return "accept";
    case "approveForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

function toFileChangeDecision(d: ChatApprovalDecision): FileChangeApprovalDecision {
  switch (d) {
    case "approve":
      return "accept";
    case "approveForSession":
      return "acceptForSession";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

async function imagePathToDataUrl(imagePath: string): Promise<string> {
  const image = await readFile(imagePath);
  return `data:image/jpeg;base64,${image.toString("base64")}`;
}
