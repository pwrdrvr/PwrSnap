import { randomBytes } from "node:crypto";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse
} from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse
} from "express";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  ok,
  type LocalAgentAuditAction,
  type LocalAgentCapability,
  type Result,
  type PwrSnapError
} from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { TRASH_RETENTION_DAYS } from "../persistence/trash-retention";
import {
  LocalAgentGrantService
} from "./local-agent-grants";
import {
  LocalAgentOAuthProvider
} from "./local-agent-oauth";
import type {
  LocalAgentConsentDecision,
  LocalAgentConsentRequest
} from "./local-agent-consent-broker";
import {
  limitLocalAgentMcpList,
  localAgentMcpResultLimit,
  localAgentSearchOrder,
  projectLocalAgentSearchDiscovery,
  projectLocalAgentSearchRows,
  toCaptureSearchRequest
} from "./local-agent-search";
import {
  LocalAgentMcpResourceRegistry,
  type LocalAgentMcpResource
} from "./mcp-resource-registry";
import { LocalAgentSignedUrlService } from "./signed-url";
import { LocalAgentToolService } from "./local-agent-tool-service";
import { LocalAgentAuditService } from "./local-agent-audit";
import {
  createDefaultLocalAgentMcpTools,
  toMcpToolResult,
  validateToolCapability,
  type AnyLocalAgentMcpTool,
  type LocalAgentToolContext
} from "./mcp-tool-registry";

const log = getMainLogger("pwrsnap:local-agent-mcp");
const MCP_PATH = "/mcp";
const MEDIA_PATH = "/media";
const AUTHORIZATION_STATUS_PATH = "/authorize/status";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const BROWSER_AUTHORIZATION_TTL_MS = 5 * 60 * 1_000;
const MAX_BROWSER_AUTHORIZATIONS = 64;
export const LOCAL_AGENT_MCP_PORT = 51_729;

type BrowserAuthorizationResult =
  | { kind: "redirect"; url: string }
  | { kind: "error"; status: number; error: string; description: string };

type BrowserAuthorizationRecord = {
  controller: AbortController;
  expiresAtMs: number;
  result: BrowserAuthorizationResult | null;
};

type GrantService = Pick<
  LocalAgentGrantService,
  | "authenticate"
  | "authorizeClient"
  | "issueOAuthGrant"
  | "list"
  | "recordUsage"
  | "revokeGrant"
>;

export type LocalAgentMcpServerOptions = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  grantService?: GrantService;
  tools?: readonly AnyLocalAgentMcpTool[];
  host?: string;
  port?: number;
  resourceRegistry?: LocalAgentMcpResourceRegistry;
  signedUrls?: LocalAgentSignedUrlService;
  auditService?: LocalAgentAuditService;
  requestConsent?: (
    request: LocalAgentConsentRequest
  ) => Promise<LocalAgentConsentDecision>;
};

export type LocalAgentMcpServerAddress = {
  url: string;
  authorizationUrl: string;
  host: string;
  port: number;
};

export class LocalAgentMcpServer {
  private readonly grantService: GrantService;
  private readonly host: string;
  private readonly port: number;
  private readonly tools: readonly AnyLocalAgentMcpTool[];
  private readonly resourceRegistry: LocalAgentMcpResourceRegistry;
  private readonly signedUrls: LocalAgentSignedUrlService;
  private readonly auditService: LocalAgentAuditService;
  private readonly requestConsent: LocalAgentMcpServerOptions["requestConsent"];
  private server: HttpServer | null = null;
  private address: LocalAgentMcpServerAddress | null = null;
  private oauth: LocalAgentOAuthProvider | null = null;
  private readonly browserAuthorizations = new Map<
    string,
    BrowserAuthorizationRecord
  >();
  private closed = false;

