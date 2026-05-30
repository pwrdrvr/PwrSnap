import type {
  InitializeParams,
  InitializeResponse,
  ResponseItem,
  ServerNotification,
  ServerRequest
} from "@pwrsnap/codex-app-server-protocol";
import type {
  DynamicToolCallResponse,
  ItemCompletedNotification,
  Model,
  ModelListResponse,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartResponse,
  UserInput
} from "@pwrsnap/codex-app-server-protocol/v2";
import type { CodexModelOption, EnrichmentResult } from "@pwrsnap/shared";
import { JsonRpcConnection, type JsonRpcTransport } from "../codex-app-server/json-rpc";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";
import { getMainLogger } from "../log";
import { PWRSNAP_CODEX_THREAD_CONFIG } from "./codex-thread-config";
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
  model?: string | null;
  abortSignal?: AbortSignal;
};

export type CodexCaptureEnrichmentResponse = {
  result: EnrichmentResult;
  threadId: string;
  turnId: string;
  userAgent: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  tokenUsage: ThreadTokenUsage | null;
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
  tokenUsage: ThreadTokenUsage | null;
  resolve: (value: { rawText: string; tokenUsage: ThreadTokenUsage | null }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type EnrichmentThread = {
  threadId: string;
  modelKey: string;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
};

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly transportFactory: CodexClientTransportFactory;
  private connection: JsonRpcConnection | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private pendingTurn: PendingTurn | null = null;
  private enrichmentThread: EnrichmentThread | null = null;
  private enrichmentQueue: Promise<void> = Promise.resolve();

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
    const run = this.enrichmentQueue
      .catch(() => undefined)
      .then(() => this.enrichCaptureInner(request));
    this.enrichmentQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async enrichCaptureInner(
    request: CodexCaptureEnrichmentRequest
  ): Promise<CodexCaptureEnrichmentResponse> {
    const connection = await this.getConnection();
    const initialized = await this.initialize();
    let thread: EnrichmentThread | null = null;
    let turnId: string | null = null;
    let rolledBack = false;
    let aborted = false;

    const abortHandler = (): void => {
      aborted = true;
      if (thread && turnId) {
        void connection
          .request("turn/interrupt", { threadId: thread.threadId, turnId }, this.requestTimeoutMs)
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

      thread = await this.getEnrichmentThread(request.model ?? null);

      const turnResponse = (await connection.request(
        "turn/start",
        {
          threadId: thread.threadId,
          model: request.model ?? null,
          input: [
            {
              type: "text",
              text: buildCaptureEnrichmentPrompt(request.metadata),
              text_elements: []
            },
            ...imagePathsToLocalImageInputs(request.imagePaths)
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

      const { rawText, tokenUsage } = await this.waitForTurn(thread.threadId, turnId);
      const result = parseCaptureEnrichmentResponse(rawText);
      await this.rollbackEnrichmentThread(thread.threadId);
      rolledBack = true;
      return {
        result,
        threadId: thread.threadId,
        turnId,
        userAgent: initialized.userAgent,
        model: thread.model,
        modelProvider: thread.modelProvider,
        serviceTier: thread.serviceTier,
        tokenUsage
      };
    } finally {
      request.abortSignal?.removeEventListener("abort", abortHandler);
      if (thread && turnId && !rolledBack) {
        await this.rollbackEnrichmentThread(thread.threadId).catch((error: unknown) => {
          codexClientLog.warn("enrichment thread rollback failed", {
            threadId: thread?.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    const thread = this.enrichmentThread;
    this.connection = null;
    this.initializeResponse = null;
    this.enrichmentThread = null;
    this.enrichmentQueue = Promise.resolve();
    if (connection) {
      if (thread) {
        await connection
          .request("thread/archive", { threadId: thread.threadId }, this.requestTimeoutMs)
          .catch((error: unknown) => {
            codexClientLog.warn("thread archive failed", {
              threadId: thread.threadId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      await connection.close();
    }
  }

  async listModels(input: { includeHidden?: boolean } = {}): Promise<CodexModelOption[]> {
    const connection = await this.getConnection();
    await this.initialize();
    const models: CodexModelOption[] = [];
    let cursor: string | null = null;
    do {
      const response = (await connection.request(
        "model/list",
        { cursor, limit: 100, includeHidden: input.includeHidden ?? false },
        this.requestTimeoutMs
      )) as ModelListResponse;
      models.push(...response.data.map(modelToOption));
      cursor = response.nextCursor;
    } while (cursor !== null);
    return models;
  }

  private async getEnrichmentThread(model: string | null): Promise<EnrichmentThread> {
    const modelKey = model ?? "__default__";
    if (this.enrichmentThread?.modelKey === modelKey) {
      return this.enrichmentThread;
    }
    if (this.enrichmentThread) {
      const stale = this.enrichmentThread;
      this.enrichmentThread = null;
      const connection = await this.getConnection();
      await connection
        .request("thread/archive", { threadId: stale.threadId }, this.requestTimeoutMs)
        .catch((error: unknown) => {
          codexClientLog.warn("thread archive failed", {
            threadId: stale.threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }

    const connection = await this.getConnection();
    const threadResponse = (await connection.request(
      "thread/start",
      {
        model,
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "read-only",
        baseInstructions: CAPTURE_ENRICHMENT_BASE_INSTRUCTIONS,
        // Persistent worker thread for a cache experiment: keep the thread id
        // stable across enrichments, then roll back each capture turn.
        config: PWRSNAP_CODEX_THREAD_CONFIG,
        environments: [],
        experimentalRawEvents: false,
        persistExtendedHistory: false
      },
      this.requestTimeoutMs
    )) as ThreadStartResponse;
    this.enrichmentThread = {
      threadId: threadResponse.thread.id,
      modelKey,
      model: threadResponse.model,
      modelProvider: threadResponse.modelProvider,
      serviceTier: threadResponse.serviceTier
    };
    return this.enrichmentThread;
  }

  private async rollbackEnrichmentThread(threadId: string): Promise<void> {
    const connection = await this.getConnection();
    await connection.request("thread/rollback", { threadId, numTurns: 1 }, this.requestTimeoutMs);
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
        // `requestAttestation` controls whether Codex sends
        // attestation/generate ServerRequests for x-oai-attestation
        // headers. PwrSnap's chat surface doesn't need this round-trip
        // — we don't proxy through OpenAI's edge attestation flow —
        // and opting in would add per-turn latency for a feature we
        // don't use. Mirrors PwrAgnt's default. Added when the
        // --experimental protocol regen surfaced this field.
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

  private waitForTurn(
    threadId: string,
    turnId: string
  ): Promise<{ rawText: string; tokenUsage: ThreadTokenUsage | null }> {
    if (this.pendingTurn) {
      throw new Error("codex capture enrichment already has an active turn");
    }

    return new Promise<{ rawText: string; tokenUsage: ThreadTokenUsage | null }>(
      (resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurn = null;
        reject(new Error("codex capture enrichment timed out"));
      }, this.turnTimeoutMs);
      this.pendingTurn = {
        threadId,
        turnId,
        agentMessages: [],
        tokenUsage: null,
        resolve,
        reject,
        timer
      };
      }
    );
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "item/completed") {
      this.handleItemCompleted(params as ItemCompletedNotification);
      return;
    }
    if (method === "rawResponseItem/completed") {
      this.handleRawResponseItemCompleted(params as ServerNotification["params"]);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      this.handleThreadTokenUsageUpdated(params as ThreadTokenUsageUpdatedNotification);
      return;
    }
    if (method === "turn/completed") {
      this.handleTurnCompleted(params as TurnCompletedNotification);
    }
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
    pending.resolve({ rawText, tokenUsage: pending.tokenUsage });
  }

  private handleThreadTokenUsageUpdated(
    params: ThreadTokenUsageUpdatedNotification
  ): void {
    const pending = this.pendingTurn;
    if (!pending || params.threadId !== pending.threadId || params.turnId !== pending.turnId) {
      return;
    }
    pending.tokenUsage = params.tokenUsage;
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "item/tool/call") {
      return {
        contentItems: [
          {
            type: "inputText",
            text: "PwrSnap capture enrichment does not expose tools during this background run."
          }
        ],
        success: false
      } satisfies DynamicToolCallResponse;
    }

    const maybe = params as ServerRequest["params"];
    if (maybe !== undefined) {
      codexClientLog.debug("unhandled codex server request", { method });
    }
    return {};
  }
}

function modelToOption(model: Model): CodexModelOption {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    inputModalities: model.inputModalities,
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault
  };
}

function imagePathsToLocalImageInputs(imagePaths: readonly string[]): UserInput[] {
  return imagePaths.map((path) => ({
    // Do not inline a base64 data URL here: the Codex bridge can account
    // that payload like fresh text/context. `localImage` lets App Server
    // read the prepared JPEG as an image input.
    type: "localImage",
    path
  }));
}
