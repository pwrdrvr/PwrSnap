// App-wide Codex App Server owner.
//
// agent-kit exposes a pooled ACP client, but the published Codex client owns a
// stdio App Server process per `CodexThreadClient`/`CodexOneShotClient`
// instance. PwrSnap needs one Codex process per (command, CODEX_HOME), with
// per-surface backend views so each chat controller can keep its own tool and
// approval handlers without clobbering siblings. Enrichment shares that owner
// but uses a fresh ephemeral thread for every capture.

import { mkdir } from "node:fs/promises";
import { CodexThreadClient } from "@pwrdrvr/agent-client";
import { isAiReasoningEffort, type CodexModelOption } from "@pwrsnap/shared";
import type {
  AgentBackend,
  AgentBackendApprovalHandler,
  AgentBackendStartThreadResult,
  AgentBackendToolCall,
  AgentBackendToolCallHandler,
  AgentForkThreadOptions,
  AgentStartThreadOptions,
  AgentStartTurnOptions,
  NormalizedApprovalDecision,
  NormalizedTokenUsage,
  NormalizedThreadEvent,
  Unsubscribe
} from "@pwrdrvr/agent-core";
import {
  PWRSNAP_CLIENT_NAME,
  PWRSNAP_CLIENT_TITLE,
  PWRSNAP_SERVICE_NAME,
  toAgentKitLogger
} from "./agent-kit-bindings";
import { getMainLogger } from "../log";
import { getDesktopSettingsStore } from "../settings/desktop-settings-store";
import { withEffectiveCodeModeSettings } from "./codex-thread-config";
import {
  codexEnrichmentPermissionProfile,
  codexEnrichmentThreadSandbox,
  defaultEnrichmentWorkspaceDir,
  denyEnrichmentEscalation,
  type EnrichmentRunDiagnostics,
  type EnrichmentSandboxKind
} from "./enrichment-sandbox";

const log = getMainLogger("pwrsnap:codex-pool");
const MODEL_LIST_TIMEOUT_MS = 20_000;
const ONE_SHOT_REQUEST_TIMEOUT_MS = 20_000;
const ONE_SHOT_TURN_TIMEOUT_MS = 120_000;

type JsonRpcLikeConnection = {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  setNotificationHandler?(handler: (method: string, params: unknown) => void): void;
};

type CodexThreadClientInternals = {
  getConnection(): Promise<JsonRpcLikeConnection>;
  initialize(): Promise<unknown>;
  handleNotification(method: string, params: unknown): void;
};

type CodexViewHandlers = {
  events: Set<(event: NormalizedThreadEvent) => void>;
  toolCall: AgentBackendToolCallHandler | null;
  approval: AgentBackendApprovalHandler | null;
};

export type CodexBackendViewOptions = {
  command: string;
  env?: NodeJS.ProcessEnv;
  loggerScope: string;
};

export type CodexModelListOptions = {
  command: string;
  env: NodeJS.ProcessEnv;
  includeHidden: boolean;
};

export type CodexOneShotPoolRunOptions = {
  command: string;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  threadConfig?: Record<string, unknown>;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
  prompt: string;
  imagePaths?: readonly string[];
  outputSchema?: unknown;
  baseInstructions?: string;
  effort?: string;
  model?: string | null;
  modelProvider?: string | null;
  abortSignal?: AbortSignal;
  /** Identifies the enrichment run, so a denied escalation can be logged
   *  against a specific capture. Omit only in tests/tools. */
  diagnostics?: EnrichmentRunDiagnostics;
};

export type CodexOneShotPoolRunResult = {
  rawText: string;
  threadId: string;
  turnId: string;
  userAgent: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  tokenUsage: NormalizedTokenUsage | null;
};

type CodexOneShotThread = {
  threadId: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
};

class CodexBackendView implements AgentBackend {
  private readonly handlers: CodexViewHandlers = {
    events: new Set(),
    toolCall: null,
    approval: null
  };

  constructor(private readonly owner: CodexAgentOwner) {}

  private async prepareThreadOptions<T extends AgentStartThreadOptions>(
    options: T
  ): Promise<T> {
    if (options.config === undefined) return options;
    return {
      ...options,
      config: await this.owner.prepareThreadConfig(options.config, options.cwd)
    };
  }

