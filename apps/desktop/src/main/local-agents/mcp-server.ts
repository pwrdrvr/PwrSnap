import { app } from "electron";
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  LOCAL_AGENT_CAPABILITIES,
  err,
  ok,
  type LocalAgentAuditAction,
  type LocalAgentCapability,
  type LocalAgentUsageAction,
  type Result,
  type PwrSnapError
} from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { getMainLogger } from "../log";
import { DesktopSecretStore } from "../settings/desktop-secret-store";
import type { DesktopSettingsStoreApi } from "../settings/desktop-settings-store";
import { TRASH_RETENTION_DAYS } from "../persistence/trash-retention";
import { getCaptureById } from "../persistence/captures-repo";
import { LocalAgentGrantService } from "./local-agent-grants";
import type {
  LocalAgentConsentDecision,
  LocalAgentConsentRequest
} from "./local-agent-consent-broker";
import {
  captureNotBefore,
  isCapturedAtOrAfter,
  limitLocalAgentMcpList,
  localAgentMcpResultLimit,
  localAgentSearchOrder,
  projectLocalAgentSearchDiscovery,
  projectLocalAgentSearchRows,
  searchRangeEndsBefore,
  toCaptureSearchRequest
} from "./local-agent-search";
import { LocalAgentUsageService } from "./local-agent-usage";
import { LocalAgentMcpResourceRegistry, type LocalAgentMcpResource } from "./mcp-resource-registry";
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
import {
  NativeMcpBridge,
  type McpConnection
} from "../ai/mcp/native-mcp-bridge";
import { McpSessionPool } from "../ai/mcp/mcp-session-pool";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { IpcHttpMcp } from "./ipc-http-mcp";
import { SIZZLE_SKILL_URI, attachSizzleSkill, sizzleSkillTool } from "./sizzle-skill";
const log = getMainLogger("pwrsnap:local-agent-mcp");
type Policy = NonNullable<CommandContext["localAgent"]>;
type GrantService = Pick<
  LocalAgentGrantService,
  "authorizeClient" | "openNativeSession" | "recordUsage" | "revokeGrant" | "list"
