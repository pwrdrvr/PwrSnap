import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { err, ok, type LocalAgentCapability } from "@pwrsnap/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string): Buffer =>
    Buffer.from(`PWR-ENC|${Buffer.from(s, "utf8").toString("base64")}`, "utf8")
  ),
  decryptString: vi.fn((b: Buffer): string => {
    const text = b.toString("utf8");
    if (!text.startsWith("PWR-ENC|")) throw new Error("not a PWR-ENC blob");
    return Buffer.from(text.slice("PWR-ENC|".length), "base64").toString("utf8");
  })
}));

vi.mock("electron", () => ({
  safeStorage: safeStorageMock
}));

import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { LocalAgentGrantService } from "../local-agent-grants";
import { LocalAgentMcpResourceRegistry } from "../mcp-resource-registry";
import {
  LOCAL_AGENT_MCP_PORT,
  LocalAgentMcpServer,
  type LocalAgentMcpServerAddress
} from "../mcp-server";
import { LocalAgentSignedUrlService } from "../signed-url";
import { LocalAgentOAuthProvider } from "../local-agent-oauth";
import type { LocalAgentUsageService } from "../local-agent-usage";
import type {
  LocalAgentConsentDecision,
  LocalAgentConsentRequest
} from "../local-agent-consent-broker";
import {
  type LocalAgentMcpTool,
  withMcpResourceLink
} from "../mcp-tool-registry";

let workDir = "";
let settings: DesktopSettingsService;
let secrets: DesktopSecretStore;
let grantService: LocalAgentGrantService;
let server: LocalAgentMcpServer | null = null;
let client: Client | null = null;
let extraClient: Client | null = null;
let consentRequests: LocalAgentConsentRequest[] = [];
let consentDecisions: Array<
  LocalAgentConsentDecision | Promise<LocalAgentConsentDecision>
> = [];

const allowUsageService: Pick<LocalAgentUsageService, "reserve" | "release"> = {
  reserve: ({ sessionId, action, budget }) => ({
    ok: true,
    reservation: {
      id: `usage_${sessionId}_${action}`,
      sessionId,
      action,
      used: 1,
      limit: budget.limit,
      windowSeconds: budget.windowSeconds
    }
  }),
  release: () => undefined
};

async function requestNativeConsent(
  request: LocalAgentConsentRequest
): Promise<LocalAgentConsentDecision> {
  consentRequests.push(request);
  const decision = consentDecisions.shift();
  if (decision === undefined) throw new Error("test did not provide a native consent decision");
  return decision;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pwrsnap-mcp-server-"));
  settings = new DesktopSettingsService({ filePath: join(workDir, "settings.json") });
  secrets = new DesktopSecretStore({ filePath: join(workDir, "secrets.bin") });
  grantService = new LocalAgentGrantService({
    settings,
    secrets,
    now: () => new Date("2026-06-07T12:00:00.000Z"),
    makeId: () => "lag_mcp",
    makeToken: () => "pws_local_mcp-token"
  });
  consentRequests = [];
  consentDecisions = [];
});

afterEach(async () => {
  if (client !== null) {
    await client.close();
    client = null;
  }
  if (extraClient !== null) {
    await extraClient.close();
    extraClient = null;
  }
  if (server !== null) {
    await server.stop();
    server = null;
  }
});

function toolSet(): LocalAgentMcpTool<z.ZodRawShape>[] {
  return [
    {
      name: "pwrsnap_library_search",
      title: "Search PwrSnap Library",
      description: "Search live captures.",
      inputSchema: {
        query: z.string().optional()
      },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: async (input, ctx) =>
        ok({
          rows: [],
          query: input.query ?? "",
          clientId: ctx.clientId,
          principal: ctx.commandContext.principal
        })
    },
    {
      name: "pwrsnap_capture_delete_to_trash",
      title: "Move PwrSnap Capture To Trash",
      description: "Soft-delete a capture.",
      inputSchema: {
        captureId: z.string()
      },
      requiredCapabilities: ["trash.write"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: async (input, ctx) =>
        ok({
          deleted: input.captureId,
          clientId: ctx.clientId
        })
    },
    {
      name: "pwrsnap_library_discover",
      title: "Discover PwrSnap Library Filters",
      description: "List reusable human app and accepted-tag filters.",
      inputSchema: {
        limit: z.number().int().min(1).optional()
      },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: async (input, ctx) =>
        ok({
          applications: [
            {
              name: "Claude",
              bundleId: "com.anthropic.claudefordesktop",
              count: 4,
              mostRecentCapturedAt: "2026-06-07T12:00:00.000Z"
            }
          ],
          tags: [
            {
              label: "Important",
              count: 3,
              mostRecentCapturedAt: "2026-06-06T12:00:00.000Z"
            }
          ],
          limit: input.limit ?? null,
          clientId: ctx.clientId,
          principal: ctx.commandContext.principal
        })
    },
    {
      name: "pwrsnap_image_edit_send",
      title: "Edit PwrSnap Image",
      description: "Start an image edit and return its thread status.",
      inputSchema: {
        captureId: z.string(),
        instruction: z.string()
      },
      requiredCapabilities: ["capture.edit", "capture.composite.read"],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      },
      dispatch: async (input) => ok({ edited: input.captureId })
    }
  ];
}

