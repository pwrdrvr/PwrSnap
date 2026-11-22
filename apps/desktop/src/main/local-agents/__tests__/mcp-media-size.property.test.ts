// The rule: no single MCP message PwrSnap sends may exceed what the official
// SDK's stdio client will buffer. A 1080p reel of ~14 MB went out as one
// base64 `resources/read` blob, the client's ReadBuffer threw at 10 MiB, and
// the host froze (2026-11-22). These tests run the production resource
// handler behind the real Rust relay and the real SDK stdio client, so the
// client's own buffer limit is the oracle, not a constant copied from here.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import fc from "fast-check";
import { ok } from "@pwrsnap/shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "9.8.7" },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s: string) => Buffer.from(s),
    decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false })
  }
}));
import { DesktopSecretStore } from "../../settings/desktop-secret-store";
import { DesktopSettingsService } from "../../settings/desktop-settings-service";
import { LocalAgentGrantService } from "../local-agent-grants";
import { LocalAgentMcpServer } from "../mcp-server";
import { NativeMcpBridge } from "../../ai/mcp/native-mcp-bridge";
import { bus } from "../../command-bus";

const executable = fileURLToPath(
  new URL(
    "../../../../build/mcp/" + (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"),
    import.meta.url
  )
);
const MiB = 1024 * 1024;
/** Every file up to this size must still be readable: the guard may not
 *  refuse ordinary contact sheets, narration takes or short previews. */
const GUARANTEED_READABLE_BYTES = 6 * MiB;

let dir: string;
let server: LocalAgentMcpServer;
let grants: LocalAgentGrantService;
let relayRole: string;
let mediaPath: string;
const clients: Client[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "psz-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\psz-${basename(dir)}`
    : join(dir, "mcp.sock");
  const settings = new DesktopSettingsService({ filePath: join(dir, "settings.json") });
  const secrets = new DesktopSecretStore({ filePath: join(dir, "secrets.bin") });
  grants = new LocalAgentGrantService({ settings, secrets });
  const role = await grants.createRole({
    name: "Sizzle size",
    description: "Sizzle media only",
    permissions: ["sizzle.compose", "sizzle.preview.read", "sizzle.full.read"],
    maxCaptureAgeDays: null,
    budgets: (await grants.listRoles()).find((r) => r.id === "builtin.full-access")!.budgets
  });
  relayRole = role.id;
  mediaPath = join(dir, "Launch reel-project-0123456789ab.mp4");
  server = new LocalAgentMcpServer({
    settings, secrets, grantService: grants, version: "9.8.7",
    requestConsent: async () => ({ decision: "deny", sessionName: "", roleId: null, capabilities: [] }),
    usageService: {
      reserve: () => ({
        ok: true as const,
        reservation: { id: "fixture", sessionId: "fixture", action: "search" as const, used: 1, limit: 50, windowSeconds: 86400 }
      }),
      release: () => undefined
    },
    bridgeFactory: (onConnection) => new NativeMcpBridge({ executable, endpoint, allowHttp: true, onConnection })
  });
  bus.installLocalAgentAuthorizer((id) => grants.authorizeClient(id));
  bus.register("sizzle:render", async () => ok({
    outputPath: mediaPath, durationSec: 30, renderId: "render-1", widthPx: 1920, heightPx: 1080
  }));
  await server.start();
  const client = new Client({ name: "Size host", version: "1" }, { capabilities: {} });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: executable, args: ["--role", relayRole, "--endpoint", endpoint], stderr: "pipe"
  }));
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await server.stop();
  bus.unregister("sizzle:render");
  bus.uninstallLocalAgentAuthorizerForTests();
  rmSync(dir, { recursive: true, force: true });
});

/** A lower bound on the bytes on the wire for a successful read of an n-byte
 *  file: the JSON-RPC response line the SDK client must buffer whole. The
 *  real line is at least this long (its id has at least one digit), so a
 *  bound over the limit proves the reply could not have been delivered. */
function successWireBytes(uri: string, n: number): number {
  const envelope = JSON.stringify({
    jsonrpc: "2.0", id: 0,
    result: { contents: [{ uri, blob: "", mimeType: "video/mp4" }] }
  });
  return Buffer.byteLength(envelope) + 4 * Math.ceil(n / 3) + 1;
}

/** Deterministic, incompressible-looking bytes without holding a PRNG. */
function media(n: number): Buffer {
  const bytes = Buffer.alloc(n);
  for (let offset = 0; offset < n; offset += 32)
    createHash("sha256").update(String(offset)).digest().copy(bytes, offset);
  return bytes;
}

