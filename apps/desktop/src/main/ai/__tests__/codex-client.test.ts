import type { JsonRpcTransport } from "../../codex-app-server/json-rpc";
import { CodexAppServerClient } from "../codex-client";
import { describe, expect, it } from "vitest";

type Envelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

class FakeTransport implements JsonRpcTransport {
  readonly outbound: Envelope[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  async connect(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    return;
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  send(message: string): void {
    const envelope = JSON.parse(message) as Envelope;
    this.outbound.push(envelope);
    this.respond(envelope);
  }

  closeWithError(error: Error): void {
    this.closeHandler(error);
  }

  private respond(envelope: Envelope): void {
    const id = envelope.id;
    if (id === undefined) {
      return;
    }

    if (envelope.method === "initialize") {
      this.emit({ id, result: { userAgent: "codex-test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
      return;
    }

    if (envelope.method === "thread/start") {
      this.emit({
        id,
        result: {
          thread: {
            id: "thread-1",
            forkedFromId: null,
            preview: "",
            ephemeral: true,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: "running",
            path: null,
            cwd: "/tmp",
            cliVersion: "test",
            source: "codex_app_server",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: []
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/tmp",
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "auto",
          sandbox: { mode: "read-only" },
          reasoningEffort: "low"
        }
      });
      return;
    }

    if (envelope.method === "turn/start") {
      this.emit({
        id,
        result: {
          turn: {
            id: "turn-1",
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 0,
            completedAt: null,
            durationMs: null
          }
        }
      });
      setTimeout(() => {
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "message-1",
              text: JSON.stringify({
                ocrText: "Visible text",
                description: "A screenshot with visible text.",
                tags: [{ label: "text", confidence: 0.8 }]
              }),
              phase: null,
              memoryCitation: null
            }
          }
        });
        this.emit({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              items: [],
              status: "completed",
              error: null,
              startedAt: 0,
              completedAt: 1,
              durationMs: 1000
            }
          }
        });
      });
      return;
    }

    if (envelope.method === "thread/archive" || envelope.method === "turn/interrupt") {
      this.emit({ id, result: {} });
    }
  }

  private emit(envelope: Envelope): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", ...envelope }));
  }
}

describe("CodexAppServerClient", () => {
  it("starts an ephemeral local-image turn and parses structured output", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      transportFactory: () => transport,
      turnTimeoutMs: 1000
    });

    const response = await client.enrichCapture({ imagePath: "/tmp/capture.jpg" });

    expect(response.result).toEqual({
      ocrText: "Visible text",
      description: "A screenshot with visible text.",
      tags: [{ label: "text", confidence: 0.8 }]
    });
    expect(transport.outbound.map((message) => message.method)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
      "thread/archive"
    ]);
    expect(transport.outbound.find((message) => message.method === "thread/start")?.params).toMatchObject({
      ephemeral: true,
      approvalPolicy: "never",
      baseInstructions: expect.stringContaining("Primary goals, in order:")
    });
    expect(transport.outbound.find((message) => message.method === "turn/start")?.params).toMatchObject({
      input: expect.arrayContaining([{ type: "localImage", path: "/tmp/capture.jpg" }])
    });
  });
});
