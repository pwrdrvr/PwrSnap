import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { LocalAgentMcpServer } from "../mcp-server";
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

describe("LocalAgentMcpServer", () => {
  test("refuses unpaired clients before MCP initialization", async () => {
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

  test("paired client with library.read can search but cannot delete without trash.write", async () => {
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

  test("discovers and pairs through a native approval callback", async () => {
    const discoveryFilePath = join(workDir, "local-agent-mcp.json");
    const approvePairing = vi.fn(async () => true);
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      discoveryFilePath,
      approvePairing
    });
    const address = await server.start();
    const descriptorText = readFileSync(discoveryFilePath, "utf8");
    const descriptor = JSON.parse(descriptorText) as Record<string, unknown>;

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      mcpUrl: address.url,
      pairUrl: address.pairUrl,
      pid: process.pid
    });
    expect(descriptorText).not.toContain("token");
    if (process.platform !== "win32") {
      expect(statSync(discoveryFilePath).mode & 0o777).toBe(0o600);
    }

    const paired = await fetch(address.pairUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "PwrAgent",
        capabilities: ["library.read"]
      })
    });
    expect(paired.status).toBe(201);
    const credential = await paired.json() as {
      clientId: string;
      token: string;
      mcpUrl: string;
    };
    expect(approvePairing).toHaveBeenCalledWith({
      name: "PwrAgent",
      capabilities: ["library.read"]
    });
    expect(credential).toMatchObject({
      clientId: "lag_mcp",
      token: "pws_local_mcp-token",
      mcpUrl: address.url
    });

    client = await connectAs(
      credential.mcpUrl,
      credential.clientId,
      credential.token,
      new Client({ name: "paired", version: "1.0.0" })
    );
    await expect(client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "pwrsnap_library_search" })
      ])
    });
  });

  test("denies pairing without creating a grant and rejects hostile origins", async () => {
    const approvePairing = vi.fn(async () => false);
    server = new LocalAgentMcpServer({
      settings,
      secrets,
      grantService,
      tools: toolSet(),
      host: "127.0.0.1",
      port: 0,
      approvePairing
    });
    const address = await server.start();
    const body = JSON.stringify({
      name: "Untrusted Agent",
      capabilities: ["capture.original.read"]
    });

    const hostile = await fetch(address.pairUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example"
      },
      body
    });
    expect(hostile.status).toBe(403);
    expect(approvePairing).not.toHaveBeenCalled();

    const denied = await fetch(address.pairUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    expect(denied.status).toBe(403);
    expect(await grantService.list()).toEqual([]);
  });

  test("rejects requests outside the exact MCP and pairing paths", async () => {
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
      port: 0,
      approvePairing: async () => true
    });
    const address = await server.start();

    const response = await fetch(address.pairUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "oversize",
        capabilities: ["library.read"],
        padding: "x".repeat(1024 * 1024)
      })
    });

    expect(response.status).toBe(413);
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
