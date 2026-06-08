import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LocalAgentCapability } from "@pwrsnap/shared";
import { err } from "@pwrsnap/shared";
import { z } from "zod";
import { bus, type CommandContext } from "../command-bus";
import { getMainLogger } from "../log";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import {
  LocalAgentGrantService,
  type LocalAgentAuthResult
} from "./local-agent-grants";
import {
  createDefaultLocalAgentMcpTools,
  toMcpToolResult,
  validateToolCapability,
  type LocalAgentMcpTool,
  type LocalAgentToolContext
} from "./mcp-tool-registry";

const log = getMainLogger("pwrsnap:local-agent-mcp");

export type LocalAgentMcpServerOptions = {
  settings: DesktopSettingsService;
  secrets: DesktopSecretStore;
  grantService?: Pick<LocalAgentGrantService, "authenticate">;
  tools?: readonly LocalAgentMcpTool<z.ZodRawShape>[];
  host?: string;
  port?: number;
};

export type LocalAgentMcpServerAddress = {
  url: string;
  host: string;
  port: number;
};

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo };

export class LocalAgentMcpServer {
  private readonly grantService: Pick<LocalAgentGrantService, "authenticate">;
  private readonly host: string;
  private readonly port: number;
  private readonly tools: readonly LocalAgentMcpTool<z.ZodRawShape>[];
  private readonly sessions = new Map<string, LocalAgentMcpSession>();
  private readonly initializingSessions = new Set<LocalAgentMcpSession>();
  private server: HttpServer | null = null;
  private address: LocalAgentMcpServerAddress | null = null;
  private closed = false;

  constructor(options: LocalAgentMcpServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.grantService =
      options.grantService ??
      new LocalAgentGrantService({ settings: options.settings, secrets: options.secrets });
    this.tools =
      options.tools ??
      createDefaultLocalAgentMcpTools({
        search: async (input, ctx) =>
          bus.dispatch("library:search", { query: input.query ?? "" }, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          }),
        deleteToTrash: async (input, ctx) =>
          bus.dispatch("library:delete", { id: input.captureId }, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          })
      });
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

  private createSession(): LocalAgentMcpSession {
    const mcp = this.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    const session: LocalAgentMcpSession = { mcp, transport, sessionId: null };
    const lifecycle = transport as unknown as {
      onsessioninitialized?: (sessionId: string) => void | Promise<void>;
      onsessionclosed?: (sessionId: string) => void | Promise<void>;
    };
    lifecycle.onsessioninitialized = (sessionId) => {
      session.sessionId = sessionId;
      this.initializingSessions.delete(session);
      this.sessions.set(sessionId, session);
    };
    lifecycle.onsessionclosed = async (sessionId) => {
      this.sessions.delete(sessionId);
      this.initializingSessions.delete(session);
      await this.closeSession(session);
    };
    return session;
  }

  async start(): Promise<LocalAgentMcpServerAddress> {
    if (this.server !== null && this.address !== null) return this.address;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((cause) => {
        log.warn("MCP request failed", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
        }
        if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (server === null) {
        reject(new Error("MCP server missing"));
        return;
      }
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const addr = this.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("MCP server did not bind to a TCP loopback address");
    }
    this.address = {
      host: this.host,
      port: (addr as AddressInfo).port,
      url: `http://${this.host}:${(addr as AddressInfo).port}/mcp`
    };
    log.info("local MCP server listening", this.address);
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
    const sessions = [
      ...this.sessions.values(),
      ...this.initializingSessions.values()
    ];
    this.sessions.clear();
    this.initializingSessions.clear();
    await Promise.all(sessions.map((session) => this.closeSession(session)));
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server.close((cause) => {
          if (cause) reject(cause);
          else resolve();
        });
      });
    }
  }

  private async closeSession(session: LocalAgentMcpSession): Promise<void> {
    await session.transport.close();
    await session.mcp.close();
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
          return toMcpToolResult(await tool.dispatch(input, ctx));
        }
      );
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) {
      res.statusCode = 503;
      res.end("closed");
      return;
    }
    if (!this.isLoopbackHostHeader(req)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    const auth = await this.authenticateRequest(req);
    if (auth === null) {
      res.statusCode = 401;
      res.setHeader("www-authenticate", "Bearer");
      res.end("unauthorized");
      return;
    }
    const authenticatedReq = req as AuthenticatedIncomingMessage;
    authenticatedReq.auth = {
      token: "",
      clientId: auth.context.clientId,
      scopes: [...auth.context.capabilities],
      extra: {
        capabilities: [...auth.context.capabilities]
      }
    };
    const session = await this.sessionForRequest(req);
    if (session === null) {
      res.statusCode = 404;
      res.end("session not found");
      return;
    }
    await session.transport.handleRequest(authenticatedReq, res);
    if (session.sessionId === null && session.transport.sessionId !== undefined) {
      session.sessionId = session.transport.sessionId;
      this.initializingSessions.delete(session);
      this.sessions.set(session.sessionId, session);
    }
  }

  private async sessionForRequest(req: IncomingMessage): Promise<LocalAgentMcpSession | null> {
    const sessionId = headerValue(req.headers["mcp-session-id"]);
    if (sessionId !== null) return this.sessions.get(sessionId) ?? null;
    if (req.method !== "POST") return null;
    const session = this.createSession();
    this.initializingSessions.add(session);
    try {
      await session.mcp.connect(session.transport as unknown as Transport);
      return session;
    } catch (cause) {
      this.initializingSessions.delete(session);
      await this.closeSession(session).catch(() => undefined);
      throw cause;
    }
  }

  private async authenticateRequest(req: IncomingMessage): Promise<Extract<LocalAgentAuthResult, { ok: true }> | null> {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match === null) return null;
    const [clientId, token] = splitBearerCredential(match[1]);
    if (clientId.length === 0) return null;
    const auth = await this.grantService.authenticate({ clientId, token });
    return auth.ok ? auth : null;
  }

  private isLoopbackHostHeader(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (typeof host !== "string") return false;
    const normalized = host.toLowerCase();
    return (
      normalized === `${this.host}:${this.address?.port ?? this.port}` ||
      normalized.startsWith("127.0.0.1:") ||
      normalized.startsWith("localhost:") ||
      normalized.startsWith("[::1]:")
    );
  }

  private authFromExtra(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): { clientId: string; capabilities: readonly LocalAgentCapability[] } | null {
    const auth = extra.authInfo;
    if (auth === undefined) return null;
    const caps = auth.extra?.capabilities;
    if (!Array.isArray(caps)) return null;
    const capabilities = caps.filter((cap): cap is LocalAgentCapability => typeof cap === "string") as LocalAgentCapability[];
    return { clientId: auth.clientId, capabilities };
  }
}

type LocalAgentMcpSession = {
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  sessionId: string | null;
};

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) {
    return value[0];
  }
  return null;
}

function splitBearerCredential(value: string): [clientId: string, token: string | null] {
  const idx = value.indexOf(":");
  if (idx <= 0) return ["", null];
  return [value.slice(0, idx), value.slice(idx + 1)];
}