async function renderFull(client: Client) {
  return CallToolResultSchema.parse(
    await client.callTool({ name: "pwrsnap_sizzle_render_full", arguments: { projectId: "project" } })
  );
}

test("property: a resources/read reply always fits the SDK stdio client's buffer, or is a typed size refusal", async () => {
  const client = clients[0]!;
  writeFileSync(mediaPath, media(1024));
  const issued = await renderFull(client);
  const link = issued.content.find((item) => item.type === "resource_link");
  if (link?.type !== "resource_link") throw new Error("a small render must carry its typed link");
  const uri = link.uri;
  // The largest file whose reply still fits the client, found from the oracle.
  let largestFitting = 0;
  while (successWireBytes(uri, largestFitting + 3) <= STDIO_DEFAULT_MAX_BUFFER_SIZE) largestFitting += 3;
  const sizes = fc.oneof(
    { weight: 2, arbitrary: fc.constantFrom(
      0, 1, GUARANTEED_READABLE_BYTES, GUARANTEED_READABLE_BYTES + 1,
      largestFitting, largestFitting + 1, 14_000_000
    ) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 16 * MiB }) }
  );
  await fc.assert(
    fc.asyncProperty(sizes, async (n) => {
      const bytes = media(n);
      writeFileSync(mediaPath, bytes);
      let outcome: { kind: "read"; blob: string } | { kind: "refused"; error: { code?: number; message: string; data?: unknown } };
      try {
        const result = await client.readResource({ uri }, { timeout: 20_000 });
        const content = result.contents[0]!;
        if (!("blob" in content)) throw new Error("expected a binary resource");
        outcome = { kind: "read", blob: content.blob };
      } catch (cause) {
        outcome = { kind: "refused", error: cause as { code?: number; message: string; data?: unknown } };
      }
      if (outcome.kind === "read") {
        expect(successWireBytes(uri, n)).toBeLessThanOrEqual(STDIO_DEFAULT_MAX_BUFFER_SIZE);
        expect(Buffer.from(outcome.blob, "base64").equals(bytes)).toBe(true);
      } else {
        // Only a size refusal is acceptable, and only for a file that
        // could not be guaranteed to fit.
        expect(n).toBeGreaterThan(GUARANTEED_READABLE_BYTES);
        expect(outcome.error.data).toMatchObject({
          code: "resource_too_large", uri, byteSize: n, mimeType: "video/mp4"
        });
        expect(outcome.error.message).toContain(String(n));
        expect(outcome.error.message).not.toContain(dir);
      }
      if (successWireBytes(uri, n) > STDIO_DEFAULT_MAX_BUFFER_SIZE) expect(outcome.kind).toBe("refused");
      // The connection survives either way.
      expect((await client.listTools({}, { timeout: 20_000 })).tools.length).toBeGreaterThan(0);
    }),
    // No shrinking: an oversized reply kills the client connection, so every
    // shrunk retry would fail for that reason instead of the original one.
    { numRuns: 14, endOnFailure: true }
  );
}, 240_000);

test("render_full advertises its byte size and withholds the link when one read cannot carry it", async () => {
  const client = clients[0]!;
  for (const n of [700_000, 14_000_000]) {
    writeFileSync(mediaPath, media(n));
    const result = await renderFull(client);
    expect(result.isError).not.toBe(true);
    const value = result.structuredContent as Record<string, unknown>;
    expect(value).toMatchObject({
      byteSize: n,
      mcpReadable: n <= GUARANTEED_READABLE_BYTES,
      maxMcpReadBytes: expect.any(Number),
      savedTo: { fileName: basename(mediaPath) }
    });
    // The user's videos folder is named; the private absolute path never is.
    expect(JSON.stringify(result)).not.toContain(dir);
    const link = result.content.find((item) => item.type === "resource_link");
    if (n <= GUARANTEED_READABLE_BYTES) {
      expect(link).toMatchObject({ size: n, mimeType: "video/mp4" });
      expect(value.mcpReadRefusal).toBeUndefined();
    } else {
      expect(link).toBeUndefined();
      expect(value.resourceUri).toBeUndefined();
      expect(value.mcpReadRefusal).toEqual(expect.stringContaining(String(n)));
      expect(value.mcpReadRefusal).toEqual(expect.stringContaining("pwrsnap_sizzle_render_preview"));
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("too large") });
    }
  }
}, 60_000);
