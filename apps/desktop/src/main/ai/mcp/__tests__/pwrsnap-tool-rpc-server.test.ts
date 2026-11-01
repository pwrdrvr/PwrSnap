import { expect, test, vi } from "vitest";
vi.mock("electron", () => ({
  app: {
    getVersion: () => "9.8.7",
    getAppPath: () => new URL("../../../../../", import.meta.url).pathname,
    isPackaged: false
  }
}));
import { PwrSnapToolRpcServer } from "../pwrsnap-tool-rpc-server";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
const executable = fileURLToPath(
  new URL(
    "../../../../../build/mcp/" +
      (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"),
    import.meta.url
  )
);
const catalog = [
  {
    type: "function" as const,
    name: "fixture",
    description: "Fixture",
    inputSchema: { type: "object", properties: {} }
  }
];
test("per-run catalogs, identity, discovery changes and unregister remain isolated", async () => {
  const server = new PwrSnapToolRpcServer();
  await server.start();
  const dispatch = vi.fn(async () => ({
    success: true,
    contentItems: [{ type: "inputText" as const, text: "done" }]
  }));
  const registration = server.register({
    catalog,
    dispatchToolCall: dispatch,
    label: "fixture/chat"
  });
  const client = new Client({ name: "fixture", version: "1" }, { capabilities: {} });
  const changed = vi.fn();
  client.setNotificationHandler(ToolListChangedNotificationSchema, changed);
  try {
    await client.connect(
      new StdioClientTransport({
        command: executable,
        args: ["--endpoint", registration.socketPath],
        env: { PWRSNAP_MCP_TOKEN: registration.token },
        stderr: "pipe"
      })
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["fixture"]);
    await client.callTool({ name: "fixture", arguments: {} });
    expect(dispatch).toHaveBeenCalledOnce();
    registration.updateCatalog([{ ...catalog[0], name: "replacement" }]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["replacement"]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await client.callTool({ name: "replacement", arguments: {} });
    expect(dispatch).toHaveBeenCalledTimes(2);
    let closed = false;
    client.onclose = () => {
      closed = true;
    };
    registration.unregister();
    await vi.waitFor(() => expect(closed).toBe(true));
    const rejected = new Client({ name: "other", version: "1" }, { capabilities: {} });
    await expect(
      rejected.connect(
        new StdioClientTransport({
          command: executable,
          args: ["--endpoint", registration.socketPath],
          env: { PWRSNAP_MCP_TOKEN: registration.token },
          stderr: "pipe"
        })
      )
    ).rejects.toThrow();
    await rejected.close();
  } finally {
    await client.close();
    await server.stop();
  }
});
