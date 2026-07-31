import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalAgentMcpResourceRegistry } from "../mcp-resource-registry";

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
});
