import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireCodexAgentBackendView,
  closeCodexAgentPool,
  listCodexModelsFromPool,
  runCodexOneShotFromPool
} from "../codex-agent-pool";

type MockCodexThreadClient = {
  startThread: ReturnType<typeof vi.fn>;
  interruptTurn: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitEvent(event: unknown): void;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mockCodexThreadClients = vi.hoisted(() => [] as MockCodexThreadClient[]);
const mockConnectionRequest = vi.hoisted(() =>
  vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({}))
);
const mockAssertCodexCliVersion = vi.hoisted(() => vi.fn(async () => "0.144.0"));
const mockResolveCodexCommand = vi.hoisted(() =>
  vi.fn(
    async ({ command }: { command: string }): Promise<{
      command: string;
      source: "path" | "application";
    }> => ({
      command,
      source: "path"
    })
  )
);

vi.mock("../../settings/codex-discovery", () => ({
  assertCodexCliVersion: mockAssertCodexCliVersion,
  resolveCodexCommand: mockResolveCodexCommand
}));

vi.mock("@pwrdrvr/agent-client", () => {
  class CodexThreadClient {
    private readonly eventHandlers = new Set<(event: unknown) => void>();
    readonly startThread = vi.fn(async () => ({
      threadId: "thread-1",
      model: "gpt-5.5",
      modelProvider: "codex",
      serviceTier: null
    }));
    readonly startTurn = vi.fn(async () => ({ turnId: "turn-1" }));
    readonly interruptTurn = vi.fn(async () => undefined);
    readonly archiveThread = vi.fn(async () => undefined);
    readonly forkThread = vi.fn(async () => ({
      threadId: "thread-fork",
      model: "gpt-5.5",
      modelProvider: "codex",
      serviceTier: null
    }));
    readonly clearThreadGitInfo = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly onEvent = vi.fn((handler: (event: unknown) => void) => {
      this.eventHandlers.add(handler);
      return () => this.eventHandlers.delete(handler);
    });
    readonly onToolCall = vi.fn(() => () => undefined);
    readonly onApprovalRequest = vi.fn(() => () => undefined);
    readonly getConnection = vi.fn(async () => ({
      request: mockConnectionRequest,
      setNotificationHandler: vi.fn()
    }));
    readonly initialize = vi.fn(async () => ({ userAgent: "codex-test" }));
    readonly handleNotification = vi.fn();

    constructor(_options: unknown) {
      mockCodexThreadClients.push(this);
    }

    emitEvent(event: unknown): void {
      for (const handler of this.eventHandlers) handler(event);
    }
  }

  return { CodexThreadClient };
});

afterEach(async () => {
  await closeCodexAgentPool();
  mockCodexThreadClients.length = 0;
  vi.clearAllMocks();
  mockConnectionRequest.mockReset();
  mockConnectionRequest.mockResolvedValue({});
});