  constructor(options: LocalAgentMcpServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? LOCAL_AGENT_MCP_PORT;
    this.resourceRegistry =
      options.resourceRegistry ?? new LocalAgentMcpResourceRegistry();
    this.signedUrls = options.signedUrls ?? new LocalAgentSignedUrlService();
    this.auditService =
      options.auditService ?? new LocalAgentAuditService(options.settings);
    this.requestConsent = options.requestConsent;
    this.grantService =
      options.grantService ??
      new LocalAgentGrantService({ settings: options.settings, secrets: options.secrets });
    const toolService = new LocalAgentToolService(
      this.resourceRegistry,
      this.signedUrls,
      () =>
        this.address === null
          ? null
          : `http://${this.address.host}:${this.address.port}`
    );
    this.tools =
      options.tools ??
      createDefaultLocalAgentMcpTools({
        search: async (input, ctx) => {
          const limit = localAgentMcpResultLimit(input);
          const request = {
            ...toCaptureSearchRequest(input),
            limit: limit + 1
          };
          const result = await bus.dispatch(
            "library:search",
            request,
            {
              principal: "mcp",
              localAgent: ctx.commandContext.localAgent
            }
          );
          if (!result.ok) return result;
          const page = limitLocalAgentMcpList(result.value.rows, input);
          return ok({
            detail: input.detail ?? "summary",
            order: localAgentSearchOrder(input),
            limit: page.limit,
            hasMore: page.hasMore,
            rows: projectLocalAgentSearchRows(
              page.items,
              input.detail ?? "summary"
            )
          });
        },
        discovery: async (input, ctx) => {
          const limit = localAgentMcpResultLimit(input);
          const result = await bus.dispatch(
            "library:discover",
            { limit: limit + 1 },
            {
              principal: "mcp",
              localAgent: ctx.commandContext.localAgent
            }
          );
          if (!result.ok) return result;
          const discovery = projectLocalAgentSearchDiscovery(result.value);
          const applications = limitLocalAgentMcpList(discovery.applications, input);
          const tags = limitLocalAgentMcpList(discovery.tags, input);
          return ok({
            applications: applications.items,
            tags: tags.items,
            limit: applications.limit,
            hasMore: {
              applications: applications.hasMore,
              tags: tags.hasMore
            }
          });
        },
        deleteToTrash: async (input, ctx) => {
          const commandContext = {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          } as const;
          const existing = await bus.dispatch(
            "library:byId",
            { id: input.captureId },
            commandContext
          );
          if (!existing.ok) return existing;
          if (existing.value === null) {
            return err({
              kind: "validation",
              code: "not_found",
              message: `capture not found: ${input.captureId}`
            });
          }
          if (existing.value.deleted_at !== null) {
            return ok({
              captureId: input.captureId,
              deletedAt: existing.value.deleted_at,
              alreadyInTrash: true,
              restoreAvailable: true,
              retentionDays: TRASH_RETENTION_DAYS
            });
          }
          const deleted = await bus.dispatch(
            "library:delete",
            { id: input.captureId },
            commandContext
          );
          if (!deleted.ok) return deleted;
          return ok({
            captureId: input.captureId,
            deletedAt: new Date().toISOString(),
            alreadyInTrash: false,
            restoreAvailable: true,
            retentionDays: TRASH_RETENTION_DAYS
          });
        },
        metadata: (input, ctx) => toolService.metadata(input, ctx),
        captureResource: (input, ctx) => toolService.captureResource(input, ctx),
        captureExport: (input, ctx) => toolService.captureExport(input, ctx),
        imageEditSend: (input, ctx) => toolService.imageEditSend(input, ctx),
        imageEditStatus: (input, ctx) => toolService.imageEditStatus(input, ctx),
        sizzleCreate: (input, ctx) => toolService.sizzleCreate(input, ctx),
        sizzleSend: (input, ctx) => toolService.sizzleSend(input, ctx),
        sizzleStatus: (input, ctx) => toolService.sizzleStatus(input, ctx),
        sizzleRenderPreview: (input, ctx) =>
          toolService.sizzleRender(input, ctx, "preview"),
        sizzleRenderFull: (input, ctx) =>
          toolService.sizzleRender(input, ctx, "full")
      });
  }

