import { mkdtempSync } from "node:fs";
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
import { LocalAgentMcpServer } from "../mcp-server";
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

  test("keeps independent streamable HTTP sessions for multiple clients", async () => {
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

    expect(client.transport?.sessionId).toBeTruthy();
    expect(extraClient.transport?.sessionId).toBeTruthy();
    expect(client.transport?.sessionId).not.toBe(extraClient.transport?.sessionId);

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
