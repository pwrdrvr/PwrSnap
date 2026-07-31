import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  ok,
  type LocalAgentAuditAction,
  type LocalAgentCapability,
  type Result,
  type PwrSnapError
} from "@pwrsnap/shared";
import { z } from "zod";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { TRASH_RETENTION_DAYS } from "../persistence/trash-retention";
import {
  LocalAgentGrantService,
  type LocalAgentAuthResult
} from "./local-agent-grants";
import type { LocalAgentPairingApprovalRequest } from "./local-agent-pairing";
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
const PAIR_PATH = "/pair";
const MEDIA_PATH = "/media";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const PairingRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  capabilities: z.array(z.enum(LOCAL_AGENT_CAPABILITIES))
    .min(1)
    .max(LOCAL_AGENT_CAPABILITIES.length)
}).strict();

type GrantService = Pick<
  LocalAgentGrantService,
  "authenticate" | "authorizeClient" | "createGrant" | "recordUsage"
>;

export type LocalAgentMcpServerOptions = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  grantService?: GrantService;
  tools?: readonly AnyLocalAgentMcpTool[];
  host?: string;
  port?: number;
  discoveryFilePath?: string;
  approvePairing?: (request: LocalAgentPairingApprovalRequest) => Promise<boolean>;
  resourceRegistry?: LocalAgentMcpResourceRegistry;
  signedUrls?: LocalAgentSignedUrlService;
  auditService?: LocalAgentAuditService;
};

export type LocalAgentMcpServerAddress = {
  url: string;
  pairUrl: string;
  host: string;
  port: number;
};

export type LocalAgentMcpDiscoveryDescriptor = {
  schemaVersion: 1;
  mcpUrl: string;
  pairUrl: string;
  pid: number;
  startedAt: string;
};

export class LocalAgentMcpServer {
  private readonly grantService: GrantService;
  private readonly host: string;
  private readonly port: number;
  private readonly tools: readonly AnyLocalAgentMcpTool[];
  private readonly discoveryFilePath: string | undefined;
  private readonly approvePairing:
    | ((request: LocalAgentPairingApprovalRequest) => Promise<boolean>)
    | undefined;
  private readonly resourceRegistry: LocalAgentMcpResourceRegistry;
  private readonly signedUrls: LocalAgentSignedUrlService;
  private readonly auditService: LocalAgentAuditService;
  private server: HttpServer | null = null;
  private address: LocalAgentMcpServerAddress | null = null;
  private closed = false;
  private pairingPending = false;