>;
type UsageService = Pick<LocalAgentUsageService, "reserve" | "release">;
type Session = {
  stdio?: StdioServerHandle;
  id: number;
  transport: Transport & { controller: AbortController };
  mcp: McpServer;
  grantId: string | null;
  relayVersion: string;
  fingerprint: string;
};
export type LocalAgentMcpServerOptions = {
  settings: Pick<DesktopSettingsStoreApi, "read" | "write">;
  secrets: DesktopSecretStore;
  grantService?: GrantService;
  tools?: readonly AnyLocalAgentMcpTool[];
  resourceRegistry?: LocalAgentMcpResourceRegistry;
  signedUrls?: LocalAgentSignedUrlService;
  auditService?: LocalAgentAuditService;
  usageService?: UsageService;
  captureCapturedAt?: (captureId: string) => string | null;
  requestConsent?: (request: LocalAgentConsentRequest) => Promise<LocalAgentConsentDecision>;
  version?: string;
  bridgeFactory?: (onConnection: (input: McpConnection) => void) => NativeMcpBridge;
};
export class LocalAgentMcpServer {
  private readonly grantService: GrantService;
  private readonly tools: readonly AnyLocalAgentMcpTool[];
  private readonly resourceRegistry: LocalAgentMcpResourceRegistry;
  private readonly signedUrls: LocalAgentSignedUrlService;
  private readonly auditService: LocalAgentAuditService;
  private readonly usageService: UsageService;
  private readonly captureCapturedAt: (captureId: string) => string | null;
  private readonly requestConsent: LocalAgentMcpServerOptions["requestConsent"];
  private readonly version: string;
  private readonly bridge: NativeMcpBridge;
  private readonly http: IpcHttpMcp;
  private nextHttpId = 0;
  private closed = false;
  private starting: Promise<void> | undefined;
  private reaper: ReturnType<typeof setInterval> | undefined;
  private readonly pool = new McpSessionPool<Session>(
    32,
    async (session) =>
      !this.closed &&
      !session.transport.controller.signal.aborted &&
      (session.grantId === null || (await this.policy(session)) !== null),
    async (session) => {
      await session.transport.close();
      await session.stdio?.close();
      await session.mcp.close();
    }
  );
  constructor(options: LocalAgentMcpServerOptions) {
    this.resourceRegistry = options.resourceRegistry ?? new LocalAgentMcpResourceRegistry();
    this.signedUrls = options.signedUrls ?? new LocalAgentSignedUrlService();
    this.auditService = options.auditService ?? new LocalAgentAuditService(options.settings);
    this.usageService = options.usageService ?? new LocalAgentUsageService();
    this.captureCapturedAt =
      options.captureCapturedAt ?? ((captureId) => getCaptureById(captureId)?.captured_at ?? null);
    this.requestConsent = options.requestConsent;
    this.version = options.version ?? app.getVersion();
    this.http = new IpcHttpMcp(async (transport, message) => {
      const session = this.makeSession(--this.nextHttpId, transport, "direct HTTP (no relay)");
      try {
        if (!(await this.pool.admit(session.id, session))) throw new Error("MCP Session limit reached");
        await this.approve(session, message);
        await session.mcp.connect(transport);
      } catch (cause) { await transport.close(); throw cause; }
    });
    this.bridge =
      options.bridgeFactory?.((input) => this.accept(input)) ??
      new NativeMcpBridge({ allowHttp: true, onConnection: (input) => this.accept(input) });
    this.bridge.onclose = () => { void this.http.close(); void this.pool.clear(); };
    this.grantService =
      options.grantService ??
      new LocalAgentGrantService({ settings: options.settings, secrets: options.secrets });
    const toolService = new LocalAgentToolService(
      this.resourceRegistry,
      this.signedUrls,
      () => null
    );
    this.tools =
      options.tools ??
      createDefaultLocalAgentMcpTools({
        search: async (input, ctx) => {
          const limit = localAgentMcpResultLimit(input);
          const notBefore = captureNotBefore(ctx.commandContext.localAgent?.maxCaptureAgeDays);
          if (notBefore !== undefined && searchRangeEndsBefore(input, notBefore)) {
            return ok({
              detail: input.detail ?? "summary",
              order: localAgentSearchOrder(input),
              limit,
              hasMore: false,
              rows: []
            });
          }
          const request = {
            ...toCaptureSearchRequest(input, {
              ...(notBefore !== undefined ? { notBefore } : {})
            }),
            limit: limit + 1
          };
          const result = await bus.dispatch("library:search", request, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          });
          if (!result.ok) return result;
          const page = limitLocalAgentMcpList(result.value.rows, input);
          return ok({
            detail: input.detail ?? "summary",
            order: localAgentSearchOrder(input),
            limit: page.limit,
            hasMore: page.hasMore,
            rows: projectLocalAgentSearchRows(page.items, input.detail ?? "summary")
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
        sizzleCreate: (input, ctx) => toolService.sizzleCreate(input, ctx),
        sizzleGet: (input, ctx) => toolService.sizzleGet(input, ctx),
        sizzleAudioQa: (input, ctx) => toolService.sizzleAudioQa(input, ctx),
        sizzlePrepareNarration: (input, ctx) => toolService.sizzlePrepareNarration(input, ctx),
        sizzleAlignNarration: (input, ctx) => toolService.sizzleAlignNarration(input, ctx),
        sizzleTemplate: (input, ctx) => toolService.sizzleTemplate(input, ctx),
        sizzleImportCapture: (input, ctx) => toolService.sizzleImportCapture(input, ctx),
        sizzleImport: (input, ctx) => toolService.sizzleImport(input, ctx),
        sizzleUpdate: (input, ctx) => toolService.sizzleUpdate(input, ctx),
        sizzleBindings: (input, ctx) => toolService.sizzleBindings(input, ctx),
        sizzleInspect: (input, ctx) => toolService.sizzleInspect(input, ctx),
        sizzleSend: (input, ctx) => toolService.sizzleSend(input, ctx),
        sizzleStatus: (input, ctx) => toolService.sizzleStatus(input, ctx),
        sizzleRenderPreview: (input, ctx) => toolService.sizzleRender(input, ctx, "preview"),
        sizzleRenderFull: (input, ctx) => toolService.sizzleRender(input, ctx, "full"),
        videoInspect: (input, ctx) =>
          bus.dispatch("video:inspect", input, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          }),
        videoEdit: (input, ctx) =>
          bus.dispatch("video:edit", input, {
            principal: "mcp",
            localAgent: ctx.commandContext.localAgent
          }),
        captureDuplicate: (input, ctx) => toolService.captureDuplicate(input, ctx),
        captureEditSummary: (input, ctx) => toolService.captureEditSummary(input, ctx),
        captureFamilies: (input, ctx) => toolService.captureFamilies(input, ctx),
        captureFamily: (input, ctx) => toolService.captureFamily(input, ctx)
      });
  }

  isConnected(): boolean {
    return this.bridge.isRunning();
  }
  httpUrl(): string | undefined { return this.bridge.httpUrl(); }
  async start(): Promise<void> {
    if (this.closed) throw new Error("MCP server cannot restart; reconnect manually");
    if (this.starting !== undefined) return this.starting;
    this.starting = (async () => {
      await this.bridge.start();
      this.reaper = setInterval(() => { void this.settingsChanged().catch(() => undefined); }, 1000);
      this.reaper.unref();
    })();
    return this.starting;
  }
  async stop(): Promise<void> {
    this.closed = true;
    clearInterval(this.reaper);
    await this.http.close();
    await this.pool.clear();
    await this.bridge.stop();
  }
  async bootstrapHttp(signal: AbortSignal): Promise<{ token: string; expiresAt: string }> {
    if (this.closed || !this.bridge.isRunning()) throw new Error("Open PwrSnap and enable Local agents before bootstrapping HTTP");
    return this.http.bootstrap(signal);
  }
  async settingsChanged(): Promise<void> {
    await this.pool.prune();
    for (const session of this.pool.values()) {
      const policy = await this.policy(session);
      if (policy === null) continue;
      const fingerprint = JSON.stringify(policy);
      if (session.fingerprint !== "" && session.fingerprint !== fingerprint) {
        try {
          // The McpServer convenience wrappers discard these promises.
          await Promise.all([
            session.mcp.server.sendToolListChanged(),
            session.mcp.server.sendResourceListChanged()
          ]);
        } catch {
          log.debug("MCP catalog notification unavailable; host must rediscover manually");
        }
      }
      session.fingerprint = fingerprint;
    }
  }
  private accept(input: McpConnection): void {
    if (input.framing === "http") { this.http.accept(input.createStream()); return; }
    let session: Session;
    let admission: Promise<boolean>;
    const transport = input.createTransport(async (message) => {
      if (!(await admission) || input.identity !== null)
        throw new Error("MCP connection refused; reconnect manually");
      // Modern hosts may probe discovery on a throwaway connection. It
      // exposes public server metadata only and must not mint a consent grant.
      if ("method" in message && message.method === "server/discover") return;
      if (session.grantId !== null) return;
      clearTimeout(initializationTimer);
      await this.approve(session, message);
    }, { allowModernRequests: true });
    const initializationTimer = setTimeout(() => {
      void transport.close();
    }, 30_000);
    initializationTimer.unref();
    session = this.makeSession(input.id, transport, input.relayVersion);
    transport.controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(initializationTimer);
      },
      { once: true }
    );
    admission = this.pool.admit(input.id, session);
    void admission
      .then((allowed) => {
        if (!allowed) void transport.close();
      })
      .catch(() => {
        void transport.close();
      });
    let initial = true;
    session.stdio = serveStdio(() => {
      if (!initial) session.mcp = this.createMcpServer(session);
      initial = false;
      return session.mcp;
    }, { transport, onerror: () => { void transport.close(); } });
  }
  private makeSession(id: number, transport: Session["transport"], relayVersion: string): Session {
    const session: Session = { id, transport, relayVersion, grantId: null, fingerprint: "", mcp: undefined as unknown as McpServer };
    session.mcp = this.createMcpServer(session);
    transport.controller.signal.addEventListener("abort", () => {
      this.pool.remove(id);
      if (session.grantId !== null) void this.grantService.revokeGrant(session.grantId).catch(() => undefined);
      void session.stdio?.close();
      void session.mcp.close();
    }, { once: true });
    return session;
  }
  private async approve(session: Session, message: JSONRPCMessage): Promise<void> {
    const signal = session.transport.controller.signal;
    const timer = setTimeout(
      () => {
        void session.transport.close();
      },
      5 * 60 * 1000
    );
    try {
      const params = "params" in message ? message.params : undefined;
      const info =
        params !== undefined && typeof params === "object" && params !== null
          ? params.clientInfo ?? params._meta?.["io.modelcontextprotocol/clientInfo"]
          : undefined;
      const name =
        typeof info === "object" && info !== null && "name" in info && typeof info.name === "string"
          ? info.name.slice(0, 200)
          : "Local MCP client";
      const decision = await this.requestConsent?.({
        clientId: randomUUID(),
        clientName: name,
        requestedCapabilities: LOCAL_AGENT_CAPABILITIES,
        signal
      });
      if (signal.aborted || this.closed || decision?.decision !== "allow")
        throw new Error("PwrSnap approval was denied or disconnected; reconnect manually");
      if (decision.capabilities.some((cap) => !LOCAL_AGENT_CAPABILITIES.includes(cap)))
        throw new Error("invalid consent scope");
      const grant = await this.grantService.openNativeSession({
        name: decision.sessionName,
        capabilities: decision.capabilities,
        roleId: decision.roleId,
        ...(decision.maxCaptureAgeDays !== undefined
          ? { maxCaptureAgeDays: decision.maxCaptureAgeDays }
          : {})
      });
      const ceiling = await this.grantService.authorizeClient(grant.id);
      // A disconnect during the serialized settings write cannot leave a
      // surviving approval or install it into a replacement connection.
      if (signal.aborted || this.closed) {
        await this.grantService.revokeGrant(grant.id);
        throw new Error("disconnected during approval");
      }
      if (ceiling === null) throw new Error("approved role is unavailable");
      session.grantId = grant.id;
      session.fingerprint = JSON.stringify(ceiling);
    } finally {
      clearTimeout(timer);
    }
  }
  private async policy(session: Session): Promise<Policy | null> {
    if (session.grantId === null || session.transport.controller.signal.aborted) return null;
    return this.grantService.authorizeClient(session.grantId);
  }
  private createMcpServer(session: Session): McpServer {
    const connection = session.relayVersion === "direct HTTP (no relay)"
      ? "direct IPC HTTP/1.x; no relay"
      : `relay ${session.relayVersion}; local transport 1`;
    const mcp = new McpServer(
      { name: "PwrSnap", version: this.version },
      {
        // Direct IPC HTTP retains its existing initialize-based Session
        // contract. The raw native endpoint also accepts modern discovery.
        supportedProtocolVersions: [
          ...(session.relayVersion === "direct HTTP (no relay)" ? [] : ["2026-07-28"]),
          "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"
        ],
        instructions:
          `Desktop ${this.version}; ${connection}. The desktop owns this MCP interface. ` +
          "Use PwrSnap tools only for captures and sizzle assets the user authorized for this local client. " +
          "Completed media tools attach capability-protected MCP resources. Read them with resources/read; no HTTP media URLs are served. " +
          "Use the returned resourceUri only in clients that explicitly support MCP resource reads. " +
          `Before authoring a launch/demo reel, discover ${SIZZLE_SKILL_URI} with skills/list or skills/get (io.modelcontextprotocol/skills). ` +
          "Let the host's skill loader verify the manifest and apply its approval policy; skill files use resources/read. " +
          "pwrsnap_sizzle_skill is an ordinary reader fallback, not skill activation. Guidance requires an approved Session but no media permissions."
      }
    );
    this.registerTools(mcp, session);
    this.registerResources(mcp, session);
    attachSizzleSkill(mcp, async () => {
      const policy = await this.policy(session);
      if (policy === null) throw new Error("unauthorized");
      await this.recordUsage(policy.clientId);
    });
    return mcp;
  }

  private registerResources(mcp: McpServer, session: Session): void {
    const templates = [
      ["capture-composite", "pwrsnap://capture/{captureId}/composite", "image/png"],
      ["capture-original", "pwrsnap://capture/{captureId}/original", "image/png"],
      [
        "capture-export",
        "pwrsnap://capture/{captureId}/export/{exportId}",
        "application/octet-stream"
      ],
      ["sizzle-render", "pwrsnap://sizzle/{projectId}/{mode}/{renderId}", "video/mp4"]
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
        async (uri, _variables) => {
          const auth = session.grantId === null ? null : { clientId: session.grantId };
          if (auth === null) throw new Error("unauthorized");
          const policy = await this.policy(session);
          if (policy === null) throw new Error("unauthorized");
          const resource = this.resourceRegistry.get(uri.toString());
          if (resource !== undefined) {
            const age = this.captureAgeError(resource.captureId, policy);
            if (age !== null) throw new Error(age.message);
          }
          const usage =
            resource === undefined
              ? null
              : this.reserveUsage(policy, usageActionForResource(resource), resource.captureId);
          if (usage !== null && !usage.ok) throw new Error(usage.error.message);
          try {
            const resolved = await this.resourceRegistry.read(uri.toString(), policy);
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
            if (usage?.ok === true) {
              this.usageService.release(usage.reservationId);
            }
            if (resource !== undefined) {
              await this.auditResourceRead(resource, auth.clientId, "failure");
            }
            throw cause;
          }
        }
      );
    }
  }

  private registerTools(mcp: McpServer, session: Session): void {
    for (const tool of [...this.tools, sizzleSkillTool]) {
      mcp.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: z.object(tool.inputSchema),
          annotations: tool.annotations
        },
        async (
          input: Record<string, unknown>,
          extra: ServerContext
        ) => {
          const auth = session.grantId === null ? null : { clientId: session.grantId };
          if (auth === null) {
            return toMcpToolResult(
              err({
                kind: "validation",
                code: "unauthorized",
                message: "missing or invalid local agent authentication"
              })
            );
          }
          const policy = await this.policy(session);
          if (policy === null) {
            return toMcpToolResult(
              err({
                kind: "permission",
                code: "invalid_role",
                message: "the local-agent Session no longer has a valid role"
              })
            );
          }
          const ctx: LocalAgentToolContext = {
            clientId: policy.clientId,
            capabilities: policy.capabilities,
            signal: extra.mcpReq.signal,
            commandContext: {
              principal: "mcp",
              signal: extra.mcpReq.signal,
              localAgent: policy
            }
          };
          const allowed = validateToolCapability(tool, ctx, input);
          if (!allowed.ok) return toMcpToolResult(allowed);
          const captureId = typeof input.captureId === "string" ? input.captureId : undefined;
          const age = this.captureAgeErrorForInput(input, policy);
          if (age !== null) return toMcpToolResult(err(age));
          const usage = this.reserveUsage(policy, usageActionForTool(tool.name), captureId);
          if (usage !== null && !usage.ok) {
            return toMcpToolResult(err(usage.error));
          }
          const result = await tool.dispatch(input, ctx);
          if (usage?.ok === true && !shouldKeepUsageReservation(tool.name, result)) {
            this.usageService.release(usage.reservationId);
          }
          if (result.ok) await this.recordUsage(auth.clientId);
          await this.auditToolCall(tool.name, input, ctx, result);
          return toMcpToolResult(result);
        }
      );
    }
  }

  private captureAgeError(
    captureId: string | undefined,
    context: NonNullable<CommandContext["localAgent"]>
  ): PwrSnapError | null {
    if (captureId === undefined) return null;
    if (context.maxCaptureAgeDays === undefined) {
      return {
        kind: "permission",
        code: "invalid_role",
        message: "the local-agent role has no capture-age policy"
      };
    }
    const notBefore = captureNotBefore(context.maxCaptureAgeDays);
    if (notBefore === undefined) return null;
    if (!isCapturedAtOrAfter(this.captureCapturedAt(captureId), notBefore)) {
      return {
        kind: "permission",
        code: "capture_outside_role_scope",
        message:
          `the ${context.roleName ?? "assigned"} role permits captures from ` +
          `the last ${context.maxCaptureAgeDays} days`
      };
    }
    return null;
  }

  private captureAgeErrorForInput(
    input: Record<string, unknown>,
    context: NonNullable<CommandContext["localAgent"]>
  ): PwrSnapError | null {
    const captureIds = [
      ...(typeof input.captureId === "string" ? [input.captureId] : []),
      ...(Array.isArray(input.captureIds)
        ? input.captureIds.filter((id): id is string => typeof id === "string")
        : [])
    ];
    for (const captureId of captureIds) {
      const error = this.captureAgeError(captureId, context);
      if (error !== null) return error;
    }
    return null;
  }

  private reserveUsage(
    context: NonNullable<CommandContext["localAgent"]>,
    action: LocalAgentUsageAction | null,
    resourceId?: string
  ): { ok: true; reservationId: string } | { ok: false; error: PwrSnapError } | null {
    if (action === null) return null;
    if (context.budgets === undefined) {
      return {
        ok: false,
        error: {
          kind: "permission",
          code: "invalid_role",
          message: "the local-agent role has no usage-budget policy"
        }
      };
    }
    try {
      const decision = this.usageService.reserve({
        sessionId: context.clientId,
        action,
        budget: context.budgets[action],
        ...(resourceId !== undefined ? { resourceId } : {})
      });
      if (!decision.ok) {
        return {
          ok: false,
          error: {
            kind: "permission",
            code: "local_agent_budget_exceeded",
            message:
              `${action} budget exhausted (${decision.used}/${decision.limit} ` +
              `in ${decision.windowSeconds}s)`
          }
        };
      }
      return { ok: true, reservationId: decision.reservation.id };
    } catch (cause) {
      log.warn("local-agent usage reservation failed closed", {
        clientId: context.clientId,
        action,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return {
        ok: false,
        error: {
          kind: "permission",
          code: "local_agent_usage_unavailable",
          message: "PwrSnap could not verify this Session's usage budget",
          cause
        }
      };
    }
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
    const captureId = typeof input.captureId === "string" ? input.captureId : null;
    const projectId = typeof input.projectId === "string" ? input.projectId : null;
    const audits: Array<{
      action: LocalAgentAuditAction;
      capability: LocalAgentCapability;
      subjectKind: "capture" | "sizzle";
      subjectId: string;
    }> = [];
    if (toolName === "pwrsnap_capture_export" && captureId !== null) {
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
    } else if (toolName === "pwrsnap_capture_delete_to_trash" && captureId !== null) {
      audits.push({
        action: "trash.write",
        capability: "trash.write",
        subjectKind: "capture",
        subjectId: captureId
      });
    } else if (
      (toolName === "pwrsnap_image_edit_send" ||
        toolName === "pwrsnap_video_edit" ||
        toolName === "pwrsnap_capture_duplicate") &&
      captureId !== null
    ) {
      audits.push({
        action: "capture.edit",
        capability: "capture.edit",
        subjectKind: "capture",
        subjectId: captureId
      });
    } else if (toolName === "pwrsnap_sizzle_render_preview" && projectId !== null) {
      audits.push({
        action: "sizzle.preview.read",
        capability: "sizzle.preview.read",
        subjectKind: "sizzle",
        subjectId: projectId
      });
    } else if (
      (toolName === "pwrsnap_sizzle_render_full" || toolName === "pwrsnap_sizzle_audio_qa") &&
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

function usageActionForTool(toolName: string): LocalAgentUsageAction | null {
  switch (toolName) {
    case "pwrsnap_library_search":
      return "search";
    case "pwrsnap_image_edit_send":
    case "pwrsnap_video_edit":
    // A copy writes a whole bundle; it spends the same budget as an edit.
    case "pwrsnap_capture_duplicate":
      return "edit";
    case "pwrsnap_capture_delete_to_trash":
      return "delete";
    default:
      return null;
  }
}

function usageActionForResource(resource: LocalAgentMcpResource): LocalAgentUsageAction | null {
  if (resource.captureId === undefined) return null;
  return resource.requiredCapabilities.includes("capture.original.read")
    ? "original.read"
    : "preview.read";
}

function shouldKeepUsageReservation(
  toolName: string,
  result: Result<unknown, PwrSnapError>
): boolean {
  // An abandoned wait does not stop the copy: it still commits a whole
  // bundle or recording, so it spends the budget. Releasing it would let an
  // agent copy without limit by cancelling every request.
  if (!result.ok) {
    return toolName === "pwrsnap_capture_duplicate" && result.error.code === "aborted";
  }
  if (
    toolName === "pwrsnap_capture_delete_to_trash" &&
    typeof result.value === "object" &&
    result.value !== null &&
    (result.value as { alreadyInTrash?: unknown }).alreadyInTrash === true
  ) {
    return false;
  }
  return true;
}
