import fc from "fast-check";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpByteTransport } from "../native-mcp-bridge";

const discovery = {
  jsonrpc: "2.0", id: "discover", method: "server/discover", params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "Fixture", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
} as const;

test("the default internal admission gate still rejects modern openings without invoking approval", async () => {
  const approve = vi.fn();
  const received = vi.fn();
  const disconnected = vi.fn();
  const transport = new McpByteTransport(() => undefined, disconnected, approve);
  transport.onmessage = received;
  await transport.start();
  transport.receive(Buffer.from(JSON.stringify(discovery) + "\n"));
  expect(disconnected).toHaveBeenCalledOnce();
  expect(received).not.toHaveBeenCalled();
  expect(approve).not.toHaveBeenCalled();
});

test("the modern gate preserves queued messages and admits protected requests only after approval", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 20 }), async (payloads) => {
    let open!: () => void;
    let reached!: () => void;
    let complete!: () => void;
    const approval = new Promise<void>((resolve) => { open = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const delivered = new Promise<void>((resolve) => { complete = resolve; });
    const messages = [discovery, ...payloads.map((payload, index) => ({
      jsonrpc: "2.0" as const, id: index, method: "skills/list",
      params: { _meta: discovery.params._meta, extension: { payload } }
    }))];
    const received: JSONRPCMessage[] = [];
    const transport = new McpByteTransport(() => undefined, () => undefined, async (message) => {
      if ("method" in message && message.method === "server/discover") return;
      reached();
      await approval;
    }, true);
    transport.onmessage = (message) => {
      received.push(message);
      if (received.length === messages.length) complete();
    };
    await transport.start();
    transport.receive(Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"));
    await waiting;
    expect(received).toEqual([discovery]);
    open();
    await delivered;
    expect(received).toEqual(messages);
    await transport.close();
  }), { numRuns: 50 });
});