  async start(): Promise<LocalAgentMcpServerAddress> {
    if (this.server !== null && this.address !== null) return this.address;
    if (this.closed) throw new Error("MCP server cannot restart after stop");
    const app = createMcpExpressApp({ host: this.host });
    app.use((req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        res.status(403).json({ error: "non_loopback_client" });
        return;
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        res.status(403).json({ error: "invalid_origin" });
        return;
      }
      if (
        this.address !== null &&
        req.headers.host !== `${this.address.host}:${this.address.port}`
      ) {
        res.status(403).json({ error: "invalid_host" });
        return;
      }
      next();
    });
    try {
      this.server = await listenExpress(app, this.port, this.host);
      const addr = this.server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("MCP server did not bind to a TCP loopback address");
      }
      const boundPort = addr.port;
      this.address = {
        host: this.host,
        port: boundPort,
        url: `http://${this.host}:${boundPort}${MCP_PATH}`,
        authorizationUrl: `http://${this.host}:${boundPort}/authorize`
      };
      const issuerUrl = new URL(`http://${this.host}:${boundPort}`);
      const resourceUrl = new URL(this.address.url);
      this.oauth = new LocalAgentOAuthProvider({
        grantService: this.grantService,
        resourceUrl
      });
      app.get("/authorize", (req: ExpressRequest, res: ExpressResponse) => {
        void this.handleAuthorizationRequest(
          new URL(req.originalUrl, issuerUrl),
          res
        ).catch((cause) => {
          log.warn("OAuth authorization request failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
          if (!res.headersSent) {
            writeJsonResponse(res, 500, { error: "server_error" });
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      });
      app.get(
        AUTHORIZATION_STATUS_PATH,
        (req: ExpressRequest, res: ExpressResponse) => {
          this.handleAuthorizationStatusRequest(
            new URL(req.originalUrl, issuerUrl),
            res
          );
        }
      );
      app.post("/authorize", (_req: ExpressRequest, res: ExpressResponse) => {
        res.setHeader("allow", "GET");
        writeJsonResponse(res, 405, {
          error: "method_not_allowed",
          error_description: "Authorization decisions are accepted only in PwrSnap"
        });
      });
      app.use("/token", tokenHandler({ provider: this.oauth }));
      app.use(
        "/register",
        clientRegistrationHandler({
          clientsStore: this.oauth.clientsStore,
          clientIdGeneration: false
        })
      );
      app.use("/revoke", revocationHandler({ provider: this.oauth }));
      const oauthMetadata: OAuthMetadata = {
        issuer: issuerUrl.href,
        authorization_endpoint: new URL("/authorize", issuerUrl).href,
        token_endpoint: new URL("/token", issuerUrl).href,
        registration_endpoint: new URL("/register", issuerUrl).href,
        revocation_endpoint: new URL("/revoke", issuerUrl).href,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [...LOCAL_AGENT_CAPABILITIES]
      };
      app.use(mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: resourceUrl,
        resourceName: "PwrSnap",
        scopesSupported: [...LOCAL_AGENT_CAPABILITIES]
      }));
      app.use((req: ExpressRequest, res: ExpressResponse) => {
        void this.handleRequest(req, res).catch((cause) => {
          log.warn("MCP request failed", {
            message: cause instanceof Error ? cause.message : String(cause)
          });
          if (!res.headersSent) {
            writeJsonResponse(
              res,
              cause instanceof RequestBodyTooLargeError ? 413 : 500,
              {
                error:
                  cause instanceof RequestBodyTooLargeError
                    ? "request_too_large"
                    : "internal_error"
              }
            );
          } else if (!res.writableEnded) {
            res.end();
          }
        });
      });
      log.info("local MCP server listening", {
        host: this.address.host,
        port: this.address.port,
        transport: "streamable_http"
      });
      return this.address;
    } catch (cause) {
      const server = this.server;
      this.server = null;
      this.address = null;
      this.oauth = null;
      if (server !== null) await closeHttpServer(server).catch(() => undefined);
      throw cause;
    }
  }

