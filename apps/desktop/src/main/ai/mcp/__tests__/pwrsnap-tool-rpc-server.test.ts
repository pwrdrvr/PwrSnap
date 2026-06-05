import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec
} from "@pwrdrvr/codex-app-server-protocol/v2";
import { PwrSnapToolRpcServer } from "../pwrsnap-tool-rpc-server";

const catalog: DynamicToolSpec[] = [
  {
    name: "draw_arrow",
    description: "Draw an arrow",
    parameters: { type: "object", properties: {} }
  } as unknown as DynamicToolSpec
];

/** A minimal valid tool response (`{ success, contentItems }`). */
function makeResponse(text = "ok"): DynamicToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }]
  } as unknown as DynamicToolCallResponse;
}

/** One request/response round-trip over the UDS. */
function rpc(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath, () => {
      socket.write(JSON.stringify(payload) + "\n");
    });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)));
      }
    });
    socket.on("error", reject);
  });
}

describe("PwrSnapToolRpcServer", () => {
  let dir: string;
  let server: PwrSnapToolRpcServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pwrsnap-mcp-rpc-"));
    server = new PwrSnapToolRpcServer();
    await server.start(dir);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("list returns the registered surface catalog", async () => {
    const { socketPath, token } = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    const res = (await rpc(socketPath, { token, op: "list" })) as {
      ok: boolean;
      tools: DynamicToolSpec[];
    };
    expect(res.ok).toBe(true);
    expect(res.tools.map((t) => t.name)).toEqual(["draw_arrow"]);
  });

  test("call routes to the surface dispatch with the params", async () => {
    let seen: DynamicToolCallParams | undefined;
    const { socketPath, token } = server.register({
      catalog,
      dispatchToolCall: async (params) => {
        seen = params;
        return {
          contentItems: [{ type: "inputText", text: "done" }]
        } as unknown as DynamicToolCallResponse;
      }
    });
    const call: DynamicToolCallParams = {
      tool: "draw_arrow",
      namespace: "library",
      arguments: { capture_id: "cap-1" }
    } as unknown as DynamicToolCallParams;
    const res = (await rpc(socketPath, { token, op: "call", call })) as {
      ok: boolean;
      response: DynamicToolCallResponse;
    };
    expect(res.ok).toBe(true);
    expect(seen?.tool).toBe("draw_arrow");
    expect((seen?.arguments as { capture_id: string }).capture_id).toBe("cap-1");
  });

  test("rejects an unknown / unregistered token", async () => {
    const { socketPath } = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    const res = (await rpc(socketPath, { token: "not-a-real-token", op: "list" })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unauthorized");
  });

  test("unregister revokes the token", async () => {
    const reg = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    reg.unregister();
    const res = (await rpc(reg.socketPath, { token: reg.token, op: "list" })) as {
      ok: boolean;
      error: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("unauthorized");
  });

  test("ToolRpcClient round-trips list + call against the server", async () => {
    const { ToolRpcClient } = await import("../pwrsnap-tool-rpc-client");
    let seen: DynamicToolCallParams | undefined;
    const reg = server.register({
      catalog,
      dispatchToolCall: async (params) => {
        seen = params;
        return makeResponse("client-ok");
      }
    });
    const client = new ToolRpcClient({ socketPath: reg.socketPath, token: reg.token });
    const tools = await client.list();
    expect(tools.map((t) => t.name)).toEqual(["draw_arrow"]);
    const response = await client.call({
      threadId: "",
      turnId: "",
      callId: "c1",
      namespace: "library",
      tool: "draw_arrow",
      arguments: { capture_id: "cap-9" }
    } as unknown as DynamicToolCallParams);
    expect(seen?.tool).toBe("draw_arrow");
    expect(response.success).toBe(true);
  });

  test("ToolRpcClient.list rejects on a bad token", async () => {
    const { ToolRpcClient } = await import("../pwrsnap-tool-rpc-client");
    const reg = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    const client = new ToolRpcClient({ socketPath: reg.socketPath, token: "wrong" });
    await expect(client.list()).rejects.toThrow(/unauthorized/);
  });

  test("a surface's token cannot reach another surface's tools (isolation)", async () => {
    const sizzleCatalog: DynamicToolSpec[] = [
      {
        name: "sizzle_only",
        description: "Sizzle tool",
        parameters: { type: "object", properties: {} }
      } as unknown as DynamicToolSpec
    ];
    let libraryDispatched = false;
    const library = server.register({
      catalog,
      dispatchToolCall: async () => {
        libraryDispatched = true;
        return makeResponse();
      }
    });
    const sizzle = server.register({
      catalog: sizzleCatalog,
      dispatchToolCall: async () => makeResponse()
    });
    // The Sizzle token lists ONLY the Sizzle catalog, never Library's.
    const list = (await rpc(sizzle.socketPath, { token: sizzle.token, op: "list" })) as {
      tools: DynamicToolSpec[];
    };
    expect(list.tools.map((t) => t.name)).toEqual(["sizzle_only"]);
    // A call on the Sizzle token routes to the Sizzle dispatch, never Library's.
    await rpc(sizzle.socketPath, {
      token: sizzle.token,
      op: "call",
      call: { tool: "draw_arrow", namespace: "library", arguments: {} }
    });
    expect(libraryDispatched).toBe(false);
    library.unregister();
    sizzle.unregister();
  });

  test("an unauthorized token never reaches dispatchToolCall", async () => {
    let dispatched = false;
    const { socketPath } = server.register({
      catalog,
      dispatchToolCall: async () => {
        dispatched = true;
        return makeResponse();
      }
    });
    const res = (await rpc(socketPath, {
      token: "bad",
      op: "call",
      call: { tool: "draw_arrow", namespace: "library", arguments: {} }
    })) as { ok: boolean; error: string };
    expect(res).toEqual({ ok: false, error: "unauthorized" });
    expect(dispatched).toBe(false);
  });

  test("rejects an oversize line (DoS cap)", async () => {
    const { socketPath, token } = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    const huge = "x".repeat(300 * 1024); // > 256KB, no newline
    const res = await new Promise<unknown>((resolve, reject) => {
      const socket = connect(socketPath, () =>
        socket.write(JSON.stringify({ token, op: "call", pad: huge }))
      );
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          socket.end();
          resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        }
      });
      socket.on("error", reject);
    });
    expect(res).toMatchObject({ ok: false, error: "request too large" });
  });

  test("stop() is idempotent and safe before start", async () => {
    const fresh = new PwrSnapToolRpcServer();
    await expect(fresh.stop()).resolves.toBeUndefined(); // never started
    await fresh.start(dir);
    await expect(fresh.stop()).resolves.toBeUndefined();
    await expect(fresh.stop()).resolves.toBeUndefined(); // double stop
  });

  test("rejects malformed JSON", async () => {
    const { socketPath } = server.register({
      catalog,
      dispatchToolCall: async () => makeResponse()
    });
    const res = await new Promise<unknown>((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write("{not json\n"));
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          socket.end();
          resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n"))));
        }
      });
      socket.on("error", reject);
    });
    expect(res).toMatchObject({ ok: false, error: "malformed request" });
  });
});
