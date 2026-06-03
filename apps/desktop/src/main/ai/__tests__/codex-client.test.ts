import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcTransport } from "../../codex-app-server/json-rpc";
import { CodexAppServerClient } from "../codex-client";
import { PWRSNAP_CODEX_THREAD_CONFIG } from "../codex-thread-config";
import { afterEach, describe, expect, it } from "vitest";

type Envelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

const tempRoots: string[] = [];

class FakeTransport implements JsonRpcTransport {
  readonly outbound: Envelope[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;
  private turnSeq = 0;

  /** When set, a turn emits an `error` notification (then a failed
   *  turn/completed) instead of the normal success sequence — mirrors
   *  Codex faulting a turn (e.g. an invalid image model). */
  constructor(private readonly turnErrorBlob: string | null = null) {}

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
      const params = envelope.params as {
        cwd?: string | null;
        ephemeral?: boolean | null;
        model?: string | null;
      };
      this.emit({
        id,
        result: {
          thread: {
            id: "thread-1",
            forkedFromId: null,
            preview: "",
            ephemeral: params.ephemeral ?? false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: "running",
            path: null,
            cwd: params.cwd ?? "/tmp",
            cliVersion: "test",
            source: "codex_app_server",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: []
          },
          model: params.model ?? "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: params.cwd ?? "/tmp",
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "auto",
          sandbox: { mode: "read-only" },
          reasoningEffort: "low"
        }
      });
      return;
    }

    if (envelope.method === "thread/metadata/update") {
      this.emit({ id, result: {} });
      return;
    }

    if (envelope.method === "model/list") {
      this.emit({
        id,
        result: {
          data: [
            {
              id: "gpt-5.5",
              model: "gpt-5.5",
              upgrade: null,
              upgradeInfo: null,
              availabilityNux: null,
              displayName: "GPT-5.5",
              description: "Frontier model",
              hidden: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "medium",
              inputModalities: ["text", "image"],
              supportsPersonality: false,
              additionalSpeedTiers: [],
              serviceTiers: [],
              defaultServiceTier: null,
              isDefault: true
            }
          ],
          nextCursor: null
        }
      });
      return;
    }

