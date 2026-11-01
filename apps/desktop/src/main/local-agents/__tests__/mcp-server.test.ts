import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ok, resolveLocalAgentPolicy } from "@pwrsnap/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
vi.mock("electron", () => ({
  app: { getVersion: () => "9.8.7" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { LocalAgentGrantService } from "../local-agent-grants";
import { LocalAgentMcpServer } from "../mcp-server";
import { NativeMcpBridge } from "../../ai/mcp/native-mcp-bridge";
import type { LocalAgentConsentDecision } from "../local-agent-consent-broker";
const executable = fileURLToPath(
  new URL(
    "../../../../build/mcp/" + (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"),
    import.meta.url
  )
);
let server: LocalAgentMcpServer;
let settings: DesktopSettingsService;
let grants: LocalAgentGrantService;
let endpoint: string;
let settingsPath: string;
let decision: LocalAgentConsentDecision;
const clients: Client[] = [];
const consent = vi.fn();
const dispatch = vi.fn(async (_input: unknown, ctx: { capabilities: readonly string[] }) =>
  ok({ caps: ctx.capabilities })
);
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-"));
  endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\psm-${dir.split(/[\\/]/).pop()}`
      : join(dir, "mcp.sock");
  settingsPath = join(dir, "settings.json");
  settings = new DesktopSettingsService({ filePath: settingsPath });
  const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
  grants = new LocalAgentGrantService({ settings, secrets });
  decision = {
    decision: "allow",
    sessionName: "Fixture Session",
    roleId: "builtin.search",
    capabilities: ["library.read"]
  };
  consent.mockReset();
  consent.mockImplementation(async () => decision);
  dispatch.mockClear();
  server = new LocalAgentMcpServer({
    settings,
    secrets,
    grantService: grants,
    version: "9.8.7",
    requestConsent: consent,
    usageService: {
      reserve: () => ({
        ok: true,
        reservation: {
          id: "fixture",
          sessionId: "fixture",
          action: "search",
          used: 1,
          limit: 50,
          windowSeconds: 86400
        }
      }),
      release: () => undefined
    },
    bridgeFactory: (onConnection) => new NativeMcpBridge({ executable, endpoint, onConnection }),
    tools: [
      {
        name: "fixture_search",
        title: "Fixture search",
        description: "Desktop-owned fixture description",
        inputSchema: { query: z.string() },
        requiredCapabilities: ["library.read"],
        annotations: { readOnlyHint: true, openWorldHint: false },
        dispatch
      }
    ]
  });
  await server.start();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.stop();
});
async function connect(): Promise<Client> {
  const client = new Client({ name: "Fixture host", version: "0.0.2" }, { capabilities: {} });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: executable,
      args: ["--endpoint", endpoint],
      stderr: "pipe"
    })
  );
  return client;
}
test("mixed release versions use the desktop interface and preserve descriptions, schemas and annotations", async () => {
  const client = await connect();
  expect(client.getServerVersion()).toEqual({ name: "PwrSnap", version: "9.8.7" });
  expect(client.getInstructions()).toContain("relay 1.0.0; local transport 1");
  expect(consent).toHaveBeenCalledOnce();
  const tools = await client.listTools();
  expect(tools.tools[0]).toMatchObject({
    name: "fixture_search",
    description: "Desktop-owned fixture description",
    annotations: { readOnlyHint: true },
    inputSchema: { required: ["query"] }
  });
  const result = await client.callTool({ name: "fixture_search", arguments: { query: "hello" } });
  expect(result.isError).not.toBe(true);
  expect(dispatch).toHaveBeenCalledOnce();
});
test("schema validation and capability boundaries stay desktop-owned", async () => {
  const client = await connect();
  expect((await client.callTool({ name: "fixture_search", arguments: { query: 4 } })).isError).toBe(
    true
  );
  expect(dispatch).not.toHaveBeenCalled();
  const [grant] = await grants.list();
  await grants.assignRole(grant.id, "builtin.sizzle");
  const result = await client.callTool({ name: "fixture_search", arguments: { query: "hello" } });
  expect(result.isError).not.toBe(true);
  expect(dispatch.mock.calls[0][1].capabilities).toEqual(["library.read"]);
  expect((await grants.authorizeClient(grant.id))?.capabilities).toEqual(["library.read"]);
});
test("native denial exposes no tools and creates no grant", async () => {
  decision = { decision: "deny", sessionName: "", roleId: null, capabilities: [] };
  await expect(connect()).rejects.toThrow();
  expect(await grants.list()).toEqual([]);
  expect(dispatch).not.toHaveBeenCalled();
});
test("revoking an idle session closes IPC and a fresh host needs new consent", async () => {
  const client = await connect();
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  const [grant] = await grants.list();
  await grants.revokeGrant(grant.id);
  await server.settingsChanged();
  await vi.waitFor(() => expect(closed).toBe(true));
  decision = { ...decision, sessionName: "Replacement" };
  await connect();
  expect(consent).toHaveBeenCalledTimes(2);
});
test("desktop disable closes sessions and never reconnects or replays calls", async () => {
  const client = await connect();
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  await server.stop();
  await vi.waitFor(() => expect(closed).toBe(true));
  await expect(
    client.callTool({ name: "fixture_search", arguments: { query: "x" } })
  ).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  await expect(connect()).rejects.toThrow();
});
test("host disconnect revokes its native session instead of transferring approval", async () => {
  const client = await connect();
  await client.close();
  await vi.waitFor(async () => expect((await grants.list())[0].revokedAt).not.toBeNull());
});
test("desktop absent fails with a manual reconnect instruction and never launches it", async () => {
  await server.stop();
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(executable, ["--endpoint", endpoint], {
    encoding: "utf8",
    timeout: 5000
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Open PwrSnap yourself");
  expect(result.stdout).toBe("");
});

test("persisted native consent ceilings survive settings parsing without widening", async () => {
  await connect();
  const [grant] = await grants.list();
  await grants.assignRole(grant.id, "builtin.full-access");
  const reopened = await new DesktopSettingsService({ filePath: settingsPath }).read();
  expect(reopened.localAgents.grants[0].nativeConsent?.capabilities).toEqual(["library.read"]);
  const policy = resolveLocalAgentPolicy(reopened.localAgents, grant.id);
  expect(policy.ok && policy.policy.maxCaptureAgeDays).toBe(7);
  expect(policy.ok && policy.policy.capabilities).toEqual(["library.read"]);
});

test("idempotent listener startup preserves an active native Session without replaying consent",async()=>{
  const client=await connect();await Promise.all([server.start(),server.start()]);
  expect((await grants.list())[0].revokedAt).toBeNull();
  expect((await client.listTools()).tools[0].name).toBe("fixture_search");
  expect(consent).toHaveBeenCalledOnce();
});
