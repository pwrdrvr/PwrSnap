import fc from "fast-check";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
vi.mock("electron", () => ({ app: {} }));
import { McpByteTransport } from "../native-mcp-bridge";

const initialize = { jsonrpc: "2.0", id: 0, method: "initialize" } as const;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("any byte partition preserves the same MCP envelopes, Unicode and extension metadata", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.jsonValue(), { maxLength: 15 }),
    fc.array(fc.integer({ min: 1, max: 127 }), { minLength: 1, maxLength: 20 }),
    async (values, sizes) => {
      const messages = [initialize, ...values.map((value, id) => ({
        jsonrpc: "2.0", id: id + 1, result: value,
        _meta: { approval: value }, extension: "🦀é漢字"
      }))];
      const received: JSONRPCMessage[] = [];
      const written: Buffer[] = [];
      const transport = new McpByteTransport((bytes) => written.push(bytes), () => undefined);
      transport.onmessage = (message) => received.push(message);
      await transport.start();
      const bytes = Buffer.from(messages.map((message) => JSON.stringify(message) + "\n").join(""));
      // JSON.stringify canonicalizes numbers such as -0 before the host sends
      // them. Compare decoded envelopes to the wire, not pre-encoding JS values.
      const wireMessages = bytes.toString().trimEnd().split("\n")
        .map((line) => JSON.parse(line) as JSONRPCMessage);
      try {
        let offset = 0;
        for (let i = 0; offset < bytes.length; i++) {
          const end = offset + sizes[i % sizes.length];
          transport.receive(bytes.subarray(offset, end));
          offset = end;
        }
        await flush();
        expect(received).toEqual(wireMessages);
        for (const message of received) await transport.send(message);
        // Independent wire oracle: the host gets the original UTF-8 JSON lines.
        expect(Buffer.concat(written)).toEqual(bytes);
      } finally { await transport.close(); }
    }
  ), { examples: [[[-0], [1]]] });
});

test("the per-message limit is invariant under coalescing several legal frames", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 530_000, max: 600_000 }),
    fc.boolean(),
    async (length, coalesced) => {
      const messages = [initialize, ...[1, 2].map((id) => ({
        jsonrpc: "2.0", id, result: "x".repeat(length)
      }))];
      const received: JSONRPCMessage[] = [];
      const transport = new McpByteTransport(() => undefined, () => undefined);
      transport.onmessage = (message) => received.push(message);
      await transport.start();
      try {
        const lines = messages.map((message) => Buffer.from(JSON.stringify(message) + "\n"));
        if (coalesced) transport.receive(Buffer.concat(lines));
        else for (const line of lines) transport.receive(line);
        await flush();
        expect(transport.controller.signal.aborted).toBe(false);
        expect(received).toEqual(messages);
      } finally { await transport.close(); }
    }
  ), { numRuns: 20 });
});

test("coalesced 530000-byte results remain independent legal frames", async () => {
  const received: JSONRPCMessage[] = [];
  const transport = new McpByteTransport(() => undefined, () => undefined);
  transport.onmessage = (message) => received.push(message);
  await transport.start();
  const messages = [initialize, { jsonrpc: "2.0", id: 1, result: "x".repeat(530_000) },
    { jsonrpc: "2.0", id: 2, result: "x".repeat(530_000) }];
  transport.receive(Buffer.from(messages.map((message) => JSON.stringify(message) + "\n").join("")));
  await flush();
  expect(received).toHaveLength(messages.length);
  expect(received).toEqual(messages);
  await transport.close();
});
