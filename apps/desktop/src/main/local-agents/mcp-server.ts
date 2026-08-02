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
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const LOCAL_AGENT_MCP_PORT = 51_729;

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
          const result = await bus.dispatch(
            "library:search",
            toCaptureSearchRequest(input),
            {
              principal: "mcp",
              localAgent: ctx.commandContext.localAgent
            }
          );
          if (!result.ok) return result;
          return ok({
            detail: input.detail ?? "summary",
            rows: projectLocalAgentSearchRows(
              result.value.rows,
              input.detail ?? "summary"
            )
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
          "Completed media tools return a typed MCP resource link to a five-minute signed localhost URL, plus a capability-protected MCP resource URI fallback. " +
          "Fetch the resource link promptly. Use MCP resources/read only when the client cannot fetch the direct URL. " +
          "Never log, persist, or share a signed media URL."
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
        "capture-edit-preview",
        "pwrsnap://capture/{captureId}/edit/{threadId}/composite",
        "image/png"
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
            "Capability-protected local PwrSnap media. The concrete resource read revalidates the client grant before returning bytes.",
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
        capabilities: []
      });
      writeJsonResponse(res, 503, {
        error: "authorization_unavailable",
        error_description: "PwrSnap cannot display its native approval window"
      });
      return;
    }

    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);
    let decision: LocalAgentConsentDecision;
    try {
      decision = await requestConsent({
        clientId: result.client.client_id,
        clientName: result.client.client_name?.trim() || "Local MCP client",
        requestedCapabilities: result.requestedCapabilities,
        signal: controller.signal
      });
    } catch (cause) {
      oauth.handleConsentDecision({
        transactionId: result.transactionId,
        decision: "deny",
        capabilities: []
      });
      throw cause;
    } finally {
      res.off("close", onClose);
    }
    const completed = oauth.handleConsentDecision({
      transactionId: result.transactionId,
      decision: decision.decision,
      capabilities: decision.capabilities
    });
    if (res.destroyed) return;
    if (completed.kind === "redirect") {
      res.writeHead(302, { location: completed.url, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (completed.kind === "error") {
      writeJsonResponse(res, completed.status, {
        error: completed.error,
        error_description: completed.description
      });
      return;
    }
    writeJsonResponse(res, 500, { error: "server_error" });
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
