import { once } from "node:events";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
vi.mock("electron", () => ({ app: { getVersion: () => "fixture" } }));
import { McpByteTransport } from "../native-mcp-bridge";
import { McpSessionPool } from "../mcp-session-pool";
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "fixture", version: "1" },
    _meta: { approval: { policy: "ask" } },
    extension: { kept: true }
  },
  extension: "kept"
};
test("MCP requests, notifications, cancellation, elicitation, approval metadata and extension fields survive both directions", async () => {
  const down: Buffer[] = [];
  const up: JSONRPCMessage[] = [];
  const transport = new McpByteTransport(
    (bytes) => down.push(bytes),
    () => undefined
  );
  transport.onmessage = (message) => up.push(message);
  await transport.start();
  const messages = [
    initialize,
    {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "fixture", _meta: { x: true } }
    },
    {
      jsonrpc: "2.0",
      id: "server-request",
      result: { action: "accept", _meta: { consent: "fixture" } },
      extension: 7
    }
  ];
  for (const message of messages) {
    const bytes = Buffer.from(JSON.stringify(message) + "\n");
    transport.receive(bytes.subarray(0, 5));
    transport.receive(bytes.subarray(5));
  }
  await vi.waitFor(() => expect(up).toEqual(messages));
  const outgoing = {
    jsonrpc: "2.0",
    id: "server-request",
    method: "elicitation/create",
    params: {
      message: "Approve?",
      requestedSchema: { type: "object" },
      _meta: { policy: "native" }
    },
    extension: "kept"
  };
  await transport.send(outgoing as JSONRPCMessage);
  expect(JSON.parse(Buffer.concat(down).toString())).toEqual(outgoing);
  await transport.close();
});
test("closed or overflowed stdio tears down the underlying IPC and server exactly once", async () => {
  for (const overflow of [true, false]) {
    const disconnect = vi.fn();
    const onclose = vi.fn();
    const transport = new McpByteTransport(() => {
      throw new Error("stdout closed");
    }, disconnect);
    transport.onclose = onclose;
    await transport.start();
    if (overflow) transport.receive(Buffer.alloc(1024 * 1024 + 1, 120));
    else
      await expect(transport.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toThrow(
        "stdout closed"
      );
    await transport.close();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
    expect(transport.controller.signal.aborted).toBe(true);
    await expect(transport.send({ jsonrpc: "2.0", id: 2, result: {} })).rejects.toThrow(
      "manually reconnect"
    );
  }
});
test("idle revoked connections are reclaimed before the cap and concurrent replacement admissions share cleanup", async () => {
  type Session = { valid: boolean; closed: boolean };
  const close = vi.fn(async (session: Session) => {
    await Promise.resolve();
    session.closed = true;
  });
  const pool = new McpSessionPool<Session>(
    2,
    async (session) => {
      await Promise.resolve();
      return session.valid;
    },
    close
  );
  const revoked = { valid: true, closed: false };
  const retained = { valid: true, closed: false };
  expect(await pool.admit(1, revoked)).toBe(true);
  expect(await pool.admit(2, retained)).toBe(true);
  revoked.valid = false;
  const a = { valid: true, closed: false };
  const b = { valid: true, closed: false };
  expect(await Promise.all([pool.admit(3, a), pool.admit(4, b)])).toEqual([true, false]);
  expect(revoked.closed).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(pool.values()).toEqual([retained, a]);
  await pool.clear();
  expect(close).toHaveBeenCalledTimes(3);
});

test("an overflow closes the real native IPC stream and its desktop transport resources", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { connect } = await import("node:net");
  const { NativeMcpBridge } = await import("../native-mcp-bridge");
  const dir = mkdtempSync(join(tmpdir(), "ps-overflow-"));
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\ps-overflow-${Date.now()}` : join(dir, "m.sock");
  const executable = fileURLToPath(
    new URL(
      "../../../../../build/mcp/" +
        (process.platform === "win32" ? "pwrsnap-mcp.exe" : "pwrsnap-mcp"),
      import.meta.url
    )
  );
  const reclaimed = vi.fn();
  const bridge = new NativeMcpBridge({
    endpoint,
    executable,
    onConnection: ({ createTransport }) => {
      const transport = createTransport();
      transport.onclose = reclaimed;
      void transport.start();
    }
  });
  await bridge.start();
  const peer = connect(endpoint);
  peer.on("error", () => undefined);
  peer.resume();
  try {
    await once(peer, "connect");
    peer.write("PWRSNAP-MCP/1 0.0.1\n");
    // Give the real native listener time to deliver Open, then fill one
    // unterminated MCP frame. The byte relay never parses or repairs it.
    peer.write(Buffer.alloc(1024 * 1024 + 1, 120));
    await vi.waitFor(() => expect(reclaimed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(peer.destroyed).toBe(true));
    expect(bridge.isRunning()).toBe(true);
  } finally {
    peer.destroy();
    await bridge.stop();
  }
});
