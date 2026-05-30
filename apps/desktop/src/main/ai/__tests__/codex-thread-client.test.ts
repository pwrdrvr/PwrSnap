import type {
  DynamicToolCallParams,
  DynamicToolCallResponse
} from "@pwrsnap/codex-app-server-protocol/v2";
import type { JsonRpcTransport } from "../../codex-app-server/json-rpc";
import {
  CodexThreadClient,
  type CodexAgentMessageDeltaEvent
} from "../codex-thread-client";
import { describe, expect, it } from "vitest";

type Envelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

/**
 * In-memory JsonRpcTransport. `send` records every outbound envelope and
 * synthesizes a response for requests; tests reach in via {@link outbound} and
 * the `emit*` helpers to drive notifications / server-requests.
 */
class FakeTransport implements JsonRpcTransport {
  readonly outbound: Envelope[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private threadCounter = 0;
  private turnCounter = 0;

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
    this.respond(envelope);
  }

  /** Emit a JSON-RPC server-request and resolve with the client's response. */
  async emitServerRequest(method: string, params: unknown): Promise<Envelope> {
    const id = `srv-${this.outbound.length}-${method}`;
    const replied = new Promise<Envelope>((resolve) => {
      const baseline = this.outbound.length;
      const poll = (): void => {
        const reply = this.outbound
          .slice(baseline)
          .find((envelope) => envelope.id === id);
        if (reply) {
          resolve(reply);
          return;
        }
        setTimeout(poll, 1);
      };
      poll();
    });
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return replied;
  }

  /** Emit a fire-and-forget notification. */
  emitNotification(method: string, params: unknown): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private respond(envelope: Envelope): void {
    const id = envelope.id;
    if (id === undefined) {
      return;
    }

    if (envelope.method === "initialize") {
      this.emit({
        id,
        result: {
          userAgent: "codex-test",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "macos"
        }
      });
      return;
    }

    if (envelope.method === "thread/start") {
      this.threadCounter += 1;
      this.emit({
        id,
        result: {
          thread: {
            id: `thread-${this.threadCounter}`,
            items: [],
            turns: []
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/tmp",
          runtimeWorkspaceRoots: [],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "auto",
          sandbox: { mode: "read-only" },
          activePermissionProfile: null,
          reasoningEffort: "low"
        }
      });
      return;
    }

    if (envelope.method === "turn/start") {
      this.turnCounter += 1;
      const threadId = (envelope.params as { threadId?: string }).threadId ?? "thread-?";
      this.emit({
        id,
        result: {
          turn: {
            id: `${threadId}-turn-${this.turnCounter}`,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 0,
            completedAt: null,
            durationMs: null
          }
        }
      });
      return;
    }

    if (
      envelope.method === "thread/archive" ||
      envelope.method === "turn/interrupt" ||
      envelope.method === "thread/metadata/update"
    ) {
      this.emit({ id, result: {} });
    }
  }

  private emit(envelope: Envelope): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", ...envelope }));
  }
}

describe("CodexThreadClient", () => {
  it("starts multiple threads on one connection without cross-wiring turn deltas", async () => {
    const transport = new FakeTransport();
    const client = new CodexThreadClient({
      command: "/bin/codex",
      transportFactory: () => transport
    });

    const { threadId: threadA } = await client.startThread();
    const { threadId: threadB } = await client.startThread();
    expect(threadA).toBe("thread-1");
    expect(threadB).toBe("thread-2");
    expect(threadA).not.toBe(threadB);

    // initialize must have been sent exactly once across both startThread calls.
    expect(transport.outbound.filter((envelope) => envelope.method === "initialize")).toHaveLength(
      1
    );

    const { turnId: turnA } = await client.startTurn({
      threadId: threadA,
      input: [{ type: "text", text: "hi A", text_elements: [] }]
    });
    const { turnId: turnB } = await client.startTurn({
      threadId: threadB,
      input: [{ type: "text", text: "hi B", text_elements: [] }]
    });

    const deltas: CodexAgentMessageDeltaEvent[] = [];
    client.onAgentMessageDelta((event) => deltas.push(event));

    transport.emitNotification("item/agentMessage/delta", {
      threadId: threadA,
      turnId: turnA,
      itemId: "item-a",
      delta: "alpha"
    });
    transport.emitNotification("item/agentMessage/delta", {
      threadId: threadB,
      turnId: turnB,
      itemId: "item-b",
      delta: "beta"
    });

    // JsonRpcConnection.handleMessage processes notifications on a microtask;
    // let the queue drain before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(deltas).toEqual([
      { threadId: threadA, turnId: turnA, itemId: "item-a", delta: "alpha" },
      { threadId: threadB, turnId: turnB, itemId: "item-b", delta: "beta" }
    ]);

    // Each delta carries its originating threadId, so a controller filtering by
    // thread sees only the deltas for the thread it cares about.
    const aOnly = deltas.filter((event) => event.threadId === threadA);
    expect(aOnly).toEqual([
      { threadId: threadA, turnId: turnA, itemId: "item-a", delta: "alpha" }
    ]);
  });

  it("routes an item/tool/call ServerRequest to the registered handler and returns its response", async () => {
    const transport = new FakeTransport();
    const client = new CodexThreadClient({
      command: "/bin/codex",
      transportFactory: () => transport
    });
    await client.startThread();

    const seen: DynamicToolCallParams[] = [];
    const expectedResponse: DynamicToolCallResponse = {
      contentItems: [{ type: "inputText", text: "tool result" }],
      success: true
    };
    client.onToolCall(async (params) => {
      seen.push(params);
      return expectedResponse;
    });

    const toolCallParams: DynamicToolCallParams = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "library_search",
      arguments: { query: "logo" }
    };
    const reply = await transport.emitServerRequest("item/tool/call", toolCallParams);

    expect(seen).toEqual([toolCallParams]);
    expect(reply.result).toEqual(expectedResponse);
  });

  it("passes dynamicTools through to the thread/start params", async () => {
    const transport = new FakeTransport();
    const client = new CodexThreadClient({
      command: "/bin/codex",
      transportFactory: () => transport
    });

    const dynamicTools = [
      {
        name: "library_search",
        description: "Search the snap library",
        inputSchema: { type: "object", properties: { query: { type: "string" } } }
      }
    ];
    await client.startThread({
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "Be a helpful PwrSnap chat assistant.",
      cwd: "/tmp/pwrsnap-chat",
      runtimeWorkspaceRoots: ["/tmp/pwrsnap-chat"],
      serviceName: "pwrsnap",
      dynamicTools
    });

    const threadStart = transport.outbound.find((envelope) => envelope.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "Be a helpful PwrSnap chat assistant.",
      cwd: "/tmp/pwrsnap-chat",
      runtimeWorkspaceRoots: ["/tmp/pwrsnap-chat"],
      serviceName: "pwrsnap",
      dynamicTools
    });
  });

  it("can clear Git metadata from a started thread", async () => {
    const transport = new FakeTransport();
    const client = new CodexThreadClient({
      command: "/bin/codex",
      transportFactory: () => transport
    });

    await client.clearThreadGitInfo("thread-1");

    const metadataUpdate = transport.outbound.find(
      (envelope) => envelope.method === "thread/metadata/update"
    );
    expect(metadataUpdate?.params).toEqual({
      threadId: "thread-1",
      gitInfo: { sha: null, branch: null, originUrl: null }
    });
  });
});
