import type {
  InitializeParams,
  InitializeResponse
} from "@pwrsnap/codex-app-server-protocol";
import type { Personality, ReasoningEffort } from "@pwrsnap/codex-app-server-protocol";
import type {
  AgentMessageDeltaNotification,
  AskForApproval,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  ErrorNotification,
  ModelReroutedNotification,
  SandboxMode,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSettingsUpdatedNotification,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput
} from "@pwrsnap/codex-app-server-protocol/v2";
import { JsonRpcConnection, type JsonRpcTransport } from "../codex-app-server/json-rpc";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";
import { formatCodexTurnError } from "./codex-error";
import { getMainLogger } from "../log";

const codexThreadClientLog = getMainLogger("pwrsnap:codex-thread-client");

export type CodexThreadClientTransportFactory = (command: string) => JsonRpcTransport;

export type CodexThreadClientOptions = {
  command: string;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  transportFactory?: CodexThreadClientTransportFactory;
};

export type CodexStartThreadOptions = {
  approvalPolicy?: string;
  sandbox?: string;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  cwd?: string;
  runtimeWorkspaceRoots?: string[];
  serviceName?: string;
  personality?: string;
  /** Per-thread Codex config overlay (the `-c key=value` mechanism).
   *  PwrSnap chat/enrichment threads use this to disable Codex prompt/tool
   *  scaffolding that belongs to coding-agent threads. */
  config?: Record<string, unknown>;
  /** Thread environments. **Empty array disables exec-environment
   *  access**, which (per codex-rs core/src/tools/spec_plan.rs — the
   *  shell/exec + apply_patch specs are gated on
   *  `tool_environment_mode().has_environment()`) drops Codex's built-in
   *  shell / unified_exec / apply_patch tools. Our dynamic tools are
   *  added BEFORE that gate, so they survive. */
  environments?: unknown[];
};

export type CodexStartTurnOptions = {
  threadId: string;
  input: UserInput[];
  effort?: string;
};

export type CodexAgentMessageDeltaEvent = {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
};

export type CodexTurnCompletedEvent = {
  threadId: string;
  turnId: string;
  status: string;
};

/** A turn faulted. Codex emits the authoritative error detail on the
 *  `error` notification (ahead of the `turn/completed` status=failed), so
 *  this is what carries the human-readable reason. `willRetry` is Codex's
 *  own signal that it will re-attempt the turn — when false the turn is
 *  terminal and the controller can end it immediately rather than waiting
 *  for a `turn/completed` that may never arrive. */
export type CodexTurnErrorEvent = {
  threadId: string;
  turnId: string;
  /** Already-formatted, transcript-ready message. */
  message: string;
  willRetry: boolean;
};

export type CodexThreadTokenUsageEvent = {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
};

export type CodexThreadSettingsEvent = {
  threadId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
};

export type CodexToolCallHandler = (
  params: DynamicToolCallParams
) => Promise<DynamicToolCallResponse>;

export type CodexApprovalRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export type Unsubscribe = () => void;

// The Codex App Server routes every dynamic-tool invocation as a ServerRequest
// with this method, carrying DynamicToolCallParams. The controller registers a
// single handler; the client returns its DynamicToolCallResponse on the wire.
const TOOL_CALL_METHOD = "item/tool/call";

// Approval ServerRequest methods that the controller may want to answer. These
// are forwarded verbatim (method + params) to the registered approval handler;
// the client returns whatever the handler resolves with.
const APPROVAL_METHODS = new Set<string>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  // Legacy v1 method names — older Codex builds still emit these.
  "applyPatchApproval",
  "execCommandApproval"
]);

/**
 * Long-lived, multi-turn Codex App Server client.
 *
 * Unlike the one-shot {@link CodexAppServerClient}, this client keeps a single
 * codex child process + JSON-RPC connection alive and lets the caller open
 * MULTIPLE threads on it, each carrying its own dynamic tools. It is a thin
 * transport client: it owns the connection lifecycle and routes notifications /
 * server-requests to subscriber callbacks, but bakes in no chat or idle-timing
 * logic — the controller wires those.
 */
export class CodexThreadClient {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly transportFactory: CodexThreadClientTransportFactory;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;

  private readonly agentMessageDeltaListeners = new Set<
    (event: CodexAgentMessageDeltaEvent) => void
  >();
  private readonly turnCompletedListeners = new Set<(event: CodexTurnCompletedEvent) => void>();
  private readonly turnErrorListeners = new Set<(event: CodexTurnErrorEvent) => void>();
  private readonly tokenUsageListeners = new Set<(event: CodexThreadTokenUsageEvent) => void>();
  private readonly threadSettingsListeners = new Set<(event: CodexThreadSettingsEvent) => void>();
  private toolCallHandler: CodexToolCallHandler | null = null;
  private approvalRequestHandler: CodexApprovalRequestHandler | null = null;
  private readonly loadedThreadIds = new Set<string>();

