import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LocalAgentMcpResourceRegistry,
  MCP_CLIENT_MESSAGE_LIMIT_BYTES,
  MCP_MAX_RESOURCE_BLOB_BYTES,
  mcpMediaSize
} from "../mcp-resource-registry";

describe("LocalAgentMcpResourceRegistry", () => {
  test("rechecks owner and capability on every resource read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-resource-"));
    const path = join(dir, "capture.png");
    await writeFile(path, "media");
    const registry = new LocalAgentMcpResourceRegistry();
    let resolvingClientId: string | null = null;
    registry.register({
      uri: "pwrsnap://capture/cap_1/original",
      name: "original",
      mimeType: "image/png",
      requiredCapabilities: ["capture.original.read"],
      ownerClientId: "lag_owner",
      resolvePath: async (context) => {
        resolvingClientId = context.clientId;
        return path;
      }
    });

    await expect(registry.read(
      "pwrsnap://capture/cap_1/original",
      {
        clientId: "lag_owner",
        capabilities: ["capture.original.read"]
      }
    )).resolves.toMatchObject({ bytes: Buffer.from("media") });
    expect(resolvingClientId).toBe("lag_owner");

    await expect(registry.read(
      "pwrsnap://capture/cap_1/original",
      { clientId: "lag_owner", capabilities: [] }
    )).rejects.toMatchObject({
      code: "forbidden"
    });
    await expect(registry.read(
      "pwrsnap://capture/cap_1/original",
      {
        clientId: "lag_other",
        capabilities: ["capture.original.read"]
      }
    )).rejects.toMatchObject({
      code: "forbidden"
    });
  });

  test("refuses a file over the one-message cap before reading it, and serves one at the cap", async () => {
    // The cap's base64 form plus a JSON envelope must fit the client's buffer.
    expect(4 * Math.ceil(MCP_MAX_RESOURCE_BLOB_BYTES / 3) + 64 * 1024)
      .toBeLessThan(MCP_CLIENT_MESSAGE_LIMIT_BYTES);
    const dir = await mkdtemp(join(tmpdir(), "pwrsnap-resource-"));
    const path = join(dir, "reel.mp4");
    const registry = new LocalAgentMcpResourceRegistry();
    registry.register({
      uri: "pwrsnap://sizzle/p/full/r",
      name: "full",
      mimeType: "video/mp4",
      requiredCapabilities: [],
      resolvePath: async () => path
    });
    const context = { clientId: "lag_owner", capabilities: [] };
    await writeFile(path, Buffer.alloc(MCP_MAX_RESOURCE_BLOB_BYTES + 1));
    await expect(registry.read("pwrsnap://sizzle/p/full/r", context)).rejects.toMatchObject({
      code: "too_large",
      byteSize: MCP_MAX_RESOURCE_BLOB_BYTES + 1
    });
    await writeFile(path, Buffer.alloc(MCP_MAX_RESOURCE_BLOB_BYTES));
    const read = await registry.read("pwrsnap://sizzle/p/full/r", context);
    expect(read.bytes.length).toBe(MCP_MAX_RESOURCE_BLOB_BYTES);
    expect(mcpMediaSize(MCP_MAX_RESOURCE_BLOB_BYTES).mcpReadable).toBe(true);
    expect(mcpMediaSize(MCP_MAX_RESOURCE_BLOB_BYTES + 1).mcpReadable).toBe(false);
  });
});