describe("Codex agent pool", () => {
  test("refuses to start a thread when the CLI is older than the protocol floor", async () => {
    mockAssertCodexCliVersion.mockRejectedValueOnce(
      new Error("Codex CLI 0.143.0 is older than the minimum supported version 0.144.0")
    );
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-old-cli-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });

    await expect(view.startThread()).rejects.toThrow(
      "older than the minimum supported version 0.144.0"
    );
    expect(mockCodexThreadClients[0]?.startThread).not.toHaveBeenCalled();

    // A failed probe is not cached forever; upgrading the CLI can recover
    // without restarting PwrSnap.
    await expect(view.startThread()).resolves.toEqual(
      expect.objectContaining({ threadId: "thread-1" })
    );
    expect(mockCodexThreadClients[0]?.startThread).toHaveBeenCalledTimes(1);
  });

  test("probes the command resolved by discovery in auto mode", async () => {
    mockResolveCodexCommand.mockResolvedValueOnce({
      command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      source: "application"
    });
    const view = acquireCodexAgentBackendView({
      command: "codex",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-discovery-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });

    await view.startThread();

    expect(mockResolveCodexCommand).toHaveBeenCalledWith({
      command: "codex",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-discovery-test" }
    });
    expect(mockAssertCodexCliVersion).toHaveBeenCalledWith(
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      { CODEX_HOME: "/tmp/pwrsnap-codex-pool-discovery-test" }
    );
  });

  test("preserves each model's advertised reasoning efforts and default", async () => {
    mockConnectionRequest.mockResolvedValueOnce({
      data: [
        {
          id: "gpt-5.6-terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6-Terra",
          description: "Frontier model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Thorough" },
            { reasoningEffort: "xhigh", description: "Extra high" },
            { reasoningEffort: "max", description: "Maximum" },
            { reasoningEffort: "ultra", description: "Ultra" }
          ],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          defaultServiceTier: null,
          isDefault: true
        }
      ],
      nextCursor: null
    });

    const models = await listCodexModelsFromPool({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-model-test" },
      includeHidden: false
    });

    expect(models).toEqual([
      expect.objectContaining({
        id: "gpt-5.6-terra",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "medium"
      })
    ]);
  });

  test("interrupts a view's active turns before releasing handlers", async () => {
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });
    const started = await view.startThread();
    await view.startTurn({
      threadId: started.threadId,
      input: { text: "hello" }
    } as never);

    await view.close();

    expect(mockCodexThreadClients[0]?.interruptTurn).toHaveBeenCalledTimes(1);
    expect(mockCodexThreadClients[0]?.interruptTurn).toHaveBeenCalledWith("thread-1");
  });

  test("does not interrupt turns already completed by Codex", async () => {
    const view = acquireCodexAgentBackendView({
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-test" },
      loggerScope: "pwrsnap:test-codex-pool"
    });
    const started = await view.startThread();
    await view.startTurn({
      threadId: started.threadId,
      input: { text: "hello" }
    } as never);
    mockCodexThreadClients[0]?.emitEvent({
      kind: "turn_completed",
      threadId: "thread-1",
      status: "completed"
    });

    await view.close();

    expect(mockCodexThreadClients[0]?.interruptTurn).not.toHaveBeenCalled();
  });

  test("uses a fresh ephemeral thread for every pooled one-shot run", async () => {
    let nextThread = 0;
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") {
        return {
          config: {
            mcp_servers: {
              context7: { command: "npx", env: { SECRET: "never-forward-me" } },
              pwrsnap: { command: "pwrsnap-mcp-server" }
            }
          }
        };
      }
      if (method === "thread/start") {
        nextThread += 1;
        return {
          thread: { id: `one-shot-thread-${nextThread}` },
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          serviceTier: null
        };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = `turn-for-${threadId}`;
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "token_usage",
            threadId,
            turnId,
            usage: {
              inputTokens: 2_500,
              cachedInputTokens: 0,
              outputTokens: 20,
              reasoningOutputTokens: 0,
              totalTokens: 2_520
            }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        }, 0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    const options = {
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-one-shot-test" },
      workspaceDir: "/tmp/pwrsnap-one-shot-workspace",
      prompt: "describe this image",
      imagePaths: ["/tmp/capture.jpg"],
      baseInstructions: "Return JSON only.",
      threadConfig: { project_doc_max_bytes: 0 }
    } as const;

    const first = await runCodexOneShotFromPool(options);
    const second = await runCodexOneShotFromPool(options);

    expect(first.threadId).toBe("one-shot-thread-1");
    expect(second.threadId).toBe("one-shot-thread-2");
    expect(mockCodexThreadClients).toHaveLength(1);

    const calls = mockConnectionRequest.mock.calls;
    const starts = calls.filter(([method]) => method === "thread/start");
    expect(starts).toHaveLength(2);
    for (const [, params] of starts) {
      expect(params).toMatchObject({
        ephemeral: true,
        environments: [],
        config: {
          project_doc_max_bytes: 0,
          mcp_servers: {
            context7: { enabled: false },
            pwrsnap: { enabled: false }
          }
        }
      });
      expect(params).not.toHaveProperty("dynamicTools");
      expect(JSON.stringify(params)).not.toContain("never-forward-me");
    }
    expect(calls.filter(([method]) => method === "config/read")).toHaveLength(2);
    expect(calls.filter(([method]) => method === "thread/unsubscribe")).toHaveLength(2);
    expect(calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(calls.some(([method]) => method === "thread/rollback")).toBe(false);
  });

  test("recycles the enrichment App Server after twenty one-shot threads", async () => {
    let nextThread = 0;
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        nextThread += 1;
        return {
          thread: { id: `bounded-thread-${nextThread}` },
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          serviceTier: null
        };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = `turn-for-${threadId}`;
        const activeClient = mockCodexThreadClients.at(-1);
        setTimeout(() => {
          activeClient?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          activeClient?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        }, 0);
        return { turn: { id: turnId } };
      }
      return {};
    });

    const options = {
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-bounded-test" },
      workspaceDir: "/tmp/pwrsnap-bounded-workspace",
      prompt: "describe this image",
      threadConfig: { project_doc_max_bytes: 0 }
    } as const;

    for (let run = 0; run < 21; run += 1) {
      await runCodexOneShotFromPool(options);
    }

    expect(mockCodexThreadClients).toHaveLength(2);
    expect(mockCodexThreadClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(mockCodexThreadClients[1]?.close).not.toHaveBeenCalled();
    expect(
      mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/start")
    ).toHaveLength(21);
    expect(
      mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/unsubscribe")
    ).toHaveLength(21);
  });

  test("fails closed before starting a one-shot thread when MCP config cannot be read", async () => {
    mockConnectionRequest.mockImplementation(async (method: string) => {
      if (method === "config/read") throw new Error("config unavailable");
      return {};
    });

    await expect(
      runCodexOneShotFromPool({
        command: "codex-test",
        env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-mcp-fail-closed-test" },
        workspaceDir: "/tmp/pwrsnap-mcp-fail-closed-workspace",
        prompt: "describe this image",
        threadConfig: { project_doc_max_bytes: 0 }
      })
    ).rejects.toThrow("config unavailable");

    expect(
      mockConnectionRequest.mock.calls.some(([method]) => method === "thread/start")
    ).toBe(false);
  });

  test("does not start a queued one-shot after the enrichment owner closes", async () => {
    const unsubscribeGate = deferred();
    mockConnectionRequest.mockImplementation(async (method: string, params: unknown) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        return {
          thread: { id: "active-one-shot-thread" },
          model: "gpt-5.6-luna",
          modelProvider: "openai",
          serviceTier: null
        };
      }
      if (method === "turn/start") {
        const { threadId } = params as { threadId: string };
        const turnId = `turn-for-${threadId}`;
        setTimeout(() => {
          mockCodexThreadClients[0]?.emitEvent({
            kind: "agent_message",
            threadId,
            turnId,
            message: { text: '{"ok":true}' }
          });
          mockCodexThreadClients[0]?.emitEvent({
            kind: "turn_completed",
            threadId,
            turnId,
            status: "completed"
          });
        }, 0);
        return { turn: { id: turnId } };
      }
      if (method === "thread/unsubscribe") return await unsubscribeGate.promise;
      return {};
    });

    const options = {
      command: "codex-test",
      env: { CODEX_HOME: "/tmp/pwrsnap-codex-pool-shared-shutdown-test" },
      workspaceDir: "/tmp/pwrsnap-shared-shutdown-workspace",
      prompt: "describe this image",
      threadConfig: { project_doc_max_bytes: 0 }
    } as const;
    const firstRun = runCodexOneShotFromPool(options);
    const secondOutcome = runCodexOneShotFromPool(options).catch(
      (error: unknown) => error
    );

    await vi.waitFor(() => {
      expect(
        mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/unsubscribe")
      ).toHaveLength(1);
    });
    await closeCodexAgentPool();
    unsubscribeGate.resolve();

    await expect(firstRun).resolves.toEqual(
      expect.objectContaining({ threadId: "active-one-shot-thread" })
    );
    await expect(secondOutcome).resolves.toEqual(
      expect.objectContaining({
        message: "Codex one-shot cancelled because its enrichment owner closed"
      })
    );
    expect(mockCodexThreadClients).toHaveLength(1);
    expect(
      mockConnectionRequest.mock.calls.filter(([method]) => method === "thread/start")
    ).toHaveLength(1);
  });
});
