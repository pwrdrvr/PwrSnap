import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ok } from "@pwrsnap/shared";
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
import type { LocalAgentMcpTool } from "../mcp-tool-registry";

let workDir = "";
let settings: DesktopSettingsService;
let secrets: DesktopSecretStore;
let grantService: LocalAgentGrantService;
let server: LocalAgentMcpServer | null = null;
let client: Client | null = null;
let extraClient: Client | null = null;

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
        openWorldHint: false
      },
      dispatch: async (input, ctx) =>
        ok({
          deleted: input.captureId,
          clientId: ctx.clientId
        })
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
    port: 0
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
      headers.set("authorization", `Bearer ${clientId}:${token}`);
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

async function approveAndExchange(
  address: LocalAgentMcpServerAddress,
  oauthClient: RegisteredOAuthClient,
  capabilities: readonly string[],
  requestedScopes?: readonly string[]
): Promise<string> {
  const authorizationUrl = makeAuthorizationUrl(
    address,
    oauthClient,
    requestedScopes
  );
  authorizationUrl.searchParams.set("pwrsnap_decision", "allow");
  for (const capability of capabilities) {
    authorizationUrl.searchParams.append("capability", capability);
  }
  const authorized = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorized.status).toBe(302);
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

  test("lists tool schemas with read-only and destructive annotations", async () => {
    await grantService.createGrant({
      name: "PwrAgent",
      capabilities: ["library.read", "trash.write"]
    });
    const connected = await connect(await startServer(), "pws_local_mcp-token");

    const tools = await connected.listTools();

    const search = tools.tools.find((tool) => tool.name === "pwrsnap_library_search");
    const trash = tools.tools.find((tool) => tool.name === "pwrsnap_capture_delete_to_trash");
    expect(search?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(search?.inputSchema.properties).toHaveProperty("query");
    expect(trash?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
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

  test("authorizes a dynamically registered client through editable browser consent", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();
    const oauthClient = await registerOAuthClient(address, "Codex Desktop");
    expect(oauthClient.token_endpoint_auth_method).toBe("none");
    expect(oauthClient).not.toHaveProperty("client_secret");

    const defaultConsent = await fetch(makeAuthorizationUrl(address, oauthClient));
    const defaultPage = await defaultConsent.text();
    expect(defaultPage).toMatch(/value="library\.read" checked/u);
    expect(defaultPage).toMatch(/value="capture\.composite\.read" checked/u);
    expect(defaultPage).not.toMatch(/value="capture\.original\.read" checked/u);

    const consent = await fetch(
      makeAuthorizationUrl(address, oauthClient, ["library.read"])
    );
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
    const page = await consent.text();
    expect(page).toContain("Codex Desktop wants to access PwrSnap");
    expect(page).toContain("Search library metadata");
    expect(page).toContain("Move captures to Trash");

    const accessToken = await approveAndExchange(
      address,
      oauthClient,
      ["library.read", "trash.write"],
      ["library.read"]
    );
    const grants = await grantService.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      id: oauthClient.client_id,
      name: "Codex Desktop",
      capabilities: ["library.read", "trash.write"],
      revokedAt: null,
      oauthClient: {
        clientId: oauthClient.client_id,
        redirectUris: [OAUTH_CALLBACK]
      }
    });

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
      port: 0
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
      port: 0
    });
    const secondAddress = await server.start();
    const consent = await fetch(
      makeAuthorizationUrl(secondAddress, oauthClient, ["library.read"])
    );
    expect(consent.status).toBe(200);

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
      port: 0
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
    authorizationUrl.searchParams.set("pwrsnap_decision", "deny");
    const denied = await fetch(authorizationUrl, { redirect: "manual" });
    expect(denied.status).toBe(302);
    const callback = new URL(denied.headers.get("location") ?? "");
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(await grantService.list()).toEqual([]);
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

    client = await connect(address.url, "pws_local_mcp-token");
    const resource = await client.readResource({
      uri: "pwrsnap://capture/cap_1/original"
    });
    expect(resource.contents[0]).toMatchObject({
      uri: "pwrsnap://capture/cap_1/original",
      mimeType: "image/png",
      blob: Buffer.from("sensitive-media").toString("base64")
    });
    expect((await settings.read()).localAgents.audit).toHaveLength(2);

    await grantService.revokeGrant("lag_mcp");
    const revoked = await fetch(signed.url);
    expect(revoked.status).toBe(403);
    expect((await settings.read()).localAgents.audit).toHaveLength(2);
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

  test("rejects request bodies larger than one MiB", async () => {
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0
    });
    const address = await server.start();

    const response = await fetch(endpoint(address, "/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "oversize",
        redirect_uris: [OAUTH_CALLBACK],
        padding: "x".repeat(1024 * 1024)
      })
    });

    expect(response.status).toBe(413);
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