  async startThread(options?: AgentStartThreadOptions): Promise<AgentBackendStartThreadResult> {
    const client = await this.owner.compatibleClient();
    const prepared =
      options !== undefined ? await this.prepareThreadOptions(options) : undefined;
    const started = await client.startThread(prepared);
    this.owner.claimThread(started.threadId, this.handlers);
    return started;
  }

  async startTurn(options: AgentStartTurnOptions): Promise<{ turnId: string }> {
    const client = await this.owner.compatibleClient();
    this.owner.claimThread(options.threadId, this.handlers);
    this.owner.markActiveTurn(options.threadId, this.handlers);
    return await client.startTurn(options);
  }

  async interruptTurn(threadId: string): Promise<void> {
    const client = await this.owner.compatibleClient();
    await client.interruptTurn(threadId);
  }

  async forkThread(options: AgentForkThreadOptions): Promise<AgentBackendStartThreadResult> {
    const client = await this.owner.compatibleClient();
    const forked = await client.forkThread(await this.prepareThreadOptions(options));
    this.owner.claimThread(forked.threadId, this.handlers);
    return forked;
  }

  async archiveThread(threadId: string): Promise<void> {
    const client = await this.owner.compatibleClient();
    await client.archiveThread(threadId);
    this.owner.releaseThread(threadId, this.handlers);
  }

  async clearThreadGitInfo(threadId: string): Promise<void> {
    const client = await this.owner.compatibleClient();
    this.owner.claimThread(threadId, this.handlers);
    await client.clearThreadGitInfo(threadId);
  }

  onEvent(cb: (event: NormalizedThreadEvent) => void): Unsubscribe {
    this.handlers.events.add(cb);
    return () => {
      this.handlers.events.delete(cb);
    };
  }

  onToolCall(handler: AgentBackendToolCallHandler): Unsubscribe {
    this.handlers.toolCall = handler;
    return () => {
      if (this.handlers.toolCall === handler) this.handlers.toolCall = null;
    };
  }

  onApprovalRequest(handler: AgentBackendApprovalHandler): Unsubscribe {
    this.handlers.approval = handler;
    return () => {
      if (this.handlers.approval === handler) this.handlers.approval = null;
    };
  }

  async close(): Promise<void> {
    await this.owner.interruptActiveTurnsForHandlers(this.handlers);
    this.owner.releaseHandlers(this.handlers);
  }
}

class CodexAgentOwner {
  readonly client: CodexThreadClient;
  private compatibilityCheck: Promise<void> | null = null;
  private readonly threadHandlers = new Map<string, CodexViewHandlers>();
  private readonly activeTurns = new Map<string, CodexViewHandlers>();
  private readonly rawNotificationListeners = new Set<
    (method: string, params: unknown) => void
  >();
  private closing = false;
  private oneShotQueue: Promise<void> = Promise.resolve();
  private rawNotificationTapInstalled = false;

  constructor(readonly key: string, private readonly options: CodexBackendViewOptions) {
    this.client = new CodexThreadClient({
      command: options.command,
      ...(options.env !== undefined ? { env: options.env } : {}),
      clientName: PWRSNAP_CLIENT_NAME,
      clientTitle: PWRSNAP_CLIENT_TITLE,
      serviceName: PWRSNAP_SERVICE_NAME,
      logger: toAgentKitLogger(options.loggerScope)
    });
    this.client.onEvent((event) => this.routeEvent(event));
    this.client.onToolCall((call) => this.routeToolCall(call));
    this.client.onApprovalRequest((method, params) =>
      this.routeApprovalRequest(method, params)
    );
  }

  view(): AgentBackend {
    return new CodexBackendView(this);
  }

  async compatibleClient(): Promise<CodexThreadClient> {
    const check =
      this.compatibilityCheck ??
      (async () => {
        const env = this.options.env ?? process.env;
        await getDesktopSettingsStore().resolveCompatibleCodexCommand({
          command: this.options.command,
          env
        });
      })();
    this.compatibilityCheck = check;
    try {
      await check;
      return this.client;
    } catch (error) {
      // Let a user upgrade/fix the configured CLI and retry without restarting
      // PwrSnap. Concurrent callers still share the same in-flight probe.
      if (this.compatibilityCheck === check) this.compatibilityCheck = null;
      throw error;
    }
  }

