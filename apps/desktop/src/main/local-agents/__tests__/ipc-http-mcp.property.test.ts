import fc from "fast-check";
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
vi.mock("electron", () => ({ app: {} }));
import { NativeIpcStream } from "../../ai/mcp/native-mcp-bridge";
import { IpcHttpMcp, type IpcHttpTransport } from "../ipc-http-mcp";

const initialize = (id: number, extension: unknown): JSONRPCMessage => ({
  jsonrpc: "2.0", id, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "generated", version: "1" }, _meta: { extension }
  }
});
function request(token: string, message: JSONRPCMessage, sessionId?: string): Buffer {
  const bytes = JSON.stringify(message);
  return Buffer.from("POST /mcp HTTP/1.1\r\nHost: local\r\n" +
    "Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n" +
    `Authorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(bytes)}\r\n` +
    (sessionId ? `Mcp-Session-Id: ${sessionId}\r\n` : "") + `\r\n${bytes}`);
}
const settle = async (): Promise<void> => { await setImmediate(); await setImmediate(); };

// Rule: once a socket is authenticated, every later request on it belongs to
// that Session, even if Node emits pipelined requests before body reads settle.
// The real Node HTTP parser, not a permissive request stub, supplies the requests.
test("pipelined HTTP credentials cannot switch a connection's approved identity", async () => {
  await fc.assert(fc.asyncProperty(fc.jsonValue(), fc.boolean(),
    async (metadata, fragmented) => {
      const received: JSONRPCMessage[][] = [];
      const service = new IpcHttpMcp(async (transport) => {
        const messages: JSONRPCMessage[] = [];
        received.push(messages);
        transport.onmessage = (message) => {
          messages.push(message);
          if ("id" in message && message.id !== undefined) void transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
        };
        await transport.start();
      });
      const output: Buffer[] = [];
      const socket = new NativeIpcStream((bytes) => output.push(bytes), () => undefined);
      try {
        const first = await service.bootstrap(new AbortController().signal);
        const second = await service.bootstrap(new AbortController().signal);
        service.accept(socket);
        // The host's JSON encoder canonicalizes JS-only values such as -0.
        const wireMetadata: unknown = JSON.parse(JSON.stringify(metadata));
        const messages = [initialize(1, wireMetadata), initialize(2, wireMetadata)];
        const bytes = Buffer.concat([request(first.token, messages[0]), request(second.token, messages[1])]);
        if (fragmented) {
          // End one chunk inside the first body; both requests still pipeline.
          const split = request(first.token, messages[0]).length - 1;
          socket.receive(bytes.subarray(0, split));
          socket.receive(bytes.subarray(split));
        } else socket.receive(bytes);
        await settle();
        expect(received).toEqual([[messages[0]], []]);
        expect(Buffer.concat(output).toString()).toContain("403 Forbidden");
      } finally { await service.close(); }
    }
  ));
});

test("HTTP pipelined initialize with two credentials dispatches only the first", async () => {
  const received: JSONRPCMessage[] = [];
  const service = new IpcHttpMcp(async (transport) => {
    transport.onmessage = (message) => {
      received.push(message);
      if ("id" in message && message.id !== undefined) void transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
    };
  });
  try {
    const a = await service.bootstrap(new AbortController().signal);
    const b = await service.bootstrap(new AbortController().signal);
    const socket = new NativeIpcStream(() => undefined, () => undefined);
    service.accept(socket);
    socket.receive(Buffer.concat([request(a.token, initialize(1, {})), request(b.token, initialize(2, {}))]));
    await settle();
    expect(received).toEqual([initialize(1, {})]);
  } finally { await service.close(); }
});

test("revoked HTTP credentials never dispatch or resume under generated use/close histories", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("call", "revoke", "disconnect"),
    { minLength: 1, maxLength: 20 }), async (history) => {
    let transport: IpcHttpTransport | undefined;
    const received: JSONRPCMessage[] = [];
    const controller = new AbortController();
    const service = new IpcHttpMcp(async (input) => {
      transport = input;
      input.onmessage = (message) => {
        received.push(message);
        if ("id" in message && message.id !== undefined) void input.send({ jsonrpc: "2.0", id: message.id, result: {} });
      };
    });
    const socket = new NativeIpcStream(() => undefined, () => undefined);
    try {
      const { token } = await service.bootstrap(controller.signal);
      service.accept(socket);
      socket.receive(request(token, initialize(0, {})));
      await settle();
      let live = true;
      let expected = 1;
      for (const [index, operation] of history.entries()) {
        if (operation === "revoke") { controller.abort(); live = false; }
        else if (operation === "disconnect") { socket.destroy(); live = false; }
        else {
          const message = { jsonrpc: "2.0", id: index + 1, method: "tools/list" } as const;
          if (live) { socket.receive(request(token, message, transport!.sessionId)); expected++; }
          else {
            // An explicit new socket with the old credential must not resume.
            const replacement = new NativeIpcStream(() => undefined, () => undefined);
            service.accept(replacement);
            replacement.receive(request(token, message, transport!.sessionId));
          }
        }
        await settle();
        expect(received).toHaveLength(expected);
        expect(transport!.controller.signal.aborted).toBe(!live);
      }
    } finally { await service.close(); }
  }));
});