    if (envelope.method === "turn/start") {
      this.turnSeq += 1;
      const turnId = `turn-${this.turnSeq}`;
      this.emit({
        id,
        result: {
          turn: {
            id: turnId,
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 0,
            completedAt: null,
            durationMs: null
          }
        }
      });
      if (this.turnErrorBlob !== null) {
        setTimeout(() => {
          // Codex faults the turn: an `error` notification carrying the
          // real reason, THEN a failed turn/completed whose own
          // `turn.error` is null (as observed in the wild).
          this.emit({
            method: "error",
            params: {
              threadId: "thread-1",
              turnId,
              willRetry: false,
              error: {
                message: this.turnErrorBlob,
                codexErrorInfo: "other",
                additionalDetails: null
              }
            }
          });
          this.emit({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: {
                id: turnId,
                items: [],
                status: "failed",
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
      setTimeout(() => {
        this.emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId,
            tokenUsage: {
              total: {
                totalTokens: 1200,
                inputTokens: 900,
                cachedInputTokens: 100,
                outputTokens: 300,
                reasoningOutputTokens: 25
              },
              last: {
                totalTokens: 1200,
                inputTokens: 900,
                cachedInputTokens: 100,
                outputTokens: 300,
                reasoningOutputTokens: 25
              },
              modelContextWindow: 400000
            }
          }
        });
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId,
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
              id: turnId,
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

    if (envelope.method === "thread/rollback") {
      this.emit({
        id,
        result: {
          thread: {
            id: "thread-1",
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 0,
            updatedAt: 0,
            status: "running",
            path: "/tmp/thread.jsonl",
            cwd: "/tmp",
            cliVersion: "test",
            source: "codex_app_server",
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: []
          }
        }
      });
      return;
    }

    if (
      envelope.method === "thread/archive" ||
      envelope.method === "thread/name/set" ||
      envelope.method === "turn/interrupt"
    ) {
      this.emit({ id, result: {} });
    }
  }

  private emit(envelope: Envelope): void {
    this.messageHandler(JSON.stringify({ jsonrpc: "2.0", ...envelope }));
  }
}

describe("CodexAppServerClient", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("starts an isolated persistent image turn, rolls it back, and parses structured output", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-codex-client-test-"));
    tempRoots.push(tempRoot);
    const imagePath = join(tempRoot, "capture.jpg");
    const workspaceDir = join(tempRoot, "metadata-worker");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      captureMetadataWorkspaceDir: workspaceDir,
      transportFactory: () => transport,
      turnTimeoutMs: 1000
    });

    const response = await client.enrichCapture({
      imagePaths: [imagePath],
      model: "gpt-5.4-mini",
      metadata: {
        sourceAppName: "PwrSnap",
        sourceAppBundleId: "com.pwrdrvr.pwrsnap",
        captureKind: "image",
        widthPx: 2880,
        heightPx: 1920,
        capturedAt: "2026-05-18T13:30:00.000Z"
      }
    });

    expect(response.result).toEqual({
      ocrText: "Visible text",
      title: "",
      description: "A screenshot with visible text.",
      tags: [{ label: "text", confidence: 0.8 }]
    });
    expect(response).toMatchObject({
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      tokenUsage: {
        last: {
          inputTokens: 900,
          cachedInputTokens: 100,
          outputTokens: 300
        }
      }
    });
    expect(transport.outbound.map((message) => message.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/metadata/update",
      "thread/name/set",
      "turn/start",
      "thread/rollback"
    ]);
    expect(transport.outbound.find((message) => message.method === "thread/start")?.params).toMatchObject({
      model: "gpt-5.4-mini",
      ephemeral: false,
      cwd: workspaceDir,
      runtimeWorkspaceRoots: [workspaceDir],
      serviceName: "pwrsnap",
      approvalPolicy: "never",
      baseInstructions: expect.stringContaining("Primary goals, in order:"),
      config: PWRSNAP_CODEX_THREAD_CONFIG,
      environments: [],
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
    expect(transport.outbound.find((message) => message.method === "thread/metadata/update")?.params).toEqual({
      threadId: "thread-1",
      gitInfo: {
        sha: null,
        branch: null,
        originUrl: null
      }
    });
    expect(transport.outbound.find((message) => message.method === "thread/name/set")?.params).toEqual({
      threadId: "thread-1",
      name: "PwrSnap Capture Metadata Worker"
    });
    const turnStart = transport.outbound.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      model: "gpt-5.4-mini",
      input: expect.arrayContaining([{ type: "localImage", path: imagePath }])
    });
    expect(JSON.stringify(turnStart?.params)).not.toContain("data:image/jpeg;base64");
    expect(JSON.stringify(turnStart?.params)).toContain("Source application name: PwrSnap");
    expect(JSON.stringify(turnStart?.params)).toContain("Dimensions: 2880 x 1920 px");
  });

  it("reuses the isolated persistent enrichment thread across turns", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-codex-client-test-"));
    tempRoots.push(tempRoot);
    const firstPath = join(tempRoot, "capture-1.jpg");
    const secondPath = join(tempRoot, "capture-2.jpg");
    const workspaceDir = join(tempRoot, "metadata-worker");
    await writeFile(firstPath, Buffer.from([1]));
    await writeFile(secondPath, Buffer.from([2]));
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      captureMetadataWorkspaceDir: workspaceDir,
      transportFactory: () => transport,
      turnTimeoutMs: 1000
    });
    const metadata = {
      sourceAppName: "PwrSnap",
      sourceAppBundleId: "com.pwrdrvr.pwrsnap",
      captureKind: "image" as const,
      widthPx: 2880,
      heightPx: 1920,
      capturedAt: "2026-05-18T13:30:00.000Z"
    };

    await client.enrichCapture({ imagePaths: [firstPath], model: "gpt-5.4-mini", metadata });
    await client.enrichCapture({ imagePaths: [secondPath], model: "gpt-5.4-mini", metadata });

    expect(transport.outbound.map((message) => message.method)).toEqual([
      "initialize",
      "thread/start",
      "thread/metadata/update",
      "thread/name/set",
      "turn/start",
      "thread/rollback",
      "turn/start",
      "thread/rollback"
    ]);
    expect(
      transport.outbound.filter((message) => message.method === "turn/start").map((message) => message.params)
    ).toEqual([
      expect.objectContaining({ threadId: "thread-1" }),
      expect.objectContaining({ threadId: "thread-1" })
    ]);
  });

  it("lists available Codex models", async () => {
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      transportFactory: () => transport
    });

    const models = await client.listModels();

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        model: "gpt-5.5",
        displayName: "GPT-5.5",
        inputModalities: ["text", "image"]
      })
    ]);
    expect(transport.outbound.map((message) => message.method)).toEqual([
      "initialize",
      "model/list"
    ]);
  });

  it("sends each sampled video frame as a separate image input", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-codex-client-test-"));
    tempRoots.push(tempRoot);
    const frame1 = join(tempRoot, "frame-1.jpg");
    const frame2 = join(tempRoot, "frame-2.jpg");
    const frame3 = join(tempRoot, "frame-3.jpg");
    await writeFile(frame1, Buffer.from([1]));
    await writeFile(frame2, Buffer.from([2]));
    await writeFile(frame3, Buffer.from([3]));
    const transport = new FakeTransport();
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      transportFactory: () => transport,
      turnTimeoutMs: 1000
    });

    await client.enrichCapture({
      imagePaths: [frame1, frame2, frame3],
      metadata: {
        sourceAppName: "PwrSnap",
        sourceAppBundleId: "com.pwrdrvr.pwrsnap",
        captureKind: "video",
        widthPx: 2880,
        heightPx: 1920,
        capturedAt: "2026-05-18T13:30:00.000Z",
        videoDurationSec: 10,
        videoFrameSamples: [
          { positionPct: 15, timestampSec: 1.5 },
          { positionPct: 50, timestampSec: 5 },
          { positionPct: 85, timestampSec: 8.5 }
        ]
      }
    });

    const turnStart = transport.outbound.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      input: expect.arrayContaining([
        { type: "localImage", path: frame1 },
        { type: "localImage", path: frame2 },
        { type: "localImage", path: frame3 }
      ])
    });
    expect(JSON.stringify(turnStart?.params)).not.toContain("data:image/jpeg;base64");
    expect(JSON.stringify(turnStart?.params)).toContain(
      "Provided video frame samples: 15% at 1.500s, 50% at 5.000s, 85% at 8.500s"
    );
  });

  it("rejects the enrichment with the unwrapped reason when Codex faults the turn", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pwrsnap-codex-client-test-"));
    tempRoots.push(tempRoot);
    const imagePath = join(tempRoot, "capture.jpg");
    await writeFile(imagePath, Buffer.from([1, 2, 3]));
    // The exact provider-error blob from the field report: an image tool
    // pointed at a model that doesn't exist.
    const blob = JSON.stringify({
      type: "error",
      error: {
        type: "image_generation_user_error",
        code: "invalid_value",
        message: "The model 'gpt-image-2' does not exist.",
        param: "tools"
      },
      status: 400
    });
    const transport = new FakeTransport(blob);
    const client = new CodexAppServerClient({
      command: "/bin/codex",
      captureMetadataWorkspaceDir: join(tempRoot, "metadata-worker"),
      transportFactory: () => transport,
      turnTimeoutMs: 1000
    });

    await expect(
      client.enrichCapture({
        imagePaths: [imagePath],
        metadata: {
          sourceAppName: "PwrSnap",
          sourceAppBundleId: "com.pwrdrvr.pwrsnap",
          captureKind: "image",
          widthPx: 2880,
          heightPx: 1920,
          capturedAt: "2026-05-18T13:30:00.000Z"
        }
      })
      // The rich reason — not the generic "codex capture enrichment failed".
    ).rejects.toThrow("The model 'gpt-image-2' does not exist.");
  });
});