  claimThread(threadId: string, handlers: CodexViewHandlers): void {
    this.threadHandlers.set(threadId, handlers);
  }

  releaseThread(threadId: string, handlers: CodexViewHandlers): void {
    if (this.threadHandlers.get(threadId) === handlers) this.threadHandlers.delete(threadId);
    if (this.activeTurns.get(threadId) === handlers) this.activeTurns.delete(threadId);
  }

  releaseHandlers(handlers: CodexViewHandlers): void {
    handlers.events.clear();
    handlers.toolCall = null;
    handlers.approval = null;
    for (const [threadId, owner] of this.threadHandlers) {
      if (owner === handlers) this.threadHandlers.delete(threadId);
    }
    for (const [threadId, owner] of this.activeTurns) {
      if (owner === handlers) this.activeTurns.delete(threadId);
    }
  }

  markActiveTurn(threadId: string, handlers: CodexViewHandlers): void {
    this.activeTurns.set(threadId, handlers);
  }

  async interruptActiveTurnsForHandlers(handlers: CodexViewHandlers): Promise<void> {
    const threadIds = [...this.activeTurns.entries()]
      .filter(([, owner]) => owner === handlers)
      .map(([threadId]) => threadId);
    await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          await this.client.interruptTurn(threadId);
        } catch (error) {
          log.warn("Codex pooled view active turn interrupt failed", {
            threadId,
            message: error instanceof Error ? error.message : String(error)
          });
        } finally {
          if (this.activeTurns.get(threadId) === handlers) this.activeTurns.delete(threadId);
        }
      })
    );
  }

  async listModels(includeHidden: boolean): Promise<CodexModelOption[]> {
    const { connection } = await this.getInitializedConnection();
    const models: CodexModelOption[] = [];
    let cursor: string | null = null;
    do {
      const response = (await connection.request(
        "model/list",
        { cursor, limit: 100, includeHidden },
        MODEL_LIST_TIMEOUT_MS
      )) as { data?: unknown[]; nextCursor?: string | null };
      const data = Array.isArray(response.data) ? response.data : [];
      models.push(...data.map(toCodexModelOption));
      cursor = response.nextCursor ?? null;
    } while (cursor !== null);
    return models;
  }

  async prepareThreadConfig(
    baseConfig: Record<string, unknown>,
    cwd: string | undefined
  ): Promise<Record<string, unknown>> {
    const { connection } = await this.getInitializedConnection();
    const effectiveConfig = await connection.request(
      "config/read",
      { includeLayers: false, ...(cwd !== undefined ? { cwd } : {}) },
      ONE_SHOT_REQUEST_TIMEOUT_MS
    );
    return withEffectiveCodeModeSettings(baseConfig, effectiveConfig) ?? baseConfig;
  }

  async runOneShot(options: CodexOneShotPoolRunOptions): Promise<CodexOneShotPoolRunResult> {
    if (this.closing) {
      throw new Error("Codex agent owner is closing");
    }
    const run = this.oneShotQueue
      .catch(() => undefined)
      .then(() => {
        if (this.closing) {
          throw new Error("Codex one-shot cancelled because its shared owner closed");
        }
        return this.runOneShotInner(options);
      });
    this.oneShotQueue = run.then(
      () => undefined,
      () => undefined
    );
    return await run;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.threadHandlers.clear();
    this.activeTurns.clear();
    await this.client.close();
  }

  private routeEvent(event: NormalizedThreadEvent): void {
    const threadId = threadIdFromEvent(event);
    if (threadId !== null && event.kind === "turn_completed") {
      this.activeTurns.delete(threadId);
    }
    const handlers = threadId !== null ? this.threadHandlers.get(threadId) : undefined;
    if (handlers !== undefined) {
      for (const listener of handlers.events) listener(event);
      return;
    }
    if (threadId !== null && event.kind === "error") {
      // Unknown-thread errors are still useful diagnostics; there is no safe UI
      // route, so log rather than fan out to unrelated surfaces.
      log.warn("Codex event for unknown thread", { threadId, message: event.message });
    }
  }

  private async routeToolCall(call: AgentBackendToolCall): Promise<unknown> {
    const params = call.params as { threadId?: unknown };
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const handlers = threadId !== null ? this.threadHandlers.get(threadId) : undefined;
    if (handlers?.toolCall === null || handlers?.toolCall === undefined) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "No tool handler is registered for this thread." }]
      };
    }
    return await handlers.toolCall(call);
  }

  private async routeApprovalRequest(
    method: string,
    params: unknown
  ): Promise<NormalizedApprovalDecision> {
    const p = params as { threadId?: unknown };
    const explicitThreadId = typeof p?.threadId === "string" ? p.threadId : null;
    let handlers =
      explicitThreadId !== null ? this.threadHandlers.get(explicitThreadId) : undefined;
    if (handlers === undefined && explicitThreadId === null && this.activeTurns.size === 1) {
      handlers = [...this.activeTurns.values()][0];
    }
    if (handlers?.approval === null || handlers?.approval === undefined) {
      log.warn("Codex approval request without a routed handler; denying", { method });
      return "denied";
    }
    return await handlers.approval(method, params);
  }

  private async runOneShotInner(
    options: CodexOneShotPoolRunOptions
  ): Promise<CodexOneShotPoolRunResult> {
    const { connection, initialized } = await this.getInitializedConnection();
    let thread: CodexOneShotThread | null = null;
    let turnId: string | null = null;
    let turnFinished = false;
    let aborted = false;
    const requestTimeoutMs = options.requestTimeoutMs ?? ONE_SHOT_REQUEST_TIMEOUT_MS;
    // Per-run deny handlers. The thread id isn't known until `thread/start`
    // returns, so it's read through a closure at denial time.
    const handlers = makeOneShotHandlers(
      options.diagnostics ?? null,
      () => thread?.threadId ?? null
    );

    const abortHandler = (): void => {
      aborted = true;
      if (thread !== null && turnId !== null) {
        void connection
          .request(
            "turn/interrupt",
            { threadId: thread.threadId, turnId },
            requestTimeoutMs
          )
          .catch((error: unknown) => {
            log.warn("pooled Codex one-shot turn interrupt failed", {
              threadId: thread?.threadId,
              turnId,
              message: error instanceof Error ? error.message : String(error)
            });
          });
      }
    };
    options.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    try {
      if (isAbortSignalAborted(options.abortSignal)) {
        throw new DOMException("one-shot turn aborted", "AbortError");
      }
      thread = await this.startOneShotThread(options, connection, requestTimeoutMs, handlers);
      const input = [
        { type: "text", text: options.prompt, text_elements: [] },
        ...imagePathsToLocalImageInputs(options.imagePaths ?? [])
      ];
      const turnResponse = (await connection.request(
        "turn/start",
        {
          threadId: thread.threadId,
          model: options.model ?? null,
          input,
          effort: options.effort ?? "low",
          ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {})
        },
        requestTimeoutMs
      )) as { turn?: { id?: unknown } };
      if (typeof turnResponse.turn?.id !== "string") {
        throw new Error("Codex one-shot turn/start returned no turn id");
      }
      turnId = turnResponse.turn.id;
      if (isAbortSignalAborted(options.abortSignal) || aborted) {
        throw new DOMException("one-shot turn aborted", "AbortError");
      }
      const { rawText, tokenUsage } = await this.waitForOneShotTurn({
        threadId: thread.threadId,
        turnId,
        timeoutMs: options.turnTimeoutMs ?? ONE_SHOT_TURN_TIMEOUT_MS,
        handlers
      });
      turnFinished = true;
      return {
        rawText,
        threadId: thread.threadId,
        turnId,
        userAgent:
          typeof initialized.userAgent === "string" ? initialized.userAgent : "codex",
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: thread.serviceTier,
        tokenUsage
      };
    } finally {
      options.abortSignal?.removeEventListener("abort", abortHandler);
      if (thread !== null) {
        this.releaseThread(thread.threadId, handlers);
      }
      if (thread !== null && turnId !== null && !turnFinished) {
        await connection
          .request(
            "turn/interrupt",
            { threadId: thread.threadId, turnId },
            requestTimeoutMs
          )
          .catch((error: unknown) => {
            log.warn("pooled Codex one-shot cleanup interrupt failed", {
              threadId: thread?.threadId,
              turnId,
              message: error instanceof Error ? error.message : String(error)
            });
          });
      }
      if (thread !== null) {
        await connection
          .request("thread/unsubscribe", { threadId: thread.threadId }, requestTimeoutMs)
          .catch((error: unknown) => {
            log.warn("pooled Codex one-shot unsubscribe failed", {
              threadId: thread?.threadId,
              message: error instanceof Error ? error.message : String(error)
            });
          });
      }
    }
  }

  private async getInitializedConnection(): Promise<{
    connection: JsonRpcLikeConnection;
    initialized: { userAgent?: unknown };
  }> {
    const client = await this.compatibleClient();
    const rawClient = client as unknown as CodexThreadClientInternals;
    const connection = await rawClient.getConnection();
    this.installRawNotificationTap(connection, rawClient);
    const initialized = (await rawClient.initialize()) as { userAgent?: unknown };
    return { connection, initialized };
  }

  private installRawNotificationTap(
    connection: JsonRpcLikeConnection,
    rawClient: CodexThreadClientInternals
  ): void {
    if (this.rawNotificationTapInstalled || connection.setNotificationHandler === undefined) {
      return;
    }
    connection.setNotificationHandler((method, params) => {
      rawClient.handleNotification(method, params);
      for (const listener of this.rawNotificationListeners) listener(method, params);
    });
    this.rawNotificationTapInstalled = true;
  }

  private onRawNotification(
    listener: (method: string, params: unknown) => void
  ): Unsubscribe {
    this.rawNotificationListeners.add(listener);
    return () => {
      this.rawNotificationListeners.delete(listener);
    };
  }

  private async startOneShotThread(
    options: CodexOneShotPoolRunOptions,
    connection: JsonRpcLikeConnection,
    requestTimeoutMs: number,
    handlers: CodexViewHandlers
  ): Promise<CodexOneShotThread> {
    const workspaceDir = options.workspaceDir ?? defaultEnrichmentWorkspaceDir();
    const baseInstructions = options.baseInstructions ?? "";
    await mkdir(workspaceDir, { recursive: true });
    const effectiveConfig = await connection.request(
      "config/read",
      { includeLayers: false, cwd: workspaceDir },
      requestTimeoutMs
    );
    const threadConfig = disableConfiguredMcpServers(options.threadConfig, effectiveConfig);

    // Try the READ-SCOPED posture first (a named permissions profile, which
    // denies reads outside the jail), and fall back once to the older
    // `sandbox: "read-only"` if this Codex build rejects it. The fallback is
    // exactly the pre-existing behavior, so it can never be worse than not
    // trying — but it IS weaker (read-only permits reading the whole
    // filesystem), so it logs at warn rather than passing silently.
    const startThreadWith = async (
      kind: EnrichmentSandboxKind
    ): Promise<Record<string, unknown>> =>
      (await connection.request(
        "thread/start",
        {
          model: options.model ?? null,
          ...(options.modelProvider !== null && options.modelProvider !== undefined
            ? { modelProvider: options.modelProvider }
            : {}),
          // The security-relevant posture — ephemeral thread, scratch-dir cwd +
          // workspace roots, no approvals, read scoping, no environments — is
          // owned by `enrichment-sandbox.ts` and pinned by a test. Do NOT
          // inline those fields back here; see AGENTS.md § "Capture enrichment
          // runs in a sandbox jail". (The ephemeral thread is also why we never
          // use thread/rollback: it's deprecated and doesn't remove every
          // per-turn injected context item.)
          ...codexEnrichmentThreadSandbox(workspaceDir, kind),
          serviceName: PWRSNAP_SERVICE_NAME,
          ...(baseInstructions.length > 0 ? { baseInstructions } : {}),
          config: {
            ...(threadConfig ?? {}),
            // The profile the `permissions` id above resolves to. Harmless on
            // the fallback path — an unreferenced profile is inert.
            ...codexEnrichmentPermissionProfile(workspaceDir)
          },
          experimentalRawEvents: false
        },
        requestTimeoutMs
      )) as Record<string, unknown>;

    let threadResponse: {
      thread?: { id?: unknown };
      model?: unknown;
      modelProvider?: unknown;
      serviceTier?: unknown;
    };
    try {
      threadResponse = await startThreadWith("permissions");
    } catch (error) {
      if (!isPermissionsProfileRejection(error)) throw error;
      // Only downgrade when Codex actually REJECTED the profile. A bare catch
      // would let any transient failure — a 20s request timeout on a busy App
      // Server, a user abort — silently drop read scoping for that run on a
      // build that supports it perfectly well.
      log.warn(
        "Codex rejected the read-scoped enrichment permissions profile; " +
          "falling back to sandbox:read-only, which does NOT restrict reads",
        {
          owner: this.key,
          message: error instanceof Error ? error.message : String(error)
        }
      );
      threadResponse = await startThreadWith("sandbox");
    }

    const threadId = threadResponse.thread?.id;
    if (typeof threadId !== "string") {
      throw new Error("Codex one-shot thread/start returned no thread id");
    }
    const worker = {
      threadId,
      model: typeof threadResponse.model === "string" ? threadResponse.model : "",
      modelProvider:
        typeof threadResponse.modelProvider === "string" ? threadResponse.modelProvider : "",
      serviceTier:
        typeof threadResponse.serviceTier === "string" ? threadResponse.serviceTier : null
    };
    log.info("pooled Codex one-shot ephemeral thread created", {
      owner: this.key,
      threadId,
      model: worker.model,
      modelProvider: worker.modelProvider,
      workspaceDir
    });
    this.claimThread(threadId, handlers);
    return worker;
  }

  private waitForOneShotTurn(input: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
    /** The run's handlers — REUSED, not replaced. Claiming a second handler
     *  set here would evict the run's deny handlers for exactly the window in
     *  which an escalation can arrive (a turn in flight), sending approvals
     *  down the pool's generic unrouted-request path: still denied, but logged
     *  at warn with no capture attribution. */
    handlers: CodexViewHandlers;
  }): Promise<{ rawText: string; tokenUsage: NormalizedTokenUsage | null }> {
    return new Promise((resolve, reject) => {
      const agentMessages: string[] = [];
      let tokenUsage: NormalizedTokenUsage | null = null;
      let lastError: string | null = null;
      const unsubscribeRaw = this.onRawNotification((method, params) => {
        const text = oneShotRawAssistantText(method, params, input.threadId, input.turnId);
        if (text.length > 0) agentMessages.push(text);
      });
      const handlers = input.handlers;
      const onEvent = (event: NormalizedThreadEvent): void => {
        if (!eventBelongsToTurn(event, input.threadId, input.turnId)) return;
        if (event.kind === "agent_message") {
          agentMessages.push(event.message.text);
          return;
        }
        if (event.kind === "token_usage") {
          tokenUsage = event.usage;
          return;
        }
        if (event.kind === "error") {
          lastError = event.message;
          return;
        }
        if (event.kind !== "turn_completed") return;
        cleanup();
        if (event.status === "failed") {
          reject(new Error(lastError ?? "Codex one-shot turn failed"));
          return;
        }
        if (event.status === "interrupted" || event.status === "cancelled") {
          reject(new DOMException("one-shot turn aborted", "AbortError"));
          return;
        }
        const rawText = agentMessages.at(-1)?.trim();
        if (!rawText) {
          reject(new Error("Codex one-shot turn returned no assistant message"));
          return;
        }
        resolve({ rawText, tokenUsage });
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Codex one-shot turn timed out"));
      }, input.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeRaw();
        // Drop only THIS turn's listener; the thread claim (and with it the
        // deny handlers) is released by `runOneShotInner`'s finally.
        handlers.events.delete(onEvent);
      };
      handlers.events.add(onEvent);
      this.claimThread(input.threadId, handlers);
    });
  }
}