  getAddress(): LocalAgentMcpServerAddress | null {
    return this.address;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.browserAuthorizations.values()) {
      record.controller.abort();
    }
    this.browserAuthorizations.clear();
    const server = this.server;
    this.server = null;
    this.address = null;
    this.oauth = null;
    if (server !== null) await closeHttpServer(server);
  }

  private createMcpServer(): McpServer {
    const mcp = new McpServer(
      { name: "PwrSnap", version: "1.0.0" },
      {
        instructions:
          "Use PwrSnap tools only for captures and sizzle assets the user authorized for this local client. " +
          "Completed media tools attach a typed MCP resource link. Pass it directly to the client's media handler; do not copy or reconstruct its URI. " +
          "Use the returned resourceUri only in clients that explicitly support MCP resource reads."
      }
    );
    this.registerTools(mcp);
    this.registerResources(mcp);
    return mcp;
  }

  private registerResources(mcp: McpServer): void {
    const templates = [
      ["capture-composite", "pwrsnap://capture/{captureId}/composite", "image/png"],
      ["capture-original", "pwrsnap://capture/{captureId}/original", "image/png"],
      [
        "capture-export",
        "pwrsnap://capture/{captureId}/export/{exportId}",
        "application/octet-stream"
      ],
      [
        "sizzle-render",
        "pwrsnap://sizzle/{projectId}/{mode}/{renderId}",
        "video/mp4"
      ]
    ] as const;
    for (const [name, template, mimeType] of templates) {
      mcp.registerResource(
        name,
        new ResourceTemplate(template, { list: undefined }),
        {
          title: `PwrSnap ${name}`,
          description:
            "Capability-protected local PwrSnap media. Read only a canonical URI returned by a completed PwrSnap media tool; do not construct URIs from this template. The concrete resource read revalidates the client grant before returning bytes.",
          mimeType
        },
        async (uri, _variables, extra) => {
          const auth = this.authFromExtra(extra);
          if (auth === null) throw new Error("unauthorized");
          const resource = this.resourceRegistry.get(uri.toString());
          try {
            const resolved = await this.resourceRegistry.read(uri.toString(), auth);
            await this.recordUsage(auth.clientId);
            await this.auditResourceRead(resolved.resource, auth.clientId, "success");
            return {
              contents: [
                {
                  uri: uri.toString(),
                  blob: resolved.bytes.toString("base64"),
                  mimeType: resolved.resource.mimeType
                }
              ]
            };
          } catch (cause) {
            if (resource !== undefined) {
              await this.auditResourceRead(resource, auth.clientId, "failure");
            }
            throw cause;
          }
        }
      );
    }
  }

  private registerTools(mcp: McpServer): void {
    for (const tool of this.tools) {
      mcp.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations
        },
        async (
          input: Record<string, unknown>,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>
        ) => {
          const auth = this.authFromExtra(extra);
          if (auth === null) {
            return toMcpToolResult(
              err({
                kind: "validation",
                code: "unauthorized",
                message: "missing or invalid local agent authentication"
              })
            );
          }
          const ctx: LocalAgentToolContext = {
            clientId: auth.clientId,
            capabilities: auth.capabilities,
            signal: extra.signal,
            commandContext: {
              principal: "mcp",
              signal: extra.signal,
              localAgent: {
                clientId: auth.clientId,
                capabilities: auth.capabilities
              }
            }
          };
          const allowed = validateToolCapability(tool, ctx, input);
          if (!allowed.ok) return toMcpToolResult(allowed);
          await this.recordUsage(auth.clientId);
          const result = await tool.dispatch(input, ctx);
          await this.auditToolCall(tool.name, input, ctx, result);
          return toMcpToolResult(result);
        }
      );
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed || this.address === null) {
      writeJsonResponse(res, 503, { error: "closed" });
      return;
    }
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${this.host}:${this.address.port}`
    );
    if (requestUrl.pathname === MEDIA_PATH) {
      await this.handleMediaRequest(req, res, requestUrl);
      return;
    }
    if (requestUrl.pathname !== MCP_PATH) {
      writeJsonResponse(res, 404, { error: "not_found" });
      return;
    }
    await this.handleMcpRequest(req, res, requestUrl);
  }

  private async handleAuthorizationRequest(
    requestUrl: URL,
    res: ServerResponse
  ): Promise<void> {
    const oauth = this.oauth;
    if (oauth === null) {
      writeJsonResponse(res, 503, { error: "authorization_unavailable" });
      return;
    }
    const result = await oauth.handleAuthorizationRequest(requestUrl);
    if (result.kind === "redirect") {
      res.writeHead(302, { location: result.url, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (result.kind === "error") {
      writeJsonResponse(res, result.status, {
        error: result.error,
        error_description: result.description
      });
      return;
    }
    const requestConsent = this.requestConsent;
    if (requestConsent === undefined) {
      oauth.handleConsentDecision({
        transactionId: result.transactionId,
        decision: "deny",
        sessionName: "",
        capabilities: []
      });
      writeJsonResponse(res, 503, {
        error: "authorization_unavailable",
        error_description: "PwrSnap cannot display its native approval window"
      });
      return;
    }

    const browserRequestId = this.createBrowserAuthorization();
    const record = this.browserAuthorizations.get(browserRequestId);
    if (record === undefined) {
      throw new Error("Browser authorization request was not created");
    }
    void this.resolveNativeAuthorization({
      browserRequestId,
      oauth,
      transactionId: result.transactionId,
      clientId: result.client.client_id,
      clientName: result.client.client_name?.trim() || "Local MCP client",
      requestedCapabilities: result.requestedCapabilities,
      signal: record.controller.signal,
      requestConsent
    });
    writeAuthorizationPage(res, {
      statusCode: 200,
      title: "Continue in PwrSnap",
      message:
        "PwrSnap opened a native approval window. Review the Session Name and permissions there to continue.",
      statusUrl: `${AUTHORIZATION_STATUS_PATH}?id=${encodeURIComponent(browserRequestId)}`
    });
  }

  private handleAuthorizationStatusRequest(
    requestUrl: URL,
    res: ServerResponse
  ): void {
    this.pruneBrowserAuthorizations();
    const browserRequestId = requestUrl.searchParams.get("id");
    if (browserRequestId === null) {
      writeAuthorizationPage(res, {
        statusCode: 404,
        title: "Approval request expired",
        message: "Return to your MCP client and start a new PwrSnap login request."
      });
      return;
    }
    const record = this.browserAuthorizations.get(browserRequestId);
    if (record === undefined) {
      writeAuthorizationPage(res, {
        statusCode: 404,
        title: "Approval request expired",
        message: "Return to your MCP client and start a new PwrSnap login request."
      });
      return;
    }
    if (record.result === null) {
      writeAuthorizationPage(res, {
        statusCode: 200,
        title: "Continue in PwrSnap",
        message:
          "PwrSnap is waiting for your decision in its native approval window.",
        statusUrl: `${AUTHORIZATION_STATUS_PATH}?id=${encodeURIComponent(browserRequestId)}`
      });
      return;
    }
    this.browserAuthorizations.delete(browserRequestId);
    if (record.result.kind === "redirect") {
      res.writeHead(302, {
        location: record.result.url,
        "cache-control": "no-store"
      });
      res.end();
      return;
    }
    writeAuthorizationPage(res, {
      statusCode: record.result.status,
      title: "PwrSnap could not complete approval",
      message: record.result.description
    });
  }

  private createBrowserAuthorization(): string {
    this.pruneBrowserAuthorizations();
    if (this.browserAuthorizations.size >= MAX_BROWSER_AUTHORIZATIONS) {
      const oldest = this.browserAuthorizations.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) {
        this.browserAuthorizations.get(oldest)?.controller.abort();
        this.browserAuthorizations.delete(oldest);
      }
    }
    const browserRequestId = randomBytes(32).toString("base64url");
    this.browserAuthorizations.set(browserRequestId, {
      controller: new AbortController(),
      expiresAtMs: Date.now() + BROWSER_AUTHORIZATION_TTL_MS,
      result: null
    });
    return browserRequestId;
  }

  private pruneBrowserAuthorizations(): void {
    const nowMs = Date.now();
    for (const [browserRequestId, record] of this.browserAuthorizations) {
      if (record.expiresAtMs > nowMs) continue;
      record.controller.abort();
      this.browserAuthorizations.delete(browserRequestId);
    }
  }

  private async resolveNativeAuthorization(input: {
    browserRequestId: string;
    oauth: LocalAgentOAuthProvider;
    transactionId: string;
    clientId: string;
    clientName: string;
    requestedCapabilities: readonly LocalAgentCapability[];
    signal: AbortSignal;
    requestConsent: NonNullable<LocalAgentMcpServerOptions["requestConsent"]>;
  }): Promise<void> {
    let decision: LocalAgentConsentDecision;
    try {
      decision = await input.requestConsent({
        clientId: input.clientId,
        clientName: input.clientName,
        requestedCapabilities: input.requestedCapabilities,
        signal: input.signal
      });
    } catch (cause) {
      input.oauth.handleConsentDecision({
        transactionId: input.transactionId,
        decision: "deny",
        sessionName: "",
        capabilities: []
      });
      log.warn("Native MCP authorization failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
      const record = this.browserAuthorizations.get(input.browserRequestId);
      if (record !== undefined) {
        record.result = {
          kind: "error",
          status: 500,
          error: "server_error",
          description: "PwrSnap could not complete the native approval request."
        };
      }
      return;
    }
    const completed = input.oauth.handleConsentDecision({
      transactionId: input.transactionId,
      decision: decision.decision,
      sessionName: decision.sessionName,
      capabilities: decision.capabilities
    });
    const record = this.browserAuthorizations.get(input.browserRequestId);
    if (record !== undefined && completed.kind !== "consent") {
      record.result = completed;
    }
  }

  private async handleMediaRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      writeJsonResponse(res, 405, { error: "method_not_allowed" });
      return;
    }
    const payload = this.signedUrls.verify(requestUrl);
    if (payload === null) {
      writeJsonResponse(res, 403, { error: "invalid_or_expired_media_grant" });
      return;
    }
    const context = await this.grantService.authorizeClient(payload.clientId);
    if (context === null) {
      writeJsonResponse(res, 403, { error: "revoked_or_unknown_client" });
      return;
    }
    try {
      const resolved = await this.resourceRegistry.resolve(
        payload.resourceUri,
        context
      );
      const metadata = await stat(resolved.path);
      const range = parseSingleByteRange(req.headers.range, metadata.size);
      if (range === "invalid") {
        res.writeHead(416, {
          "cache-control": "private, no-store",
          "content-range": `bytes */${metadata.size}`,
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff"
        });
        res.end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, metadata.size - 1);
      const contentLength = metadata.size === 0 ? 0 : end - start + 1;
      res.writeHead(range === null ? 200 : 206, {
        "cache-control": "private, no-store",
        "content-type": resolved.resource.mimeType,
        "content-length": String(contentLength),
        "accept-ranges": "bytes",
        ...(range !== null
          ? { "content-range": `bytes ${start}-${end}/${metadata.size}` }
          : {}),
        "x-content-type-options": "nosniff"
      });
      await this.recordUsage(context.clientId);
      await this.auditResourceRead(resolved.resource, context.clientId, "success");
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(
          resolved.path,
          range === null ? undefined : { start, end }
        );
        stream.once("error", reject);
        res.once("close", resolve);
        stream.pipe(res);
      });
    } catch (cause) {
      if (!res.headersSent) {
        const resource = this.resourceRegistry.get(payload.resourceUri);
        if (resource !== undefined) {
          await this.auditResourceRead(resource, context.clientId, "failure");
        }
        writeJsonResponse(res, 403, {
          error: cause instanceof Error ? cause.message : "resource_forbidden"
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  }

  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const authInfo = await this.authenticateRequest(req);
    if (authInfo === null) {
      const metadataUrl = getOAuthProtectedResourceMetadataUrl(requestUrl);
      res.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${metadataUrl}"`
      );
      writeJsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true
    });
    const mcp = this.createMcpServer();
    await mcp.connect(transport);
    try {
      const webResponse = await transport.handleRequest(
        await toWebRequest(req, requestUrl),
        { authInfo }
      );
      res.writeHead(
        webResponse.status,
        Object.fromEntries(webResponse.headers.entries())
      );
      res.end(Buffer.from(await webResponse.arrayBuffer()));
    } finally {
      await mcp.close().catch(() => undefined);
    }
  }

  private async authenticateRequest(req: IncomingMessage): Promise<AuthInfo | null> {
    const authorization = req.headers.authorization;
    const oauth = this.oauth;
    if (typeof authorization !== "string" || oauth === null) return null;
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    if (match === null) return null;
    try {
      return await oauth.verifyAccessToken(match[1]);
    } catch {
      return null;
    }
  }

  private authFromExtra(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): { clientId: string; capabilities: readonly LocalAgentCapability[] } | null {
    const auth = extra.authInfo;
    if (auth === undefined) return null;
    const caps = auth.extra?.capabilities;
    if (!Array.isArray(caps)) return null;
    const capabilities = caps.filter(
      (cap): cap is LocalAgentCapability =>
        typeof cap === "string" &&
        (LOCAL_AGENT_CAPABILITIES as readonly string[]).includes(cap)
    );
    return { clientId: auth.clientId, capabilities };
  }

  private async recordUsage(clientId: string): Promise<void> {
    try {
      await this.grantService.recordUsage(clientId);
    } catch (cause) {
      log.warn("failed to record local agent usage", {
        clientId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private async auditToolCall(
    toolName: string,
    input: Record<string, unknown>,
    ctx: LocalAgentToolContext,
    result: Result<unknown, PwrSnapError>
  ): Promise<void> {
    const captureId =
      typeof input.captureId === "string" ? input.captureId : null;
    const projectId =
      typeof input.projectId === "string" ? input.projectId : null;
    const audits: Array<{
      action: LocalAgentAuditAction;
      capability: LocalAgentCapability;
      subjectKind: "capture" | "sizzle";
      subjectId: string;
    }> = [];
    if (
      toolName === "pwrsnap_capture_export" &&
      captureId !== null
    ) {
      audits.push({
        action: "capture.export",
        capability: "capture.export",
        subjectKind: "capture",
        subjectId: captureId
      });
      if ((input.variant ?? "composite") === "original") {
        audits.push({
          action: "capture.original.read",
          capability: "capture.original.read",
          subjectKind: "capture",
          subjectId: captureId
        });
      }
    } else if (
      toolName === "pwrsnap_capture_delete_to_trash" &&
      captureId !== null
    ) {
      audits.push({
        action: "trash.write",
        capability: "trash.write",
        subjectKind: "capture",
        subjectId: captureId
      });
    } else if (toolName === "pwrsnap_image_edit_send" && captureId !== null) {
      audits.push({
        action: "capture.edit",
        capability: "capture.edit",
        subjectKind: "capture",
        subjectId: captureId
      });
    } else if (
      toolName === "pwrsnap_sizzle_render_preview" &&
      projectId !== null
    ) {
      audits.push({
        action: "sizzle.preview.read",
        capability: "sizzle.preview.read",
        subjectKind: "sizzle",
        subjectId: projectId
      });
    } else if (
      toolName === "pwrsnap_sizzle_render_full" &&
      projectId !== null
    ) {
      audits.push({
        action: "sizzle.full.read",
        capability: "sizzle.full.read",
        subjectKind: "sizzle",
        subjectId: projectId
      });
    }
    for (const audit of audits) {
      try {
        await this.auditService.record({
          clientId: ctx.clientId,
          ...audit,
          outcome: result.ok ? "success" : "failure"
        });
      } catch (cause) {
        log.warn("failed to record local agent audit entry", {
          clientId: ctx.clientId,
          action: audit.action,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
  }

  private async auditResourceRead(
    resource: LocalAgentMcpResource,
    clientId: string,
    outcome: "success" | "failure"
  ): Promise<void> {
    if (resource.audit === undefined) return;
    try {
      await this.auditService.record({
        clientId,
        ...resource.audit,
        outcome
      });
    } catch (cause) {
      log.warn("failed to record local agent resource audit entry", {
        clientId,
        action: resource.audit.action,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

}

class RequestBodyTooLargeError extends Error {}

function parseSingleByteRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null | "invalid" {
  if (header === undefined) return null;
  if (size <= 0 || !header.startsWith("bytes=") || header.includes(",")) {
    return "invalid";
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function writeJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(body));
}

function writeAuthorizationPage(
  response: ServerResponse,
  input: {
    statusCode: number;
    title: string;
    message: string;
    statusUrl?: string;
  }
): void {
  const refresh =
    input.statusUrl === undefined
      ? ""
      : `<meta http-equiv="refresh" content="1;url=${escapeHtml(input.statusUrl)}">`;
  const waiting =
    input.statusUrl === undefined
      ? ""
      : '<p class="waiting" aria-live="polite">Waiting for PwrSnap…</p>';
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${refresh}
  <title>${escapeHtml(input.title)} · PwrSnap</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #000; color: #f7f4f0; }
    main { width: min(32rem, calc(100vw - 3rem)); }
    .brand { margin: 0 0 2rem; font-size: 1.1rem; font-weight: 750; letter-spacing: -.02em; }
    .brand span { color: #ff8a1f; }
    h1 { margin: 0 0 1rem; font-size: clamp(2rem, 7vw, 3.5rem); line-height: 1; letter-spacing: -.055em; }
    p { color: #c9c4bd; font-size: 1.05rem; line-height: 1.55; }
    .waiting { color: #ff9c43; font-weight: 650; }
    .boundary { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #2e2b28; color: #8f8a84; font-size: .9rem; }
  </style>
</head>
<body>
  <main>
    <p class="brand">Pwr<span>Snap</span></p>
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
    ${waiting}
    <p class="boundary">This browser page cannot approve access. Approval is accepted only in PwrSnap.</p>
  </main>
</body>
</html>`;
  response.writeHead(input.statusCode, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

async function toWebRequest(request: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  const parsedBody = (request as IncomingMessage & { body?: unknown }).body;
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : parsedBody !== undefined
      ? Buffer.from(JSON.stringify(parsedBody), "utf8")
      : await readRequestBody(request);
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined ? { body: body.toString("utf8") } : {})
  });
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function listenExpress(
  app: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string
): Promise<HttpServer> {
  return new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(port, host);
    const handleError = (cause: Error): void => {
      server.off("listening", handleListening);
      reject(cause);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve(server);
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });
}
