import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  ok,
  type LocalAgentCapability
} from "@pwrsnap/shared";
import { z } from "zod";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
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
  createDefaultLocalAgentMcpTools,
  toMcpToolResult,
  validateToolCapability,
  type LocalAgentMcpTool,
  type LocalAgentToolContext
} from "./mcp-tool-registry";

const log = getMainLogger("pwrsnap:local-agent-mcp");
const MCP_PATH = "/mcp";
const PAIR_PATH = "/pair";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

const PairingRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  capabilities: z.array(z.enum(LOCAL_AGENT_CAPABILITIES))
    .min(1)
    .max(LOCAL_AGENT_CAPABILITIES.length)
}).strict();

type GrantService = Pick<
  LocalAgentGrantService,
  "authenticate" | "createGrant" | "recordUsage"
>;

export type LocalAgentMcpServerOptions = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  grantService?: GrantService;
  tools?: readonly LocalAgentMcpTool<z.ZodRawShape>[];
  host?: string;
  port?: number;
  discoveryFilePath?: string;
  approvePairing?: (request: LocalAgentPairingApprovalRequest) => Promise<boolean>;
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
  private readonly tools: readonly LocalAgentMcpTool<z.ZodRawShape>[];
  private readonly discoveryFilePath: string | undefined;
  private readonly approvePairing:
    | ((request: LocalAgentPairingApprovalRequest) => Promise<boolean>)
    | undefined;
  private server: HttpServer | null = null;
  private address: LocalAgentMcpServerAddress | null = null;
  private closed = false;
  private pairingPending = false;

  constructor(options: LocalAgentMcpServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.discoveryFilePath = options.discoveryFilePath;
    this.approvePairing = options.approvePairing;
    this.grantService =
      options.grantService ??
      new LocalAgentGrantService({ settings: options.settings, secrets: options.secrets });
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
        deleteToTrash: async (input, ctx) =>
          bus.dispatch("library:delete", { id: input.captureId }, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          })
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
    return mcp;
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
        async (input, extra) => {
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
          const allowed = validateToolCapability(tool, ctx);
          if (!allowed.ok) return toMcpToolResult(allowed);
          await this.recordUsage(auth.clientId);
          return toMcpToolResult(await tool.dispatch(input, ctx));
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
    if (requestUrl.pathname !== MCP_PATH) {
      writeJsonResponse(res, 404, { error: "not_found" });
      return;
    }
    await this.handleMcpRequest(req, res, requestUrl);
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
