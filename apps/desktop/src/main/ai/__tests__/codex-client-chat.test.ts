import { describe, expect, it } from "vitest";
import type { JsonRpcTransport } from "../../codex-app-server/json-rpc";
import { CodexAppServerClient } from "../codex-client";
import type { ChatApprovalDecision } from "@pwrsnap/shared";

type Envelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

const THREAD_ID = "thread-chat-1";
const TURN_ID = "turn-chat-1";

/**
 * Transport that auto-replies to client→server REQUESTS with canned
 * results but never auto-emits turn notifications — the test drives
 * deltas, tool calls, and approval requests manually via `push`.
 */
class ChatTransport implements JsonRpcTransport {
  readonly outbound: Envelope[] = [];
  private messageHandler: (message: string) => void = () => undefined;

  async connect(): Promise<void> {
    return;
  }
  async close(): Promise<void> {
    return;
  }
  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }
  setCloseHandler(): void {
    return;
  }

  send(message: string): void {
    const envelope = JSON.parse(message) as Envelope;
    this.outbound.push(envelope);
    // Only client→server requests (method + id) get a canned reply;
    // client REPLIES to server requests (id + result, no method) are
    // just recorded.
    if (envelope.id === undefined || envelope.method === undefined) return;
    if (envelope.method === "initialize") {
      this.reply(envelope.id, {
        userAgent: "codex-test",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "macos"
      });
      return;
    }
    if (envelope.method === "thread/start") {
      this.reply(envelope.id, { thread: { id: THREAD_ID }, model: "gpt-test" });
      return;
    }
    if (envelope.method === "turn/start") {
      this.reply(envelope.id, { turn: { id: TURN_ID, status: "inProgress" } });
      return;
    }
    if (envelope.method === "thread/archive" || envelope.method === "turn/interrupt") {
      this.reply(envelope.id, {});
    }
  }

  /** Push a server→client message (notification or server request). */
  push(envelope: Envelope): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", ...envelope }));
  }

  private reply(id: string | number, result: unknown): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  /** Most recent reply this client sent for a server request id. */
  replyFor(id: string): Envelope | undefined {
    return [...this.outbound].reverse().find((e) => e.id === id && e.method === undefined);
  }
}

function makeClient(transport: ChatTransport): CodexAppServerClient {
  return new CodexAppServerClient({
    command: "/bin/codex",
    transportFactory: () => transport
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function startSession(
  client: CodexAppServerClient,
  overrides: {
    onToolCall?: (call: import("../codex-client").ChatToolDispatch) => Promise<{
      contentItems: Array<{ type: "inputText"; text: string }>;
      success: boolean;
    }>;
    onApprovalRequest?: (
      turnId: string,
      ask: import("../codex-client").ChatApprovalAsk
    ) => Promise<ChatApprovalDecision>;
  } = {}
): Promise<{ sessionId: string; threadId: string }> {
  return client.startChatSession({
    sessionId: "sess-1",
    cwd: "/tmp/scratch",
    dynamicTools: [],
    onToolCall:
      overrides.onToolCall ??
      (async () => ({ contentItems: [{ type: "inputText", text: "ok" }], success: true })),
    onApprovalRequest: overrides.onApprovalRequest ?? (async () => "decline")
  });
}

describe("CodexAppServerClient chat sessions", () => {
  it("starts a session and sends thread/start with cwd + workspace-write sandbox", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    const { sessionId, threadId } = await startSession(client);
    expect(sessionId).toBe("sess-1");
    expect(threadId).toBe(THREAD_ID);
    const threadStart = transport.outbound.find((e) => e.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      cwd: "/tmp/scratch",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    });
  });

  it("streams deltas and settles the turn with the accumulated finalMessage", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    await startSession(client);

    const deltas: string[] = [];
    let completion: { status: string; finalMessage: string } | null = null;
    const { turnId } = await client.startChatTurn({
      sessionId: "sess-1",
      input: [{ type: "text", text: "hello" }],
      signal: new AbortController().signal,
      onDelta: (_itemId, delta) => deltas.push(delta),
      onComplete: (r) => {
        completion = { status: r.status, finalMessage: r.finalMessage };
      }
    });
    expect(turnId).toBe(TURN_ID);

    transport.push({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta: "Hel" }
    });
    transport.push({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "msg-1", delta: "lo!" }
    });
    transport.push({
      method: "turn/completed",
      params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed", error: null } }
    });
    await tick();

    expect(deltas).toEqual(["Hel", "lo!"]);
    expect(completion).toEqual({ status: "ok", finalMessage: "Hello!" });
  });

  it("routes a dynamic tool call to onToolCall and replies with its result", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    const seen: Array<{ tool: string; turnId: string; args: unknown }> = [];
    await startSession(client, {
      onToolCall: async (call) => {
        seen.push({ tool: call.tool, turnId: call.turnId, args: call.arguments });
        return { contentItems: [{ type: "inputText", text: '{"rows":[]}' }], success: true };
      }
    });

    transport.push({
      id: "srv-1",
      method: "item/tool/call",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: "call-1",
        namespace: "pwrsnap_sizzle",
        tool: "library_search",
        arguments: { query: "telegram" }
      }
    });
    await tick();

    expect(seen).toEqual([
      { tool: "library_search", turnId: TURN_ID, args: { query: "telegram" } }
    ]);
    const reply = transport.replyFor("srv-1");
    expect(reply?.result).toEqual({
      contentItems: [{ type: "inputText", text: '{"rows":[]}' }],
      success: true
    });
  });

  it("relays a command approval and maps approve → accept", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    let askedCommand: string | null = null;
    await startSession(client, {
      onApprovalRequest: async (_turnId, ask) => {
        askedCommand = ask.command;
        return "approve";
      }
    });

    transport.push({
      id: "srv-2",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "item-1",
        command: "curl https://example.com",
        reason: "needs network"
      }
    });
    await tick();

    expect(askedCommand).toBe("curl https://example.com");
    expect(transport.replyFor("srv-2")?.result).toEqual({ decision: "accept" });
  });

  it("aborting the turn sends turn/interrupt for that turn", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    await startSession(client);
    const abort = new AbortController();
    await client.startChatTurn({
      sessionId: "sess-1",
      input: [{ type: "text", text: "hi" }],
      signal: abort.signal,
      onDelta: () => undefined,
      onComplete: () => undefined
    });
    abort.abort();
    await tick();
    const interrupt = transport.outbound.find((e) => e.method === "turn/interrupt");
    expect(interrupt?.params).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID });
  });

  it("declines a dynamic tool call on an unknown thread (enrichment fallback)", async () => {
    const transport = new ChatTransport();
    const client = makeClient(transport);
    await startSession(client);
    transport.push({
      id: "srv-3",
      method: "item/tool/call",
      params: {
        threadId: "some-other-thread",
        turnId: "t",
        callId: "c",
        namespace: null,
        tool: "library_search",
        arguments: {}
      }
    });
    await tick();
    const reply = transport.replyFor("srv-3") as { result: { success: boolean } } | undefined;
    expect(reply?.result.success).toBe(false);
  });
});
