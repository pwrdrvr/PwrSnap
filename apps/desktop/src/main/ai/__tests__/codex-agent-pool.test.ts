import { afterEach, describe, expect, test, vi } from "vitest";
import {
  acquireCodexAgentBackendView,
  closeCodexAgentPool
} from "../codex-agent-pool";

type MockCodexThreadClient = {
  interruptTurn: ReturnType<typeof vi.fn>;
  emitEvent(event: unknown): void;
};

const mockCodexThreadClients = vi.hoisted(() => [] as MockCodexThreadClient[]);

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
      request: vi.fn(async () => ({})),
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