const owners = new Map<string, CodexAgentOwner>();
/**
 * Handlers for one enrichment one-shot thread.
 *
 * These used to be a single shared `{ toolCall: null, approval: null }`
 * constant, which fell through to the pool's generic "no handler registered →
 * deny" branch: right outcome, but logged at warn with no run identity and
 * indistinguishable from a routing bug. Now every one-shot thread carries its
 * own EXPLICIT deny handlers plus the run's diagnostics, so a screenshot that
 * successfully talks the model into asking for a shell surfaces in the log as
 * an error naming the capture. See `enrichment-sandbox.ts`.
 */
function makeOneShotHandlers(
  diagnostics: EnrichmentRunDiagnostics | null,
  threadId: () => string | null
): CodexViewHandlers {
  return {
    events: new Set(),
    toolCall: async (call) => {
      denyEnrichmentEscalation({
        logger: log,
        backend: "codex",
        kind: "tool_call",
        method: call.method,
        threadId: threadId(),
        diagnostics,
        toolName: toolNameFromParams(call.params)
      });
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Tool use is not available in this thread. Analyze the provided image and metadata only."
          }
        ]
      };
    },
    approval: async (method, params) =>
      denyEnrichmentEscalation({
        logger: log,
        backend: "codex",
        kind: "approval",
        method,
        threadId: threadId(),
        diagnostics,
        toolName: toolNameFromParams(params)
      })
  };
}

