import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireCodexAgentBackendView,
  closeCodexAgentPool,
  listCodexModelsFromPool
} from "../codex-agent-pool";

type MockCodexThreadClient = {
  startThread: ReturnType<typeof vi.fn>;
  interruptTurn: ReturnType<typeof vi.fn>;
  emitEvent(event: unknown): void;
};

const mockCodexThreadClients = vi.hoisted(() => [] as MockCodexThreadClient[]);
const mockConnectionRequest = vi.hoisted(() => vi.fn(async () => ({})));
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
});