async function startServer(): Promise<string> {
  server = new LocalAgentMcpServer({
    settings,
    secrets,
    grantService,
    tools: toolSet(),
    host: "127.0.0.1",
    port: 0,
    usageService: allowUsageService,
    captureCapturedAt: () => new Date().toISOString()
  });
  const address = await server.start();
  return address.url;
}

async function connect(url: string, token: string): Promise<Client> {
  client = new Client({ name: "test-client", version: "1.0.0" });
  return connectAs(url, "lag_mcp", token, client);
}

async function connectAs(
  url: string,
  clientId: string,
  token: string,
  targetClient: Client
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", bearer(clientId, token));
      return fetch(input, {
        ...init,
        headers
      });
    }
  });
  await targetClient.connect(transport as unknown as Transport);
  return targetClient;
}

async function connectWithAccessToken(
  url: string,
  accessToken: string,
  targetClient: Client
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers });
    }
  });
  await targetClient.connect(transport as unknown as Transport);
  return targetClient;
}

type RegisteredOAuthClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
};

const OAUTH_CALLBACK = "http://127.0.0.1:43123/callback";
const PKCE_VERIFIER = "pwrsnap-test-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";

function endpoint(address: LocalAgentMcpServerAddress, path: string): string {
  return new URL(path, `http://${address.host}:${address.port}`).href;
}

function bearer(clientId: string, token: string): string {
  return `Bearer ${clientId}:${token}`;
}

function toolsCallBody(query: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "pwrsnap_library_search", arguments: { query } }
  });
}

function mcpPostHeaders(): Record<string, string> {
  return {
    authorization: bearer("lag_mcp", "pws_local_mcp-token"),
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
}

async function postMcpJson(
  url: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { ...mcpPostHeaders(), ...headers },
    body
  });
}

type RawMcpResponse = {
  status: number | undefined;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  socket: unknown;
};

/** Streams `pieces` as a chunked (no content-length) POST over `agent`. */
function postMcpChunked(
  url: string,
  agent: HttpAgent,
  pieces: () => Iterable<string>
): Promise<RawMcpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let responded = false;
    const req = httpRequest(
      {
        agent,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { ...mcpPostHeaders(), "transfer-encoding": "chunked" }
      },
      (response) => {
        responded = true;
        const socket = response.socket;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            socket
          })
        );
      }
    );
    // The server closes the connection when it rejects a body mid-upload
    // (Connection: close), so the still-writing side sees EPIPE/ECONNRESET,
    // possibly more than once and on the socket rather than the request.
    // Swallow those: reject only if no response arrived first.
    req.on("socket", (socket) => socket.on("error", () => undefined));
    req.on("error", (cause) => {
      if (!responded) reject(cause);
    });
    const iterator = pieces()[Symbol.iterator]();
    const pump = (): void => {
      if (req.destroyed || req.writableEnded) return;
      for (;;) {
        const next = iterator.next();
        if (next.done === true) {
          req.end();
          return;
        }
        let flushed: boolean;
        try {
          flushed = req.write(next.value);
        } catch {
          return;
        }
        if (!flushed) {
          req.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
}

async function registerOAuthClient(
  address: LocalAgentMcpServerAddress,
  clientName = "Codex"
): Promise<RegisteredOAuthClient> {
  const response = await fetch(endpoint(address, "/register"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [OAUTH_CALLBACK],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    })
  });
  expect(response.status).toBe(201);
  return await response.json() as RegisteredOAuthClient;
}

function makeAuthorizationUrl(
  address: LocalAgentMcpServerAddress,
  oauthClient: RegisteredOAuthClient,
  scopes?: readonly string[]
): URL {
  const url = new URL(address.authorizationUrl);
  url.searchParams.set("client_id", oauthClient.client_id);
  url.searchParams.set("redirect_uri", OAUTH_CALLBACK);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", createHash("sha256")
    .update(PKCE_VERIFIER)
    .digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", address.url);
  url.searchParams.set("state", "test-state");
  if (scopes !== undefined) url.searchParams.set("scope", scopes.join(" "));
  return url;
}

async function beginBrowserAuthorization(
  address: LocalAgentMcpServerAddress,
  authorizationUrl: URL
): Promise<string> {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'none'"
  );
  const html = await response.text();
  expect(html).toContain("Continue in PwrSnap");
  expect(html).toContain("This browser page cannot approve access");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<script");
  const refresh = html.match(
    /<meta http-equiv="refresh" content="1;url=([^"]+)">/
  );
  expect(refresh).not.toBeNull();
  return new URL(
    (refresh?.[1] ?? "").replaceAll("&amp;", "&"),
    endpoint(address, "/")
  ).href;
}

async function waitForAuthorizationRedirect(statusUrl: string): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(statusUrl, { redirect: "manual" });
    if (response.status === 302) return response;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Waiting for PwrSnap");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("native PwrSnap authorization did not complete");
}