/**
 * Fields that name a tool. This list is a security boundary, not a
 * convenience: whatever it matches is logged on an enrichment denial, and on
 * an enrichment turn the untrusted input is the SCREENSHOT — which reaches the
 * approval request through the tool's ARGUMENTS.
 *
 * Two fields look tempting and must stay out:
 *   • `command` — Codex's `CommandExecutionRequestApprovalParams` puts the
 *     literal command line here, top level. A screenshot that talks the model
 *     into `cat ~/.aws/credentials` would otherwise land that string in the
 *     log verbatim.
 *   • `title` — a human-rendered label, which every backend builds out of the
 *     arguments.
 *
 * Losing them costs little: `method` is logged alongside and already says
 * whether this was an exec, a file change, or a tool call.
 */
const TOOL_IDENTITY_KEYS = ["name", "toolName", "tool_name"] as const;

/**
 * Did `thread/start` fail because this Codex build doesn't understand the
 * `permissions` field / profile, as opposed to failing for a transient reason?
 *
 * Only the former justifies retrying with the weaker `sandbox: "read-only"`
 * posture. An abort or a timeout must propagate: downgrading read scoping
 * because the App Server was briefly slow would be a silent security
 * regression, and retrying an aborted start just creates a thread nobody
 * wants.
 *
 * Matching is on the message because the App Server reports config/schema
 * problems as JSON-RPC -32600 "Invalid request" with the detail in the text
 * (e.g. "unknown field `permissions`", "`permissions` cannot be combined with
 * `sandbox`", "failed to load configuration: ... permissions"). Unrecognized
 * shapes are NOT in this set on purpose — Codex accepts those and fails
 * closed, which is the behavior we want and must not trade away.
 */