  constructor(private readonly options: CodexThreadClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 120_000;
    this.transportFactory =
      options.transportFactory ?? ((command) => new StdioJsonRpcTransport({ command }));
  }

  async startThread(opts: CodexStartThreadOptions = {}): Promise<{
    threadId: string;
    model: string;
    modelProvider: string;
    serviceTier: string | null;
  }> {
    const connection = await this.getConnection();
    await this.initialize();

    // exactOptionalPropertyTypes: only attach a key when the caller supplied
    // it — never assign `undefined` into a `?: T | null` field. Assigning onto
    // a mutable base (rather than a conditional spread) keeps each property's
    // type free of the `undefined` that the spread literal would otherwise
    // widen it to.
    const params: ThreadStartParams = {
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
    if (opts.cwd !== undefined) {
      params.cwd = opts.cwd;
    }
    if (opts.runtimeWorkspaceRoots !== undefined) {
      params.runtimeWorkspaceRoots = opts.runtimeWorkspaceRoots;
    }
    if (opts.serviceName !== undefined) {
      params.serviceName = opts.serviceName;
    }
    if (opts.approvalPolicy !== undefined) {
      params.approvalPolicy = opts.approvalPolicy as AskForApproval;
    }
    if (opts.sandbox !== undefined) {
      params.sandbox = opts.sandbox as SandboxMode;
    }
    if (opts.baseInstructions !== undefined) {
      params.baseInstructions = opts.baseInstructions;
    }
    if (opts.personality !== undefined) {
      params.personality = opts.personality as Personality;
    }
    if (opts.dynamicTools !== undefined) {
      params.dynamicTools = opts.dynamicTools;
    }
    if (opts.config !== undefined) {
      params.config = opts.config as NonNullable<ThreadStartParams["config"]>;
    }
    if (opts.environments !== undefined) {
      params.environments = opts.environments as NonNullable<ThreadStartParams["environments"]>;
    }

    const response = (await connection.request(
      "thread/start",
      params,
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    const threadId = response.thread.id;
    this.loadedThreadIds.add(threadId);
    codexThreadClientLog.debug("thread started", { threadId });
    return {
      threadId,
      model: response.model,
      modelProvider: response.modelProvider,
      serviceTier: response.serviceTier
    };
  }

  async resumeThread(threadId: string): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) {
      return;
    }
    const connection = await this.getConnection();
    await this.initialize();

    const params: ThreadResumeParams = {
      threadId,
      persistExtendedHistory: false
    };
    const response = (await connection.request(
      "thread/resume",
      params,
      this.requestTimeoutMs
    )) as ThreadResumeResponse;
    this.loadedThreadIds.add(response.thread.id);
    codexThreadClientLog.debug("thread resumed", { threadId: response.thread.id });
  }

  async clearThreadGitInfo(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await this.initialize();
    await connection.request(
      "thread/metadata/update",
      {
        threadId,
        gitInfo: { sha: null, branch: null, originUrl: null }
      },
      this.requestTimeoutMs
    );
  }

  async startTurn(opts: CodexStartTurnOptions): Promise<{ turnId: string }> {
    await this.resumeThread(opts.threadId);
    const connection = await this.getConnection();
    await this.initialize();

    const params: TurnStartParams = {
      threadId: opts.threadId,
      input: opts.input
    };
    if (opts.effort !== undefined) {
      params.effort = opts.effort as ReasoningEffort;
    }

    const response = (await connection.request(
      "turn/start",
      params,
      this.turnTimeoutMs
    )) as TurnStartResponse;
    const turnId = response.turn.id;
    codexThreadClientLog.debug("turn started", { threadId: opts.threadId, turnId });
    return { turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("turn/interrupt", { threadId }, this.requestTimeoutMs);
  }

  async archiveThread(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("thread/archive", { threadId }, this.requestTimeoutMs);
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.initializeResponse = null;
    this.loadedThreadIds.clear();
    if (connection) {
      await connection.close();
    }
  }

  onAgentMessageDelta(cb: (event: CodexAgentMessageDeltaEvent) => void): Unsubscribe {
    this.agentMessageDeltaListeners.add(cb);
    return () => {
      this.agentMessageDeltaListeners.delete(cb);
    };
  }

  onTurnCompleted(cb: (event: CodexTurnCompletedEvent) => void): Unsubscribe {
    this.turnCompletedListeners.add(cb);
    return () => {
      this.turnCompletedListeners.delete(cb);
    };
  }

  onTurnError(cb: (event: CodexTurnErrorEvent) => void): Unsubscribe {
    this.turnErrorListeners.add(cb);
    return () => {
      this.turnErrorListeners.delete(cb);
    };
  }

  onTokenUsageUpdated(cb: (event: CodexThreadTokenUsageEvent) => void): Unsubscribe {
    this.tokenUsageListeners.add(cb);
    return () => {
      this.tokenUsageListeners.delete(cb);
    };
  }

  onThreadSettingsUpdated(cb: (event: CodexThreadSettingsEvent) => void): Unsubscribe {
    this.threadSettingsListeners.add(cb);
    return () => {
      this.threadSettingsListeners.delete(cb);
    };
  }

  onToolCall(handler: CodexToolCallHandler): Unsubscribe {
    this.toolCallHandler = handler;
    return () => {
      if (this.toolCallHandler === handler) {
        this.toolCallHandler = null;
      }
    };
  }

  onApprovalRequest(handler: CodexApprovalRequestHandler): Unsubscribe {
    this.approvalRequestHandler = handler;
    return () => {
      if (this.approvalRequestHandler === handler) {
        this.approvalRequestHandler = null;
      }
    };
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
        experimentalApi: true,
        // PwrSnap's chat surface doesn't proxy through OpenAI's edge
        // attestation flow, so opting in would add per-turn latency for an
        // unused round-trip. Mirrors the one-shot enrichment client.
        requestAttestation: false
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
      { logContext: { owner: "chat-thread" } }
    );
    connection.setNotificationHandler((method, params) => {
      this.handleNotification(method, params);
    });
    connection.setRequestHandler((method, params) => this.handleServerRequest(method, params));
    await connection.connect();
    this.connection = connection;
    return connection;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "error") {
      // A turn faulted. Surface the authoritative reason to subscribers so
      // the controller can end the turn and show it in the transcript —
      // never drop it silently (the bug this fixes: a failed turn read as
      // a bare "Failed" with no cause). See codex-error.ts.
      const notification = params as ErrorNotification;
      const event: CodexTurnErrorEvent = {
        threadId: notification.threadId,
        turnId: notification.turnId,
        message: formatCodexTurnError(notification.error),
        willRetry: notification.willRetry === true
      };
      codexThreadClientLog.warn("codex turn error", {
        threadId: event.threadId,
        turnId: event.turnId,
        willRetry: event.willRetry,
        message: event.message
      });
      for (const listener of this.turnErrorListeners) {
        listener(event);
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const notification = params as AgentMessageDeltaNotification;
      const event: CodexAgentMessageDeltaEvent = {
        threadId: notification.threadId,
        turnId: notification.turnId,
        itemId: notification.itemId,
        delta: notification.delta
      };
      for (const listener of this.agentMessageDeltaListeners) {
        listener(event);
      }
      return;
    }
    if (method === "turn/completed") {
      const notification = params as TurnCompletedNotification;
      const event: CodexTurnCompletedEvent = {
        threadId: notification.threadId,
        turnId: notification.turn.id,
        status: notification.turn.status
      };
      for (const listener of this.turnCompletedListeners) {
        listener(event);
      }
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const notification = params as ThreadTokenUsageUpdatedNotification;
      const event: CodexThreadTokenUsageEvent = {
        threadId: notification.threadId,
        turnId: notification.turnId,
        tokenUsage: notification.tokenUsage
      };
      for (const listener of this.tokenUsageListeners) {
        listener(event);
      }
      return;
    }
    if (method === "thread/settings/updated") {
      const notification = params as ThreadSettingsUpdatedNotification;
      this.emitThreadSettings({
        threadId: notification.threadId,
        model: notification.threadSettings.model,
        modelProvider: notification.threadSettings.modelProvider,
        serviceTier: notification.threadSettings.serviceTier
      });
      return;
    }
    if (method === "model/rerouted") {
      const notification = params as ModelReroutedNotification;
      this.emitThreadSettings({
        threadId: notification.threadId,
        model: notification.toModel,
        modelProvider: "openai",
        serviceTier: null
      });
      return;
    }
    // Unhandled notification — log at debug so a future protocol surface is
    // visible during investigation without spamming the common path.
    codexThreadClientLog.debug("unhandled codex notification", { method });
  }

  private emitThreadSettings(event: CodexThreadSettingsEvent): void {
    for (const listener of this.threadSettingsListeners) {
      listener(event);
    }
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === TOOL_CALL_METHOD) {
      const handler = this.toolCallHandler;
      if (!handler) {
        codexThreadClientLog.warn("tool call received with no handler registered");
        return {
          contentItems: [
            {
              type: "inputText",
              text: "PwrSnap has no tool handler registered for this chat thread."
            }
          ],
          success: false
        } satisfies DynamicToolCallResponse;
      }
      return await handler(params as DynamicToolCallParams);
    }

    if (APPROVAL_METHODS.has(method)) {
      const handler = this.approvalRequestHandler;
      if (!handler) {
        codexThreadClientLog.warn("approval request received with no handler registered", {
          method
        });
        return {};
      }
      return await handler(method, params);
    }

    codexThreadClientLog.debug("unhandled codex server request", { method });
    return {};
  }
}