async function approveAndExchange(
  address: LocalAgentMcpServerAddress,
  oauthClient: RegisteredOAuthClient,
  capabilities: readonly LocalAgentCapability[],
  requestedScopes?: readonly LocalAgentCapability[]
): Promise<string> {
  consentDecisions.push({
    decision: "allow",
    sessionName: oauthClient.client_name,
    roleId: null,
    capabilities,
    maxCaptureAgeDays: 7
  });
  const authorizationUrl = makeAuthorizationUrl(
    address,
    oauthClient,
    requestedScopes
  );
  const statusUrl = await beginBrowserAuthorization(address, authorizationUrl);
  const authorized = await waitForAuthorizationRedirect(statusUrl);
  const callback = new URL(authorized.headers.get("location") ?? "");
  expect(callback.origin + callback.pathname).toBe(OAUTH_CALLBACK);
  expect(callback.searchParams.get("state")).toBe("test-state");
  const code = callback.searchParams.get("code");
  expect(code).not.toBeNull();

  const tokenResponse = await fetch(endpoint(address, "/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: oauthClient.client_id,
      code: code ?? "",
      code_verifier: PKCE_VERIFIER,
      redirect_uri: OAUTH_CALLBACK,
      resource: address.url
    })
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = await tokenResponse.json() as {
    access_token: string;
    token_type: string;
    scope: string;
  };
  expect(tokens.token_type.toLowerCase()).toBe("bearer");
  expect(tokens.scope).toBe(capabilities.join(" "));
  return tokens.access_token;
}

