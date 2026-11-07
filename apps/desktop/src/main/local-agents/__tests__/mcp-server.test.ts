import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_AGENT_CAPABILITIES, ok, resolveLocalAgentPolicy } from "@pwrsnap/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { Agent, request } from "node:http";
vi.mock("electron", () => ({
  app: { getVersion: () => "9.8.7" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}));
import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { DesktopSettingsService, defaultSettings } from "../../settings/desktop-settings-service";
import { LocalAgentGrantService } from "../local-agent-grants";
import { LocalAgentMcpServer } from "../mcp-server";
import { NativeMcpBridge } from "../../ai/mcp/native-mcp-bridge";
import { bus } from "../../command-bus";
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
const agents: Agent[] = [];
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
    bridgeFactory: (onConnection) => new NativeMcpBridge({ executable, endpoint, allowHttp: true, onConnection }),
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
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.stop();
});

function httpHost() {
  const agent = new Agent({ keepAlive: true });
  agents.push(agent);
  return (body?: unknown, headers: Record<string, string> = {}, method = "POST") => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const bytes = body === undefined ? "" : JSON.stringify(body);
    const req = request({ socketPath: endpoint, path: "/mcp", method, agent,
      headers: { host: "localhost", accept: "application/json, text/event-stream", "content-type": "application/json", "content-length": Buffer.byteLength(bytes), ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(bytes);
  });
}
const initializeHttp = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "IPC HTTP host", version: "1" },
  _meta: { approval: { policy: "native" } }, extension: { preserved: true }
} };
function httpMessage(text: string): Record<string, unknown> {
  return JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
}
test("HTTP policy edits before initialization/SSE queue invalidations and later edits notify the open stream", async () => {
  const { token } = await server.bootstrapHttp(new AbortController().signal);
  const [grant] = await grants.list();
  await grants.assignRole(grant.id, "builtin.full-access");
  await server.settingsChanged();
  const send = httpHost();
  const initialized = await send(initializeHttp, { authorization: `Bearer ${token}` });
  const headers = { authorization: `Bearer ${token}`, "mcp-session-id": initialized.headers["mcp-session-id"] as string };
  // A host that never opens SSE can still explicitly rediscover current tools.
  expect(httpMessage((await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers)).text))
    .toMatchObject({ result: { tools: [{ name: "fixture_search" }] } });
  const events: string[] = [];
  const req = request({ socketPath: endpoint, path: "/mcp", method: "GET", headers: {
    ...headers, accept: "text/event-stream"
  } }, (res) => { res.setEncoding("utf8"); res.on("data", (bytes: string) => events.push(bytes)); });
  req.on("error", () => undefined);
  req.end();
  const messages = (): string[] => events.join("").split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => (JSON.parse(line.slice(6)) as { method: string }).method);
  try {
    await vi.waitFor(() => expect(messages()).toEqual([
      "notifications/tools/list_changed", "notifications/resources/list_changed"
    ]));
    await grants.assignRole(grant.id, "builtin.preview");
    await server.settingsChanged();
    await vi.waitFor(() => expect(messages()).toHaveLength(4));
    expect((await grants.authorizeClient(grant.id))?.capabilities).toEqual(["library.read"]);
  } finally { req.destroy(); }
});
test("HTTP over the same protected IPC endpoint uses native bootstrap and the desktop catalog and validation", async () => {
  const send = httpHost();
  expect((await send(initializeHttp)).status).toBe(401);
  expect(consent).not.toHaveBeenCalled();
  const credential = await server.bootstrapHttp(new AbortController().signal);
  const headers: Record<string, string> = { authorization: `Bearer ${credential.token}` };
  const initialized = await send(initializeHttp, headers);
  expect(initialized.status).toBe(200);
  expect(httpMessage(initialized.text)).toMatchObject({ result: { serverInfo: { name: "PwrSnap", version: "9.8.7" } } });
  expect(initialized.text).toContain("direct IPC HTTP/1.x; no relay");
  headers["mcp-session-id"] = initialized.headers["mcp-session-id"] as string;
  headers["mcp-protocol-version"] = "2025-11-25";
  expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
  const tools = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers);
  expect(httpMessage(tools.text)).toMatchObject({ result: { tools: [{ name: "fixture_search", description: "Desktop-owned fixture description", annotations: { readOnlyHint: true }, inputSchema: { required: ["query"] } }] } });
  const bad = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fixture_search", arguments: { query: 4 } } }, headers);
  expect(httpMessage(bad.text)).toMatchObject({ result: { isError: true } });
  expect(dispatch).not.toHaveBeenCalled();
  const good = await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fixture_search", arguments: { query: "hello" }, _meta: { progressToken: "preserved" } } }, headers);
  expect(good.status).toBe(200);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(consent).toHaveBeenCalledOnce();
  const [grant] = await grants.list();
  await grants.assignRole(grant.id, "builtin.full-access");
  expect((await grants.authorizeClient(grant.id))?.capabilities).toEqual(["library.read"]);
});
test("HTTP session ids and old approvals never replace the bearer credential or authorize a second initialization", async () => {
  const send = httpHost();
  const { token } = await server.bootstrapHttp(new AbortController().signal);
  const first = await send(initializeHttp, { authorization: `Bearer ${token}` });
  const id = first.headers["mcp-session-id"] as string;
  expect((await httpHost()(initializeHttp, { authorization: `Bearer ${token}`, "mcp-session-id": id })).status).toBe(409);
  expect((await httpHost()(initializeHttp, { authorization: `Bearer ${token}` })).status).toBe(404);
  expect((await httpHost()(undefined, { "mcp-session-id": id }, "GET")).status).toBe(401);
  expect((await httpHost()(undefined, { authorization: `Bearer ${token}`, "mcp-session-id": "other" }, "GET")).status).toBe(404);
  const [grant] = await grants.list();
  await grants.revokeGrant(grant.id); await server.settingsChanged();
  expect((await httpHost()(initializeHttp, { authorization: `Bearer ${token}` })).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});
test("HTTP DELETE delivers its terminal response and revokes all Session streams and the consumed credential", async () => {
  const send = httpHost();
  const { token } = await server.bootstrapHttp(new AbortController().signal);
  const first = await send(initializeHttp, { authorization: `Bearer ${token}` });
  const headers = { authorization: `Bearer ${token}`, "mcp-session-id": first.headers["mcp-session-id"] as string };
  expect((await send(undefined, headers, "DELETE")).status).toBe(200);
  await vi.waitFor(async () => expect((await grants.list())[0].revokedAt).not.toBeNull());
  expect((await httpHost()(initializeHttp, { authorization: `Bearer ${token}` })).status).toBe(401);
});
test("persistent HTTP and SSE deliver discovery changes, and a closed SSE cannot resume or replay", async () => {
  const send = httpHost();
  const { token } = await server.bootstrapHttp(new AbortController().signal);
  const initialized = await send(initializeHttp, { authorization: `Bearer ${token}` });
  const headers = { host: "localhost", accept: "text/event-stream", authorization: `Bearer ${token}`,
    "mcp-session-id": initialized.headers["mcp-session-id"] as string, "mcp-protocol-version": "2025-11-25" };
  await send({ jsonrpc: "2.0", method: "notifications/initialized" }, headers);
  let stream: import("node:http").IncomingMessage | undefined;
  let events = "";
  const opened = new Promise<void>((resolve, reject) => {
    const req = request({ socketPath: endpoint, path: "/mcp", method: "GET", headers }, (res) => {
      stream = res; res.setEncoding("utf8");
      res.on("data", (chunk) => { events += chunk; resolve(); });
      res.on("error", () => undefined);
    });
    req.on("error", reject); req.end();
  });
  const [grant] = await grants.list();
  // Wait for the parser to establish GET before changing discovery. No
  // resumption event store is present, so the first data is a real change.
  let transition = 0;
  await vi.waitFor(async () => {
    const result = await httpHost()(undefined, { ...headers, "last-event-id": "never-replay" }, "GET");
    expect(result.status).toBe(400);
    await grants.assignRole(grant.id, ++transition % 2 ? "builtin.full-access" : "builtin.search");
    await server.settingsChanged();
    expect(events).toContain("notifications/tools/list_changed");
  });
  await opened;
  expect(events).toContain("notifications/tools/list_changed");
  expect(events).not.toContain("id:");
  stream!.destroy();
  await vi.waitFor(async () => expect((await grants.list())[0].revokedAt).not.toBeNull());
  expect((await httpHost()(undefined, headers, "GET")).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});
test("HTTP bootstrap denial, cancellation and disconnect cannot leave an approval for replacement sessions", async () => {
  decision = { decision: "deny", sessionName: "", roleId: null, capabilities: [] };
  await expect(server.bootstrapHttp(new AbortController().signal)).rejects.toThrow();
  expect(await grants.list()).toEqual([]);
  decision = { decision: "allow", sessionName: "HTTP only", roleId: "builtin.search", capabilities: ["library.read"] };
  const controller = new AbortController();
  controller.abort();
  await expect(server.bootstrapHttp(controller.signal)).rejects.toThrow();
  expect(await grants.list()).toEqual([]);
  const { token } = await server.bootstrapHttp(new AbortController().signal);
  const initialized = await httpHost()(initializeHttp, { authorization: `Bearer ${token}` });
  expect(initialized.status).toBe(200);
  for (const agent of agents.splice(0)) agent.destroy();
  await vi.waitFor(async () => expect((await grants.list())[0].revokedAt).not.toBeNull());
  expect((await httpHost()(initializeHttp, { authorization: `Bearer ${token}` })).status).toBe(401);
});
test("HTTP and stdio share the Session cap, and concurrent replacements reclaim idle revoked HTTP sessions before admission", async () => {
  let index = 0;
  consent.mockImplementation(async () => ({ ...decision, sessionName: `HTTP Session ${++index}` }));
  for (let i = 0; i < 31; i++) await server.bootstrapHttp(new AbortController().signal);
  await connect();
  await expect(server.bootstrapHttp(new AbortController().signal)).rejects.toThrow("limit");
  expect(consent).toHaveBeenCalledTimes(32);
  const [grant] = await grants.list();
  await grants.revokeGrant(grant.id);
  const attempts = await Promise.allSettled([server.bootstrapHttp(new AbortController().signal), server.bootstrapHttp(new AbortController().signal)]);
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(consent).toHaveBeenCalledTimes(33);
  expect((await grants.list()).filter((grant) => grant.revokedAt === null)).toHaveLength(32);
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

test.each(["stdio", "HTTP"] as const)("upgraded Full Access roles connect over %s without widening prior consent", async (transport) => {
  const historical = defaultSettings();
  const permissions = LOCAL_AGENT_CAPABILITIES.filter((permission) => permission !== "sizzle.assets.import");
  historical.localAgents.roles = historical.localAgents.roles.map((role) =>
    role.id === "builtin.full-access" ? { ...role, permissions } : role
  );
  historical.localAgents.grants = [{
    id: "legacy_existing", name: "Existing Agent", roleId: "builtin.full-access", capabilities: permissions,
    createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", lastUsedAt: null, revokedAt: null
  }];
  writeFileSync(settingsPath, JSON.stringify(historical));
  const migrated = (await settings.read()).localAgents;
  const previousRole = migrated.roles.find((role) => role.id === migrated.grants[0].roleId)!;
  expect(previousRole.permissions).toEqual(permissions);
  for (const [name, roleId, capabilities] of [
    ["Previous permissions", previousRole.id, permissions],
    ["New explicit approval", "builtin.full-access", LOCAL_AGENT_CAPABILITIES]
  ] as const) {
    decision = { decision: "allow", sessionName: name, roleId, capabilities };
    if (transport === "stdio") {
      const client = await connect();
      expect((await client.listTools()).tools[0].name).toBe("fixture_search");
      expect((await client.callTool({ name: "fixture_search", arguments: { query: name } })).isError).not.toBe(true);
    } else {
      const { token } = await server.bootstrapHttp(new AbortController().signal);
      const send = httpHost();
      const initialized = await send(initializeHttp, { authorization: `Bearer ${token}` });
      expect(initialized.status).toBe(200);
      const headers = { authorization: `Bearer ${token}`, "mcp-session-id": initialized.headers["mcp-session-id"] as string };
      const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers);
      expect(httpMessage(listed.text)).toMatchObject({ result: { tools: [{ name: "fixture_search" }] } });
      const called = await send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fixture_search", arguments: { query: name } } }, headers);
      expect(httpMessage(called.text)).toMatchObject({ result: { content: expect.any(Array) } });
      expect((httpMessage(called.text).result as { isError?: boolean }).isError).not.toBe(true);
    }
    const reopened = (await new DesktopSettingsService({ filePath: settingsPath }).read()).localAgents;
    for (const [sessionName, expected] of [
      ["Existing Agent", permissions], ["Previous permissions", permissions], [name, capabilities]
    ] as const) {
      const grant = reopened.grants.find((item) => item.name === sessionName)!;
      const policy = resolveLocalAgentPolicy(reopened, grant.id);
      expect(policy.ok).toBe(true);
      if (!policy.ok) throw new Error(policy.code);
      expect(policy.policy.capabilities).toEqual(expected);
    }
  }
  expect(consent).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledTimes(2);
});

test("main's Sizzle catalog and protected media use the same production handlers over stdio and IPC HTTP", async () => {
  await server.stop();
  decision = { decision: "allow", sessionName: "Sizzle stdio", roleId: null,
    capabilities: ["sizzle.compose", "sizzle.assets.import", "sizzle.preview.read", "sizzle.full.read"] };
  server = new LocalAgentMcpServer({ settings, grantService: grants, requestConsent: consent,
    secrets: new DesktopSecretStore({ filePath: settingsPath + ".secrets" }),
    bridgeFactory: (onConnection) => new NativeMcpBridge({ executable, endpoint, allowHttp: true, onConnection }) });
  const { writeFile } = await import("node:fs/promises");
  const mediaPath = settingsPath + ".png";
  const bytes = Buffer.from("private Sizzle contact sheet");
  await writeFile(mediaPath, bytes);
  const inspect = vi.fn(async () => ok({ outputPath: mediaPath, widthPx: 1920, heightPx: 1080, renderId: "frames" }));
  bus.installLocalAgentAuthorizer((id) => grants.authorizeClient(id));
  bus.register("sizzle:inspectFrames", inspect);
  try {
    await server.start();
    const client = await connect();
    const tools = (await client.listTools()).tools;
    for (const suffix of ["get", "audio_qa", "prepare_narration", "align_narration", "apply_launch_template",
      "import_capture", "import", "update", "set_bindings", "inspect_frames"])
      expect(tools.map((tool) => tool.name)).toContain(`pwrsnap_sizzle_${suffix}`);
    decision = { ...decision, sessionName: "Sizzle IPC HTTP" };
    const { token } = await server.bootstrapHttp(new AbortController().signal);
    const send = httpHost();
    const initialized = await send(initializeHttp, { authorization: `Bearer ${token}` });
    const headers = { authorization: `Bearer ${token}`, "mcp-session-id": initialized.headers["mcp-session-id"] as string };
    const listed = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }, headers);
    expect(httpMessage(listed.text).result).toEqual({ tools });
    const result = await client.callTool({ name: "pwrsnap_sizzle_inspect_frames", arguments: { projectId: "project", frames: [0] } });
    expect(result.isError).not.toBe(true);
    expect(inspect).toHaveBeenCalledOnce();
    const link = CallToolResultSchema.parse(result).content.find((item) => item.type === "resource_link");
    expect(link?.type).toBe("resource_link");
    if (link?.type !== "resource_link") throw new Error("Expected MCP media link");
    expect(link.uri).toMatch(/^pwrsnap:\/\//);
    const media = await client.readResource({ uri: link.uri });
    expect(media.contents).toEqual([{ uri: link.uri, mimeType: "image/png", blob: bytes.toString("base64") }]);
  } finally {
    bus.unregister("sizzle:inspectFrames");
    bus.uninstallLocalAgentAuthorizerForTests();
  }
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
