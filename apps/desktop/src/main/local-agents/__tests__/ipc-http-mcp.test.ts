import { Server } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
vi.mock("electron", () => ({ app: {} }));
import { NativeIpcStream } from "../../ai/mcp/native-mcp-bridge";
import { IpcHttpMcp, type IpcHttpTransport } from "../ipc-http-mcp";

const services: IpcHttpMcp[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "fixture", version: "1" },
    _meta: { approval: { policy: "native" } },
    extension: { kept: true }
  },
  extension: "kept"
};
function peer(service: IpcHttpMcp) {
  const output: string[] = [];
  const closed = vi.fn();
  const stream = new NativeIpcStream((bytes) => output.push(bytes.toString()), closed);
  service.accept(stream);
  return { stream, output, closed };
}
function send(
  stream: NativeIpcStream,
  token: string,
  body?: unknown,
  id?: string,
  method = "POST",
  extra = ""
) {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  stream.receive(
    Buffer.from(
      `${method} /mcp HTTP/1.1\r\nHost: local\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${Buffer.byteLength(bytes)}\r\n${id ? `Mcp-Session-Id: ${id}\r\nMcp-Protocol-Version: 2025-11-25\r\n` : ""}${extra}\r\n${bytes}`
    )
  );
}
test("HTTP framing preserves bidirectional requests, notifications, cancellation, metadata and extension fields without any listen call", async () => {
  const listen = vi.spyOn(Server.prototype, "listen");
  const messages: JSONRPCMessage[] = [];
  let transport: IpcHttpTransport | undefined;
  const service = new IpcHttpMcp(async (input) => {
    transport = input;
    input.onmessage = (message) => {
      messages.push(message);
      if ("method" in message && message.method === "initialize")
        void input.send({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            serverInfo: { name: "Fixture", version: "1" },
            _meta: { desktop: true }
          }
        });
    };
    await input.start();
  });
  services.push(service);
  const { token } = await service.bootstrap(new AbortController().signal);
  const post = peer(service);
  send(post.stream, token, initialize);
  await vi.waitFor(() => expect(post.output.join("")).toContain('"serverInfo"'));
  expect(messages[0]).toEqual(initialize);
  const id = transport!.sessionId!;
  const cancelled = {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7, reason: "user", _meta: { preserved: true } },
    extension: "kept"
  };
  send(post.stream, token, cancelled, id);
  await vi.waitFor(() => expect(messages).toContainEqual(cancelled));
  const sse = peer(service);
  send(sse.stream, token, undefined, id, "GET");
  const outgoing = {
    jsonrpc: "2.0",
    id: "server-approval",
    method: "elicitation/create",
    params: {
      message: "Approve?",
      requestedSchema: { type: "object" },
      _meta: { approval: { requested: true } },
      extension: 7
    }
  };
  await vi.waitFor(async () => {
    await transport!.send(outgoing as JSONRPCMessage);
    expect(sse.output.join("")).toContain('"server-approval"');
  });
  const data = sse.output
    .join("")
    .split("\n")
    .find((line) => line.startsWith("data: "))!;
  expect(JSON.parse(data.slice(6))).toEqual(outgoing);
  const response = {
    jsonrpc: "2.0",
    id: "server-approval",
    result: { action: "accept", _meta: { native: true }, extension: 8 },
    extension: "kept"
  };
  send(post.stream, token, response, id);
  await vi.waitFor(() => expect(messages).toContainEqual(response));
  expect(listen).not.toHaveBeenCalled();
  sse.stream.destroy();
  await vi.waitFor(() => expect(transport!.controller.signal.aborted).toBe(true));
  expect(post.closed).toHaveBeenCalledOnce();
});
test("unused bootstrap expires, abandoned consent is cancelled, and desktop shutdown invalidates credentials", async () => {
  vi.useFakeTimers();
  const transports: IpcHttpTransport[] = [];
  const service = new IpcHttpMcp(async (transport) => {
    transports.push(transport);
  });
  services.push(service);
  await service.bootstrap(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(transports[0].controller.signal.aborted).toBe(true);
  const controller = new AbortController();
  await service.bootstrap(controller.signal);
  controller.abort();
  expect(transports[1].controller.signal.aborted).toBe(true);
  await service.close();
  await expect(service.bootstrap(new AbortController().signal)).rejects.toThrow("disconnected");
});
test("simultaneous initializations consume one credential once and cannot swap Sessions on an established connection", async () => {
  const initialized: JSONRPCMessage[] = [];
  const transports: IpcHttpTransport[] = [];
  const service = new IpcHttpMcp(async (transport) => {
    transports.push(transport);
    transport.onmessage = (message) => {
      initialized.push(message);
      void transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    };
    await transport.start();
  });
  services.push(service);
  const { token } = await service.bootstrap(new AbortController().signal);
  const first = peer(service);
  const duplicate = peer(service);
  send(first.stream, token, initialize);
  send(duplicate.stream, token, initialize);
  await vi.waitFor(() => {
    expect(initialized).toHaveLength(1);
    expect(first.output.join("")).toContain("200 OK");
    expect(duplicate.output.join("")).toMatch(/40[49] /);
  });
  const other = await service.bootstrap(new AbortController().signal);
  const second = peer(service);
  send(second.stream, other.token, initialize);
  await vi.waitFor(() => expect(second.output.join("")).toContain("200 OK"));
  send(
    first.stream,
    other.token,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    transports[1].sessionId
  );
  await vi.waitFor(() => expect(first.output.join("")).toContain("403 Forbidden"));
  expect(initialized).toHaveLength(2);
});
test("fragmented HTTP headers have an absolute deadline and oversized headers close the byte transport", async () => {
  vi.useFakeTimers();
  const service = new IpcHttpMcp(async () => undefined);
  services.push(service);
  const stalled = peer(service);
  stalled.stream.receive(Buffer.from("POST /mcp HTTP/1.1\r\nHost: "));
  await vi.advanceTimersByTimeAsync(9000);
  stalled.stream.receive(Buffer.from("loc"));
  await vi.advanceTimersByTimeAsync(1001);
  expect(stalled.stream.destroyed).toBe(true);
  expect(stalled.closed).toHaveBeenCalledOnce();
  const large = peer(service);
  large.stream.receive(
    Buffer.from(`POST /mcp HTTP/1.1\r\nX-Large: ${"a".repeat(17 * 1024)}\r\n\r\n`)
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(large.stream.destroyed).toBe(true);
  expect(large.closed).toHaveBeenCalledOnce();
});