describe("LocalAgentMcpServer", () => {
  test("refuses unauthorized clients before MCP initialization", async () => {
    const url = await startServer();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "bad", version: "1.0.0" }
        }
      })
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp"
    );
  });

  test("answers every non-POST verb on /mcp with 405 before auth", async () => {
    // The endpoint is stateless (one transport + McpServer per POST), so there
    // is no session for a GET SSE stream or a DELETE to act on. Before this
    // pin, the SDK transport answered GET with a stream that never ended and
    // DELETE by building a whole server to close nothing; other verbs reached
    // the SDK's own 405, which advertised the GET this server refuses. One
    // answer, one `Allow`, and it comes before auth so nobody can open a
    // stream. Both verified clients treat the GET 405 as "no stream here".
    const url = await startServer();

    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await fetch(url, {
        method,
        headers: method === "GET" ? { accept: "text/event-stream" } : {}
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
      expect(await res.json()).toMatchObject({ error: "method_not_allowed" });
    }
  });

  test("lists tool schemas with read-only and destructive annotations", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read", "trash.write"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const tools = await connected.listTools();

    const search = tools.tools.find((tool) => tool.name === "pwrsnap_library_search");
    const trash = tools.tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    expect(search?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    });
    expect(search?.inputSchema.properties).toHaveProperty("query");
    expect(trash?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  test("advertises concrete MIME types for protected media templates", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["capture.composite.read", "sizzle.preview.read"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const resources = await connected.listResourceTemplates();
    expect(resources.resourceTemplates.map((template) => template.uriTemplate)).toEqual([
      "pwrsnap://capture/{captureId}/composite",
      "pwrsnap://capture/{captureId}/original",
      "pwrsnap://capture/{captureId}/export/{exportId}",
      "pwrsnap://sizzle/{projectId}/{mode}/{renderId}"
    ]);
    expect(resources.resourceTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        uriTemplate: "pwrsnap://capture/{captureId}/composite",
        mimeType: "image/png"
      }),
      expect.objectContaining({
        uriTemplate: "pwrsnap://sizzle/{projectId}/{mode}/{renderId}",
        mimeType: "video/mp4"
      })
    ]));
    expect(resources.resourceTemplates.every((template) =>
      template.description?.includes("do not construct URIs from this template")
    )).toBe(true);
  });

  test("returns media as first-class MCP resource links without inline bytes", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["capture.composite.read"]
    });
    const mediaTool: LocalAgentMcpTool<{ captureId: z.ZodString }> = {
      name: "pwrsnap_capture_resource",
      title: "Get PwrSnap Capture Resource",
      description: "Return a capture resource link.",
      inputSchema: { captureId: z.string() },
      requiredCapabilities: ["capture.composite.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: async (input) => ok(withMcpResourceLink({
        resourceUri: `pwrsnap://capture/${input.captureId}/composite`
      }, {
        uri: "http://127.0.0.1:51729/media?grant=temporary",
        name: "composite capture",
        mimeType: "image/png",
        size: 3
      }))
    };
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: [mediaTool],
      host: "127.0.0.1",
      port: 0,
      usageService: allowUsageService,
      captureCapturedAt: () => new Date().toISOString()
    });
    const address = await server.start();
    const connected = await connect(address.url, "pws_local_mcp-token");

    const result = await connected.callTool({
      name: mediaTool.name,
      arguments: { captureId: "cap_1" }
    }) as CallToolResult;

    expect(result.structuredContent).toMatchObject({
      resourceUri: "pwrsnap://capture/cap_1/composite"
    });
    expect(result.content[1]).toEqual({
      type: "resource_link",
      uri: "http://127.0.0.1:51729/media?grant=temporary",
      name: "composite capture",
      description:
        "Pass this link directly to the client media fetch/render path. Do not copy or reconstruct its URI.",
      mimeType: "image/png",
      size: 3,
      annotations: {
        audience: ["user", "assistant"],
        priority: 1
      }
    });
    expect(result.content.some((content) => content.type === "image")).toBe(false);
  });

  test("authorized client with library.read can search but cannot delete without trash.write", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const search = (await connected.callTool({
      name: "pwrsnap_library_search",
      arguments: { query: "pairing" }
    })) as CallToolResult;
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({
      rows: [],
      query: "pairing",
      clientId: "lag_mcp",
      principal: "mcp"
    });

    const denied = (await connected.callTool({
      name: "pwrsnap_capture_delete_to_trash",
      arguments: { captureId: "cap_1" }
    })) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(denied.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("missing_capability")
    });
  });

  test("authorized client discovers reusable human app and tag facets with MCP context", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const discovery = (await connected.callTool({
      name: "pwrsnap_library_discover",
      arguments: { limit: 25 }
    })) as CallToolResult;

    expect(discovery.isError).not.toBe(true);
    expect(discovery.structuredContent).toEqual({
      applications: [
        {
          name: "Claude",
          bundleId: "com.anthropic.claudefordesktop",
          count: 4,
          mostRecentCapturedAt: "2026-06-07T12:00:00.000Z"
        }
      ],
      tags: [
        {
          label: "Important",
          count: 3,
          mostRecentCapturedAt: "2026-06-06T12:00:00.000Z"
        }
      ],
      limit: 25,
      clientId: "lag_mcp",
      principal: "mcp"
    });
  });

  test("returns a typed MCP error when a sliding-window budget is exhausted", async () => {
    await grantService.createGrant({
      name: "Budgeted Agent",
      capabilities: ["library.read"]
    });
    const deniedUsage: Pick<LocalAgentUsageService, "reserve" | "release"> = {
      reserve: ({ budget }) => ({
        ok: false,
        used: budget.limit,
        limit: budget.limit,
        windowSeconds: budget.windowSeconds,
        retryAt: "2026-08-02T12:00:00.000Z"
      }),
      release: () => undefined
    };
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      usageService: deniedUsage,
      captureCapturedAt: () => new Date().toISOString()
    });
    const connected = await connect(
      (await server.start()).url,
      "pws_local_mcp-token"
    );

    const result = await connected.callTool({
      name: "pwrsnap_library_search",
      arguments: { query: "too many" }
    }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("local_agent_budget_exceeded")
    });
  });

  test("rejects capture ids outside the role's age horizon before dispatch", async () => {
    await grantService.createGrant({
      name: "Recent Only",
      capabilities: ["library.read"]
    });
    const dispatch = vi.fn(async () => ok({ leaked: true }));
    const scopedTool: LocalAgentMcpTool<{ captureId: z.ZodString }> = {
      name: "pwrsnap_test_scoped_capture",
      title: "Scoped capture",
      description: "Age-scope test tool",
      inputSchema: { captureId: z.string() },
      requiredCapabilities: ["library.read"],
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch
    };
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: [scopedTool],
      host: "127.0.0.1",
      port: 0,
      usageService: allowUsageService,
      captureCapturedAt: () => "2000-01-01T00:00:00.000Z"
    });
    const connected = await connect(
      (await server.start()).url,
      "pws_local_mcp-token"
    );

    const result = await connected.callTool({
      name: scopedTool.name,
      arguments: { captureId: "cap_old" }
    }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("capture_outside_role_scope")
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("fails closed for registered capture resources with missing metadata", async () => {
    const mediaPath = join(workDir, "orphaned-original.png");
    writeFileSync(mediaPath, "orphaned-sensitive-media");
    const resources = new LocalAgentMcpResourceRegistry();
    resources.register({
      uri: "pwrsnap://capture/cap_missing/original",
      name: "orphaned original",
      mimeType: "image/png",
      requiredCapabilities: ["capture.original.read"],
      captureId: "cap_missing",
      ownerClientId: "lag_mcp",
      resolvePath: async () => mediaPath
    });
    const signedUrls = new LocalAgentSignedUrlService(Buffer.alloc(32, 9));
    await grantService.createGrant({
      name: "Recent media only",
      capabilities: ["capture.original.read"]
    });
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      resourceRegistry: resources,
      signedUrls,
      usageService: allowUsageService,
      captureCapturedAt: () => null
    });
    const address = await server.start();
    const signed = signedUrls.mint({
      baseUrl: `http://${address.host}:${address.port}`,
      resourceUri: "pwrsnap://capture/cap_missing/original",
      clientId: "lag_mcp"
    });

    const signedResponse = await fetch(signed.url);
    expect(signedResponse.status).toBe(403);
    expect(await signedResponse.json()).toMatchObject({
      error: expect.stringContaining("last 7 days")
    });

    const connected = await connect(address.url, "pws_local_mcp-token");
    await expect(connected.readResource({
      uri: "pwrsnap://capture/cap_missing/original"
    })).rejects.toThrow(/last 7 days/u);
  });

  test("edit-only OAuth client cannot start a vision-dependent edit", async () => {
    await grantService.createGrant({
      name: "Edit-only agent",
      capabilities: ["capture.edit"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const denied = await connected.callTool({
      name: "pwrsnap_image_edit_send",
      arguments: { captureId: "cap_1", instruction: "Add an arrow" }
    }) as CallToolResult;
    expect(denied.isError).toBe(true);
    expect(denied.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("capture.composite.read")
    });
  });

  test("editor OAuth client can start an edit when it can read the composite", async () => {
    await grantService.createGrant({
      name: "Editor agent",
      capabilities: ["capture.edit", "capture.composite.read"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const sent = await connected.callTool({
      name: "pwrsnap_image_edit_send",
      arguments: { captureId: "cap_1", instruction: "Add an arrow" }
    }) as CallToolResult;
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent).toEqual({
      edited: "cap_1"
    });
  });

  test("audits original-derived exports as both export and original access", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["capture.export", "capture.original.read"]
    });
    const exportTool: LocalAgentMcpTool<{
      captureId: z.ZodString;
      variant: z.ZodEnum<{ composite: "composite"; original: "original" }>;
    }> = {
      name: "pwrsnap_capture_export",
      title: "Export capture",
      description: "Test export",
      inputSchema: {
        captureId: z.string(),
        variant: z.enum(["composite", "original"])
      },
      requiredCapabilities: ["capture.export"],
      requiredCapabilitiesForInput: (input) =>
        input.variant === "original" ? ["capture.original.read"] : [],
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      dispatch: async (input) =>
        input.captureId === "missing"
          ? err({ kind: "validation", code: "not_found", message: "missing" })
          : ok({ exported: input.captureId })
    };
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: [exportTool],
      host: "127.0.0.1",
      port: 0,
      usageService: allowUsageService,
      captureCapturedAt: () => new Date().toISOString()
    });
    const address = await server.start();
    const connected = await connect(address.url, "pws_local_mcp-token");

    await connected.callTool({
      name: "pwrsnap_capture_export",
      arguments: { captureId: "cap_1", variant: "original" }
    });
    await connected.callTool({
      name: "pwrsnap_capture_export",
      arguments: { captureId: "missing", variant: "original" }
    });

    expect((await settings.read()).localAgents.audit.map((entry) => ({
      action: entry.action,
      outcome: entry.outcome,
      subjectId: entry.subjectId
    }))).toEqual([
      { action: "capture.export", outcome: "success", subjectId: "cap_1" },
      { action: "capture.original.read", outcome: "success", subjectId: "cap_1" },
      { action: "capture.export", outcome: "failure", subjectId: "missing" },
      { action: "capture.original.read", outcome: "failure", subjectId: "missing" }
    ]);
  });

  test("serves multiple clients without allocating MCP session state", async () => {
    const serviceA = new LocalAgentGrantService({
      settings,
      secrets,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
      makeId: () => "lag_a",
      makeToken: () => "token-a"
    });
    const serviceB = new LocalAgentGrantService({
      settings,
      secrets,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
      makeId: () => "lag_b",
      makeToken: () => "token-b"
    });
    await serviceA.createGrant({ name: "Agent A", capabilities: ["library.read"] });
    await serviceB.createGrant({ name: "Agent B", capabilities: ["library.read"] });
    const url = await startServer();

    client = await connectAs(url, "lag_a", "token-a", new Client({ name: "a", version: "1.0.0" }));
    extraClient = await connectAs(url, "lag_b", "token-b", new Client({ name: "b", version: "1.0.0" }));

    expect(client.transport?.sessionId).toBeUndefined();
    expect(extraClient.transport?.sessionId).toBeUndefined();

    const a = (await client.callTool({
      name: "pwrsnap_library_search",
      arguments: { query: "from-a" }
    })) as CallToolResult;
    const b = (await extraClient.callTool({
      name: "pwrsnap_library_search",
      arguments: { query: "from-b" }
    })) as CallToolResult;

    expect(a.structuredContent).toMatchObject({ clientId: "lag_a", query: "from-a" });
    expect(b.structuredContent).toMatchObject({ clientId: "lag_b", query: "from-b" });
  });

  test("authorizes a dynamically registered client through native PwrSnap consent", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      usageService: allowUsageService,
      captureCapturedAt: () => new Date().toISOString(),
      requestConsent: requestNativeConsent
    });
    const address = await server.start();
    const oauthClient = await registerOAuthClient(address, "Codex Desktop");
    expect(oauthClient.token_endpoint_auth_method).toBe("none");
    expect(oauthClient).not.toHaveProperty("client_secret");

    consentDecisions.push({ decision: "deny", sessionName: "", roleId: null, capabilities: [] });
    const defaultStatusUrl = await beginBrowserAuthorization(
      address,
      makeAuthorizationUrl(address, oauthClient)
    );
    const defaultConsent = await waitForAuthorizationRedirect(defaultStatusUrl);
    expect(defaultConsent.status).toBe(302);
    expect(consentRequests[0]).toMatchObject({
      clientId: oauthClient.client_id,
      clientName: "Codex Desktop",
      requestedCapabilities: ["library.read", "capture.composite.read"]
    });

    const accessToken = await approveAndExchange(
      address,
      oauthClient,
      ["library.read", "trash.write"],
      ["library.read", "trash.write"]
    );
    const grants = await grantService.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      name: "Codex Desktop",
      capabilities: ["library.read", "trash.write"],
      revokedAt: null,
      oauthClient: {
        clientId: oauthClient.client_id,
        redirectUris: [OAUTH_CALLBACK]
      }
    });
    expect(consentRequests.at(-1)?.requestedCapabilities).toEqual([
      "library.read",
      "trash.write"
    ]);

    client = await connectWithAccessToken(
      address.url,
      accessToken,
      new Client({ name: "oauth-client", version: "1.0.0" })
    );
    const result = await client.callTool({
      name: "pwrsnap_capture_delete_to_trash",
      arguments: { captureId: "cap_1" }
    }) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ deleted: "cap_1" });

    const revoked = await fetch(endpoint(address, "/revoke"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClient.client_id,
        token: accessToken,
        token_type_hint: "access_token"
      })
    });
    expect(revoked.status).toBe(200);
    expect((await grantService.list())[0]?.revokedAt).not.toBeNull();
    await expect(client.listTools()).rejects.toThrow();
  });

  test("publishes standards-based OAuth metadata without refresh-token claims", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();
    const protectedResource = await fetch(
      endpoint(address, "/.well-known/oauth-protected-resource/mcp")
    );
    expect(await protectedResource.json()).toMatchObject({
      resource: address.url,
      authorization_servers: [`http://${address.host}:${address.port}/`],
      resource_name: "PwrSnap"
    });
    const authorizationServer = await fetch(
      endpoint(address, "/.well-known/oauth-authorization-server")
    );
    expect(await authorizationServer.json()).toMatchObject({
      authorization_endpoint: address.authorizationUrl,
      token_endpoint: endpoint(address, "/token"),
      registration_endpoint: endpoint(address, "/register"),
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"]
    });
  });

  test("restores approved OAuth clients and access tokens after server restart", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      requestConsent: requestNativeConsent
    });
    const firstAddress = await server.start();
    const oauthClient = await registerOAuthClient(firstAddress);
    const accessToken = await approveAndExchange(
      firstAddress,
      oauthClient,
      ["library.read"]
    );
    await server.stop();

    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      requestConsent: requestNativeConsent
    });
    const secondAddress = await server.start();

    client = await connectWithAccessToken(
      secondAddress.url,
      accessToken,
      new Client({ name: "restored-oauth-client", version: "1.0.0" })
    );
    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "pwrsnap_library_search" })
      ])
    });
  });

  test("denies consent without creating a grant and rejects hostile origins", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      requestConsent: requestNativeConsent
    });
    const address = await server.start();

    const hostile = await fetch(endpoint(address, "/register"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body: "{}"
    });
    expect(hostile.status).toBe(403);

    const oauthClient = await registerOAuthClient(address, "Untrusted Agent");
    const authorizationUrl = makeAuthorizationUrl(address, oauthClient, [
      "capture.original.read"
    ]);
    consentDecisions.push({ decision: "deny", sessionName: "", roleId: null, capabilities: [] });
    const statusUrl = await beginBrowserAuthorization(address, authorizationUrl);
    const denied = await waitForAuthorizationRedirect(statusUrl);
    expect(denied.status).toBe(302);
    const callback = new URL(denied.headers.get("location") ?? "");
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(await grantService.list()).toEqual([]);
  });

  test("loopback HTTP cannot manufacture approval while native consent is pending", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      requestConsent: requestNativeConsent
    });
    const address = await server.start();
    const oauthClient = await registerOAuthClient(address, "Forging Agent");

    const forgedUrl = makeAuthorizationUrl(address, oauthClient, ["library.read"]);
    forgedUrl.searchParams.set("pwrsnap_decision", "allow");
    forgedUrl.searchParams.append("capability", "trash.write");
    const forged = await fetch(forgedUrl, { redirect: "manual" });
    expect(forged.status).toBe(400);
    expect(await forged.json()).toMatchObject({ error: "invalid_request" });
    expect(await grantService.list()).toEqual([]);

    let resolveNative!: (decision: LocalAgentConsentDecision) => void;
    consentDecisions.push(new Promise((resolve) => {
      resolveNative = resolve;
    }));
    const statusUrl = await beginBrowserAuthorization(
      address,
      makeAuthorizationUrl(address, oauthClient)
    );
    await vi.waitFor(() => expect(consentRequests).toHaveLength(1));

    const pending = await fetch(statusUrl, { redirect: "manual" });
    expect(pending.status).toBe(200);
    expect(await pending.text()).toContain("waiting for your decision");

    const headlessApproval = await fetch(address.authorizationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "pwrsnap_consent=forged"
      },
      body: new URLSearchParams({
        consent_transaction: "forged",
        pwrsnap_decision: "allow",
        capability: "library.read"
      }),
      redirect: "manual"
    });
    expect(headlessApproval.status).toBe(405);
    expect(await headlessApproval.json()).toMatchObject({ error: "method_not_allowed" });
    expect(await grantService.list()).toEqual([]);

    resolveNative({
      decision: "allow",
      sessionName: "Forging Agent",
      roleId: null,
      capabilities: ["library.read"],
      maxCaptureAgeDays: 7
    });
    const approved = await waitForAuthorizationRedirect(statusUrl);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get("location") ?? "");
    expect(callback.searchParams.get("code")).not.toBeNull();
    expect(approved.headers.get("set-cookie")).toBeNull();
  });

  test("expires server-issued consent transactions before a decision", async () => {
    let nowMs = Date.parse("2026-08-01T12:00:00.000Z");
    const resourceUrl = new URL("http://127.0.0.1:51729/mcp");
    const provider = new LocalAgentOAuthProvider({
      grantService,
      resourceUrl,
      now: () => new Date(nowMs),
      makeClientId: () => "lag_expiring_consent",
      makeConsentId: () => "consent_expiring"
    });
    const oauthClient = await provider.clientsStore.registerClient?.({
      client_name: "Expiring Agent",
      redirect_uris: [OAUTH_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    });
    expect(oauthClient).toBeDefined();
    const result = await provider.handleAuthorizationRequest(
      makeAuthorizationUrl(
        {
          host: "127.0.0.1",
          port: 51_729,
          url: resourceUrl.href,
          authorizationUrl: "http://127.0.0.1:51729/authorize"
        },
        oauthClient as RegisteredOAuthClient
      )
    );
    expect(result).toMatchObject({
      kind: "consent",
      transactionId: "consent_expiring"
    });

    nowMs += 5 * 60_000 + 1;
    expect(provider.handleConsentDecision({
      transactionId: "consent_expiring",
      decision: "allow",
      sessionName: "Expiring Agent",
      roleId: null,
      capabilities: ["library.read"],
      maxCaptureAgeDays: 7
    })).toMatchObject({
      kind: "error",
      status: 400,
      error: "invalid_request"
    });
  });

  test("returns an actionable OAuth error when a session name races with an active grant", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const resourceUrl = new URL("http://127.0.0.1:51729/mcp");
    const provider = new LocalAgentOAuthProvider({
      grantService,
      resourceUrl,
      makeClientId: () => "lag_duplicate_name"
    });
    const oauthClient = await provider.clientsStore.registerClient?.({
      client_name: "PwrAgent",
      redirect_uris: [OAUTH_CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"]
    });
    if (oauthClient === undefined) throw new Error("expected registered OAuth client");
    const code = provider.createAuthorizationCode({
      client: oauthClient,
      params: {
        codeChallenge: "test-challenge",
        redirectUri: OAUTH_CALLBACK,
        resource: resourceUrl,
        scopes: ["library.read"]
      },
      sessionName: "PwrAgent",
      roleId: null,
      capabilities: ["library.read"],
      maxCaptureAgeDays: 7
    });

    const exchange = provider.exchangeAuthorizationCode(
      oauthClient,
      code,
      undefined,
      OAUTH_CALLBACK,
      resourceUrl
    );
    await expect(exchange).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(exchange).rejects.toThrow("use a unique Session Name");
  });

  test("rejects requests outside known routes and with an alternate Host", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();
    const res = await fetch(`http://${address.host}:${address.port}/other`);
    expect(res.status).toBe(404);

    const responseStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({
        hostname: address.host,
        port: address.port,
        path: "/.well-known/oauth-authorization-server",
        headers: { host: `localhost:${address.port}` }
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      req.once("error", reject);
      req.end();
    });
    expect(responseStatus).toBe(403);
  });

  test("streams signed media and revocation invalidates an existing URL", async () => {
    const mediaPath = join(workDir, "original.png");
    writeFileSync(mediaPath, "sensitive-media");
    const resources = new LocalAgentMcpResourceRegistry();
    resources.register({
      uri: "pwrsnap://capture/cap_1/original",
      name: "original",
      mimeType: "image/png",
      requiredCapabilities: ["capture.original.read"],
      ownerClientId: "lag_mcp",
      audit: {
        action: "capture.original.read",
        capability: "capture.original.read",
        subjectKind: "capture",
        subjectId: "cap_1"
      },
      resolvePath: async () => mediaPath
    });
    const signedUrls = new LocalAgentSignedUrlService(Buffer.alloc(32, 3));
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["capture.original.read"]
    });
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      resourceRegistry: resources,
      signedUrls
    });
    const address = await server.start();
    const signed = signedUrls.mint({
      baseUrl: `http://${address.host}:${address.port}`,
      resourceUri: "pwrsnap://capture/cap_1/original",
      clientId: "lag_mcp"
    });

    const first = await fetch(signed.url);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await first.text()).toBe("sensitive-media");

    const ranged = await fetch(signed.url, {
      headers: { range: "bytes=0-0" }
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("accept-ranges")).toBe("bytes");
    expect(ranged.headers.get("content-range")).toBe("bytes 0-0/15");
    expect(ranged.headers.get("content-length")).toBe("1");
    expect(await ranged.text()).toBe("s");

    client = await connect(address.url, "pws_local_mcp-token");
    const resource = await client.readResource({
      uri: "pwrsnap://capture/cap_1/original"
    });
    expect(resource.contents[0]).toMatchObject({
      uri: "pwrsnap://capture/cap_1/original",
      mimeType: "image/png",
      blob: Buffer.from("sensitive-media").toString("base64")
    });
    expect((await settings.read()).localAgents.audit).toHaveLength(3);

    await grantService.revokeGrant("lag_mcp");
    const revoked = await fetch(signed.url);
    expect(revoked.status).toBe(403);
    expect((await settings.read()).localAgents.audit).toHaveLength(3);
  });

  test("rejects signed media replay through a different Host header", async () => {
    const mediaPath = join(workDir, "media.png");
    writeFileSync(mediaPath, "media");
    const resources = new LocalAgentMcpResourceRegistry();
    resources.register({
      uri: "pwrsnap://capture/cap_1/composite",
      name: "composite",
      mimeType: "image/png",
      requiredCapabilities: ["capture.composite.read"],
      resolvePath: async () => mediaPath
    });
    const signedUrls = new LocalAgentSignedUrlService(Buffer.alloc(32, 4));
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["capture.composite.read"]
    });
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      resourceRegistry: resources,
      signedUrls
    });
    const address = await server.start();
    const signed = signedUrls.mint({
      baseUrl: `http://${address.host}:${address.port}`,
      resourceUri: "pwrsnap://capture/cap_1/composite",
      clientId: "lag_mcp"
    });

    const responseStatus = await new Promise<number | undefined>((resolve, reject) => {
      const target = new URL(signed.url);
      const req = httpRequest({
        hostname: address.host,
        port: address.port,
        path: `${target.pathname}${target.search}`,
        headers: { host: `localhost:${address.port}` }
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      req.once("error", reject);
      req.end();
    });

    expect(responseStatus).toBe(403);
  });

  test("rejects MCP request bodies larger than one MiB with PwrSnap's JSON 413", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();

    const response = await postMcpJson(url, toolsCallBody("x".repeat(1024 * 1024)));

    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toEqual({ error: "request_too_large" });
  });

  test("accepts a tools/call body above body-parser's 100 kb default", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();
    const query = "y".repeat(200 * 1024);
    const body = toolsCallBody(query);
    // Above the 100 kb limit the SDK's createMcpExpressApp would have
    // imposed, below MAX_REQUEST_BODY_BYTES: only PwrSnap's cap may run.
    expect(Buffer.byteLength(body)).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(body)).toBeLessThan(1024 * 1024);

    const response = await postMcpJson(url, body);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      result?: CallToolResult;
      error?: unknown;
    };
    expect(payload.error).toBeUndefined();
    expect(payload.result?.isError).not.toBe(true);
    const echoed = payload.result?.structuredContent?.["query"];
    expect(typeof echoed === "string" ? echoed.length : echoed).toBe(query.length);
    // Compared as a boolean so a mismatch does not print 200 KB twice.
    expect(echoed === query).toBe(true);
  });

  test("bounds an over-cap chunked upload and keeps serving", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();
    // maxSockets: 1 so the follow-up request can only proceed once the first
    // connection is released — the case that used to hang ~6 s under load.
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    try {
      // No content-length, so the streaming branch of the cap — not the
      // up-front content-length check — is the only thing that can stop this.
      // The server rejects mid-stream and closes the connection so the body is
      // never buffered (RFC 9110 §9.3.6). A well-timed client reads the JSON
      // 413; one still mid-upload sees the reset instead. Both are acceptable;
      // asserting a clean 413 here would be racing the upload. What must always
      // hold is the health property below: no hang, and the next caller is
      // served — proof the streaming cap fired and released the connection.
      const first = await postMcpChunked(url, agent, function* () {
        yield '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":' +
          '{"name":"pwrsnap_library_search","arguments":{"query":"';
        const piece = "x".repeat(64 * 1024);
        for (let sent = 0; sent < 2 * 1024 * 1024; sent += piece.length) yield piece;
        yield '"}}}';
      })
        .then((response) => ({ delivered: true as const, response }))
        .catch(() => ({ delivered: false as const }));
      if (first.delivered) {
        expect(first.response.status).toBe(413);
        expect(JSON.parse(first.response.body)).toEqual({ error: "request_too_large" });
        const connection = first.response.headers["connection"];
        expect(
          typeof connection === "string" ? connection.toLowerCase() : connection
        ).toBe("close");
      }

      // The client transparently opens a fresh socket and the server answers
      // promptly — no multi-second wait. (vitest's 5 s per-test timeout is the
      // backstop that turns a stall regression here into a failure.)
      const second = await postMcpChunked(url, agent, function* () {
        yield toolsCallBody("after");
      });
      expect(second.status).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  test("rejects compressed MCP bodies with 415 instead of inflating them", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();

    const response = await postMcpJson(
      url,
      new Uint8Array(gzipSync(toolsCallBody("zipped"))),
      { "content-encoding": "gzip" }
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: "unsupported_media_type" });
  });

  test("answers SDK-router parser failures with JSON, not Express's HTML page", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();

    const oversize = await fetch(endpoint(address, "/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "oversize",
        redirect_uris: [OAUTH_CALLBACK],
        padding: "x".repeat(150 * 1024)
      })
    });
    expect(oversize.status).toBe(413);
    expect(oversize.headers.get("content-type")).toBe("application/json");
    await expect(oversize.json()).resolves.toEqual({ error: "request_too_large" });

    const malformed = await fetch(endpoint(address, "/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toBe("application/json");
    const text = await malformed.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_request" });
    expect(text).not.toContain("SyntaxError");
  });

  test("token endpoint takes form bodies only (no app-level JSON parser)", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();

    const response = await fetch(endpoint(address, "/token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: "lag_mcp",
        code: "code",
        code_verifier: PKCE_VERIFIER
      })
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  });

  test("stop() does not wait for a client that is still uploading", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();
    const target = new URL(url);
    const socket = netConnect(Number(target.port), target.hostname);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write(
      `POST ${target.pathname} HTTP/1.1\r\nhost: ${target.host}\r\n` +
        `authorization: ${bearer("lag_mcp", "pws_local_mcp-token")}\r\n` +
        "content-type: application/json\r\naccept: application/json, text/event-stream\r\n" +
        'content-length: 100\r\n\r\n{"jsonrpc"'
    );
    // Let the server pick the request up and park in readRequestBody.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const stopping = server?.stop() ?? Promise.resolve();
    server = null;
    await expect(
      Promise.race([
        stopping.then(() => "stopped"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 3_000))
      ])
    ).resolves.toBe("stopped");
    socket.destroy();
  });

  test("uses a stable default port", () => {
    expect(LOCAL_AGENT_MCP_PORT).toBe(51_729);
  });

  test("shutdown closes the socket and rejects subsequent requests", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    const url = await startServer();
    await connect(url, "pws_local_mcp-token");
    await server?.stop();
    server = null;

    await expect(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer pws_local_mcp-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
      })
    ).rejects.toThrow();
  });
});