function isPermissionsProfileRejection(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/i.test(message)) return false;
  return /permission/i.test(message);
}

/** Best-effort tool identity from a backend-shaped params blob. Reads only
 *  `TOOL_IDENTITY_KEYS` — never arguments. */
function toolNameFromParams(params: unknown): string | null {
  const record = asRecord(params);
  if (record === null) return null;
  const toolCall = asRecord(record["toolCall"]);
  for (const source of [record, toolCall]) {
    if (source === null) continue;
    for (const key of TOOL_IDENTITY_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

function codexOwnerKey(command: string, env: NodeJS.ProcessEnv | undefined): string {
  return JSON.stringify([command, env?.["CODEX_HOME"] ?? ""]);
}

function getCodexOwner(options: CodexBackendViewOptions): CodexAgentOwner {
  const key = codexOwnerKey(options.command, options.env);
  const existing = owners.get(key);
  if (existing !== undefined) return existing;
  const owner = new CodexAgentOwner(key, options);
  owners.set(key, owner);
  log.info("Codex pool owner created", {
    command: options.command,
    codexHome: options.env?.["CODEX_HOME"] ?? null
  });
  return owner;
}

export function acquireCodexAgentBackendView(options: CodexBackendViewOptions): AgentBackend {
  return getCodexOwner(options).view();
}

export async function listCodexModelsFromPool(options: CodexModelListOptions): Promise<CodexModelOption[]> {
  return await getCodexOwner({
    command: options.command,
    env: options.env,
    loggerScope: "pwrsnap:codex-pool"
  }).listModels(options.includeHidden);
}

export async function runCodexOneShotFromPool(
  options: CodexOneShotPoolRunOptions
): Promise<CodexOneShotPoolRunResult> {
  return await getCodexOwner({
    command: options.command,
    ...(options.env !== undefined ? { env: options.env } : {}),
    loggerScope: "pwrsnap:codex-pool"
  }).runOneShot(options);
}

export async function closeCodexAgentPool(): Promise<void> {
  const closing = [...owners.values()];
  owners.clear();
  await Promise.all(closing.map((owner) => owner.close().catch(() => undefined)));
}

function threadIdFromEvent(event: NormalizedThreadEvent): string | null {
  if ("threadId" in event && typeof event.threadId === "string") return event.threadId;
  if (event.kind === "thread_settings") return event.settings.threadId;
  return null;
}

function eventBelongsToTurn(
  event: NormalizedThreadEvent,
  threadId: string,
  turnId: string
): boolean {
  if (!("threadId" in event) || event.threadId !== threadId) return false;
  if ("turnId" in event && event.turnId !== turnId) return false;
  return true;
}

function imagePathsToLocalImageInputs(
  imagePaths: readonly string[]
): Array<{ type: "localImage"; path: string }> {
  return imagePaths.map((path) => ({ type: "localImage", path }));
}

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * An empty `mcp_servers` overlay does not erase lower config layers: Codex
 * recursively merges TOML tables. Read only the effective server names and pin
 * each one off in the one-shot layer. Do not copy commands, env, or credentials
 * from `config/read` into the request.
 */
function disableConfiguredMcpServers(
  baseConfig: Record<string, unknown> | undefined,
  configReadResponse: unknown
): Record<string, unknown> | undefined {
  const preservedBaseConfig = withEffectiveCodeModeSettings(
    baseConfig,
    configReadResponse
  );
  const effectiveConfig = asRecord(asRecord(configReadResponse)?.["config"]);
  const configuredServers = asRecord(effectiveConfig?.["mcp_servers"]);
  const baseServers = asRecord(preservedBaseConfig?.["mcp_servers"]);
  const serverNames = new Set([
    ...Object.keys(configuredServers ?? {}),
    ...Object.keys(baseServers ?? {})
  ]);
  if (serverNames.size === 0) return preservedBaseConfig;
  return {
    ...(preservedBaseConfig ?? {}),
    mcp_servers: Object.fromEntries(
      [...serverNames].map((name) => [name, { enabled: false }])
    )
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function oneShotRawAssistantText(
  method: string,
  params: unknown,
  threadId: string,
  turnId: string
): string {
  if (method !== "rawResponseItem/completed") return "";
  if (typeof params !== "object" || params === null) return "";
  const maybe = params as {
    threadId?: unknown;
    turnId?: unknown;
    item?: {
      type?: unknown;
      role?: unknown;
      content?: unknown;
    };
  };
  if (maybe.threadId !== threadId || maybe.turnId !== turnId) return "";
  if (maybe.item?.type !== "message" || maybe.item.role !== "assistant") return "";
  if (!Array.isArray(maybe.item.content)) return "";
  return maybe.item.content
    .map((content) => {
      if (typeof content !== "object" || content === null) return "";
      const item = content as { type?: unknown; text?: unknown };
      return item.type === "output_text" && typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function toCodexModelOption(raw: unknown): CodexModelOption {
  const model = raw as {
    id?: unknown;
    model?: unknown;
    displayName?: unknown;
    description?: unknown;
    hidden?: unknown;
    supportedReasoningEfforts?: unknown;
    defaultReasoningEffort?: unknown;
    inputModalities?: unknown;
    defaultServiceTier?: unknown;
    isDefault?: unknown;
  };
  const id = typeof model.id === "string" ? model.id : "";
  const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? [
        ...new Set(
          model.supportedReasoningEfforts
            .map((item) =>
              typeof item === "string"
                ? item
                : typeof item === "object" && item !== null
                  ? (item as { reasoningEffort?: unknown }).reasoningEffort
                  : undefined
            )
            .filter(isAiReasoningEffort)
        )
      ]
    : [];
  return {
    id,
    model: typeof model.model === "string" ? model.model : id,
    displayName: typeof model.displayName === "string" ? model.displayName : id,
    description: typeof model.description === "string" ? model.description : "",
    hidden: model.hidden === true,
    supportedReasoningEfforts,
    defaultReasoningEffort: isAiReasoningEffort(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : null,
    inputModalities: Array.isArray(model.inputModalities)
      ? model.inputModalities.filter(
          (item): item is "text" | "image" => item === "text" || item === "image"
        )
      : [],
    defaultServiceTier:
      typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : null,
    isDefault: model.isDefault === true
  };
}