  constructor(options: LocalAgentMcpServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.discoveryFilePath = options.discoveryFilePath;
    this.approvePairing = options.approvePairing;
    this.resourceRegistry =
      options.resourceRegistry ?? new LocalAgentMcpResourceRegistry();
    this.signedUrls = options.signedUrls ?? new LocalAgentSignedUrlService();
    this.auditService =
      options.auditService ?? new LocalAgentAuditService(options.settings);
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
          return ok({ rows: projectLocalAgentSearchRows(result.value.rows) });
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
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((cause) => {
        log.warn("MCP request failed", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
        if (!res.headersSent) {
          writeJsonResponse(
            res,
            cause instanceof RequestBodyTooLargeError ? 413 : 500,
            { error: cause instanceof RequestBodyTooLargeError ? "request_too_large" : "internal_error" }
          );
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });
    await listen(this.server, this.port, this.host);
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("MCP server did not bind to a TCP loopback address");
    }
    const boundPort = (addr as AddressInfo).port;
    this.address = {
      host: this.host,
      port: boundPort,
      url: `http://${this.host}:${boundPort}${MCP_PATH}`,
      pairUrl: `http://${this.host}:${boundPort}${PAIR_PATH}`
    };
    try {
      await this.writeDiscoveryDescriptor();
    } catch (cause) {
      await closeHttpServer(this.server);
      this.server = null;
      this.address = null;
      throw cause;
    }
    log.info("local MCP server listening", {
      host: this.address.host,
      port: this.address.port,
      transport: "streamable_http"
    });
    return this.address;
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
    if (server !== null) await closeHttpServer(server);
    if (this.discoveryFilePath !== undefined) {
      await unlink(this.discoveryFilePath).catch(() => undefined);
    }
  }

  private createMcpServer(): McpServer {
    const mcp = new McpServer(
      { name: "PwrSnap", version: "1.0.0" },
      {
        instructions:
          "Use PwrSnap tools only for captures and sizzle assets the paired user granted to this local client."
      }
    );
    this.registerTools(mcp);
    this.registerResources(mcp);
    return mcp;
  }

  private registerResources(mcp: McpServer): void {
    const templates = [
      ["capture-composite", "pwrsnap://capture/{captureId}/composite"],
      ["capture-original", "pwrsnap://capture/{captureId}/original"],
      ["capture-export", "pwrsnap://capture/{captureId}/export/{exportId}"],
      [
        "capture-edit-preview",
        "pwrsnap://capture/{captureId}/edit/{threadId}/composite"
      ],
      ["sizzle-render", "pwrsnap://sizzle/{projectId}/{mode}/{renderId}"]
    ] as const;
    for (const [name, template] of templates) {
      mcp.registerResource(
        name,
        new ResourceTemplate(template, { list: undefined }),
        {
          title: `PwrSnap ${name}`,
          description: "Capability-protected local PwrSnap media",
          mimeType: "application/octet-stream"
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
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      writeJsonResponse(res, 403, { error: "non_loopback_client" });
      return;
    }
    if (req.headers.host !== `${this.host}:${this.address.port}`) {
      writeJsonResponse(res, 403, { error: "invalid_host" });
      return;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      writeJsonResponse(res, 403, { error: "invalid_origin" });
      return;
    }
    const requestUrl = new URL(
      req.url ?? "/",
      `http://${this.host}:${this.address.port}`
    );
    if (requestUrl.pathname === PAIR_PATH) {
      await this.handlePairingRequest(req, res);
      return;
    }
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
      res.writeHead(200, {
        "cache-control": "private, no-store",
        "content-type": resolved.resource.mimeType,
        "content-length": String(metadata.size),
        "x-content-type-options": "nosniff"
      });
      await this.recordUsage(context.clientId);
      await this.auditResourceRead(resolved.resource, context.clientId, "success");
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(resolved.path);
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

  private async handlePairingRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      writeJsonResponse(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (this.approvePairing === undefined) {
      writeJsonResponse(res, 404, { error: "pairing_unavailable" });
      return;
    }
    if (this.pairingPending) {
      writeJsonResponse(res, 409, { error: "pairing_in_progress" });
      return;
    }
    const body = await readJsonBody(req);
    const parsed = PairingRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeJsonResponse(res, 400, {
        error: "invalid_pairing_request",
        issues: parsed.error.issues.map((issue) => issue.message)
      });
      return;
    }
    const capabilities = [...new Set(parsed.data.capabilities)];
    this.pairingPending = true;
    try {
      const approved = await this.approvePairing({
        name: parsed.data.name,
        capabilities
      });
      if (!approved) {
        writeJsonResponse(res, 403, { error: "pairing_denied" });
        return;
      }
      const result = await this.grantService.createGrant({
        name: parsed.data.name,
        capabilities
      });
      res.setHeader("cache-control", "no-store");
      writeJsonResponse(res, 201, {
        clientId: result.grant.id,
        token: result.token,
        mcpUrl: this.address?.url,
        capabilities: result.grant.capabilities
      });
    } finally {
      this.pairingPending = false;
    }
  }

  private async handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const auth = await this.authenticateRequest(req);
    if (auth === null) {
      res.setHeader("www-authenticate", 'Bearer realm="pwrsnap-mcp"');
      writeJsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    const credential = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const authInfo: AuthInfo = {
      token: credential,
      clientId: auth.context.clientId,
      scopes: [...auth.context.capabilities],
      extra: {
        capabilities: [...auth.context.capabilities]
      }
    };
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

  private async authenticateRequest(
    req: IncomingMessage
  ): Promise<Extract<LocalAgentAuthResult, { ok: true }> | null> {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string") return null;
    const match = /^Bearer\s+([A-Za-z0-9_-]+:[A-Za-z0-9_-]+)$/u.exec(
      authorization.trim()
    );
    if (match === null) return null;
    const [clientId, token] = splitBearerCredential(match[1]);
    if (clientId.length === 0) return null;
    const auth = await this.grantService.authenticate({ clientId, token });
    return auth.ok ? auth : null;
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
    let audit:
      | {
          action: LocalAgentAuditAction;
          capability: LocalAgentCapability;
          subjectKind: "capture" | "sizzle";
          subjectId: string;
        }
      | null = null;
    if (
      toolName === "pwrsnap_capture_export" &&
      captureId !== null
    ) {
      audit = {
        action: "capture.export",
        capability: "capture.export",
        subjectKind: "capture",
        subjectId: captureId
      };
    } else if (
      toolName === "pwrsnap_capture_delete_to_trash" &&
      captureId !== null
    ) {
      audit = {
        action: "trash.write",
        capability: "trash.write",
        subjectKind: "capture",
        subjectId: captureId
      };
    } else if (toolName === "pwrsnap_image_edit_send" && captureId !== null) {
      audit = {
        action: "capture.edit",
        capability: "capture.edit",
        subjectKind: "capture",
        subjectId: captureId
      };
    } else if (
      toolName === "pwrsnap_sizzle_render_preview" &&
      projectId !== null
    ) {
      audit = {
        action: "sizzle.preview.read",
        capability: "sizzle.preview.read",
        subjectKind: "sizzle",
        subjectId: projectId
      };
    } else if (
      toolName === "pwrsnap_sizzle_render_full" &&
      projectId !== null
    ) {
      audit = {
        action: "sizzle.full.read",
        capability: "sizzle.full.read",
        subjectKind: "sizzle",
        subjectId: projectId
      };
    }
    if (audit === null) return;
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

  private async writeDiscoveryDescriptor(): Promise<void> {
    if (this.discoveryFilePath === undefined || this.address === null) return;
    const descriptor: LocalAgentMcpDiscoveryDescriptor = {
      schemaVersion: 1,
      mcpUrl: this.address.url,
      pairUrl: this.address.pairUrl,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    await mkdir(dirname(this.discoveryFilePath), { recursive: true });
    const tempPath = `${this.discoveryFilePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(tempPath, this.discoveryFilePath);
    } catch (cause) {
      await unlink(tempPath).catch(() => undefined);
      throw cause;
    }
  }
}

class RequestBodyTooLargeError extends Error {}

function splitBearerCredential(value: string): [clientId: string, token: string | null] {
  const idx = value.indexOf(":");
  if (idx <= 0) return ["", null];
  return [value.slice(0, idx), value.slice(idx + 1)];
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
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
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
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

async function listen(server: HttpServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (cause: Error): void => {
      server.off("listening", handleListening);
      reject(cause);
    };
    const handleListening = (): void => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, host);
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
