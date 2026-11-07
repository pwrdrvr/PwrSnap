import fc from "fast-check";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
vi.mock("electron", () => ({ app: {} }));
import { McpByteTransport } from "../native-mcp-bridge";

// The model describes the consent contract, not the decoder's implementation:
// messages queue until both start and native approval, and closure is terminal.
test("generated consent/start/input/closure histories never dispatch before approval or after closure", async () => {
  await fc.assert(fc.asyncProperty(fc.array(
    fc.constantFrom("start", "initialize", "notify", "approve", "close", "overflow", "send"),
    { minLength: 1, maxLength: 40 }
  ), async (history) => {
    let approve = (): void => undefined;
    const approval = new Promise<void>((resolve) => { approve = resolve; });
    let disconnects = 0;
    let closes = 0;
    const received: JSONRPCMessage[] = [];
    const transport = new McpByteTransport(() => undefined, () => { disconnects++; }, () => approval);
    transport.onmessage = (message) => received.push(message);
    transport.onclose = () => { closes++; };
    const model = { started: false, approved: false, closed: false,
      initialized: false, pending: [] as JSONRPCMessage[], delivered: [] as JSONRPCMessage[] };
    try {
      for (const [id, operation] of history.entries()) {
        if (operation === "start") { model.started = true; await transport.start(); }
        else if (operation === "approve") { model.approved = true; approve(); }
        else if (operation === "close" || operation === "overflow") {
          model.closed = true;
          if (operation === "close") await transport.close();
          else transport.receive(Buffer.alloc(1024 * 1024 + 1, 120));
        } else if (operation === "send") {
          const result = transport.send({ jsonrpc: "2.0", id, result: {} });
          if (model.closed) await expect(result).rejects.toThrow("manually reconnect");
          else await result;
        } else {
          const message = { jsonrpc: "2.0", id, method:
            operation === "initialize" ? "initialize" : "notifications/cancelled" } as const;
          if (!model.closed) model.pending.push(message);
          transport.receive(Buffer.from(JSON.stringify(message) + "\n"));
        }
        if (!model.closed && model.started && model.pending.length > 0) {
          if (!model.initialized && !("method" in model.pending[0] && model.pending[0].method === "initialize"))
            model.closed = true;
          else if (model.approved) {
            model.initialized = true;
            model.delivered.push(...model.pending);
            model.pending = [];
          }
        }
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(received).toEqual(model.delivered);
        expect(transport.controller.signal.aborted).toBe(model.closed);
        expect(disconnects).toBe(model.closed ? 1 : 0);
        expect(closes).toBe(disconnects);
      }
    } finally { approve(); await transport.close(); }
  }));
});
