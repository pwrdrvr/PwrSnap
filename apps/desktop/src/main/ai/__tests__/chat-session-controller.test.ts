import { describe, expect, test, vi } from "vitest";
import type {
  AgentBackend,
  AgentBackendApprovalHandler,
  AgentBackendToolCallHandler,
  AgentStartThreadOptions,
  AgentStartTurnOptions,
  NormalizedThreadEvent,
  NormalizedThreadRecord,
  ThreadStore,
  Unsubscribe
} from "@pwrdrvr/agent-core";
import type { ChatControllerEvent } from "@pwrdrvr/agent-client";
import { PwrSnapChatSessionController } from "../chat-session-controller";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeBackend implements AgentBackend {
  readonly events = new Set<(event: NormalizedThreadEvent) => void>();
  readonly interruptTurn = vi.fn(async (_threadId: string): Promise<void> => undefined);
  readonly close = vi.fn(async (): Promise<void> => undefined);
  readonly eventUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  readonly toolUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  readonly approvalUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];

  async startThread(_options?: AgentStartThreadOptions): Promise<{ threadId: string }> {
    return { threadId: "t1" };
  }

  async startTurn(_options: AgentStartTurnOptions): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }

  onEvent(callback: (event: NormalizedThreadEvent) => void): Unsubscribe {
    this.events.add(callback);
    const unsubscribe = vi.fn(() => this.events.delete(callback));
    this.eventUnsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  onToolCall(_handler: AgentBackendToolCallHandler): Unsubscribe {
    const unsubscribe = vi.fn();
    this.toolUnsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  onApprovalRequest(_handler: AgentBackendApprovalHandler): Unsubscribe {
    const unsubscribe = vi.fn();
    this.approvalUnsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  emit(event: NormalizedThreadEvent): void {
    for (const callback of [...this.events]) callback(event);
  }
}

function memoryStore(): ThreadStore {
  const record: NormalizedThreadRecord = {
    threadId: "t1",
    name: "Chat",
    createdAt: "2026-08-23T00:00:00.000Z",
    modifiedAt: "2026-08-23T00:00:00.000Z",
    anchorId: null,
    anchorHistory: [],
    archived: false,
    pinned: false
  };
  const journal: unknown[] = [];
  return {
    prepareThreadDir: vi.fn(async () => ({ path: "/tmp/pwrsnap-chat-session-test" })),
    discardPreparedThreadDir: vi.fn(async () => undefined),
    create: vi.fn(async () => record),
    list: vi.fn(async () => [record]),
    get: vi.fn(async () => record),
    update: vi.fn(async () => record),
    delete: vi.fn(async () => undefined),
    appendAnchor: vi.fn(async () => undefined),
    journalAppend: vi.fn(async (_threadId: string, entry: unknown) => {
      journal.push(entry);
    }),
    readJournal: vi.fn(async () => [...journal]),
    attachmentsDir: vi.fn(async () => "/tmp/pwrsnap-chat-session-test/attachments"),
    recordUsage: vi.fn(async () => undefined)
  };
}

function setup(): {
  backend: FakeBackend;
  events: ChatControllerEvent[];
  controller: PwrSnapChatSessionController<Record<string, never>>;
} {
  const backend = new FakeBackend();
  const events: ChatControllerEvent[] = [];
  const controller = new PwrSnapChatSessionController<Record<string, never>>({
    client: backend,
    store: memoryStore(),
    readSettings: async () => ({}),
    broadcast: (event) => events.push(event),
    buildSystemPrompt: () => "",
    buildTurnContext: () => "",
    toolLabels: {}
  });
  controller.wire();
  return { backend, events, controller };
}

async function startPartial(
  controller: PwrSnapChatSessionController<Record<string, never>>,
  backend: FakeBackend
): Promise<void> {
  await controller.sendMessage({ threadId: "t1", text: "hello" });
  backend.emit({
    kind: "agent_message_delta",
    threadId: "t1",
    turnId: "turn-1",
    itemId: "item-1",
    delta: "partial answer"
  });
}

describe("PwrSnapChatSessionController interrupt lifecycle", () => {
  test("idle interrupt is a no-op and never calls the backend", async () => {
    const { backend, controller } = setup();
    await controller.interrupt("t1");
    expect(backend.interruptTurn).not.toHaveBeenCalled();
  });

  test("successful Stop calls the backend once and preserves partial output", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);

    await controller.interrupt("t1");

    expect(backend.interruptTurn).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: "turn_interrupted",
      threadId: "t1",
      turnId: "turn-1"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_committed",
        message: expect.objectContaining({ role: "assistant", text: "partial answer" })
      })
    );
  });

  test("concurrent Stop calls share one cancellation request", async () => {
    const { backend, controller } = setup();
    await startPartial(controller, backend);
    const cancellation = deferred<void>();
    backend.interruptTurn.mockReturnValueOnce(cancellation.promise);

    const first = controller.interrupt("t1");
    const second = controller.interrupt("t1");
    expect(first).toBe(second);
    expect(backend.interruptTurn).toHaveBeenCalledTimes(1);

    cancellation.resolve();
    await Promise.all([first, second]);
  });

  test("backend Stop rejection propagates and leaves the turn retryable", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);
    backend.interruptTurn.mockRejectedValueOnce(new Error("cancel rejected"));

    await expect(controller.interrupt("t1")).rejects.toThrow("cancel rejected");
    expect(events.some((event) => event.type === "turn_interrupted")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "message_committed" && event.message.role === "assistant"
      )
    ).toHaveLength(0);

    await controller.interrupt("t1");
    expect(backend.interruptTurn).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "turn_interrupted")).toBe(true);
  });

  test("natural completion winning an in-flight Stop emits no interruption", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);
    const cancellation = deferred<void>();
    backend.interruptTurn.mockReturnValueOnce(cancellation.promise);

    const stopping = controller.interrupt("t1");
    backend.emit({
      kind: "turn_completed",
      threadId: "t1",
      turnId: "turn-1",
      status: "completed"
    });
    await Promise.resolve();
    cancellation.resolve();
    await stopping;

    expect(events.some((event) => event.type === "turn_interrupted")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "message_committed" && event.message.role === "assistant"
      )
    ).toHaveLength(1);
  });

  test("backend-confirmed interruption still emits the user interruption event", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);
    const cancellation = deferred<void>();
    backend.interruptTurn.mockReturnValueOnce(cancellation.promise);

    const stopping = controller.interrupt("t1");
    backend.emit({
      kind: "turn_completed",
      threadId: "t1",
      turnId: "turn-1",
      status: "interrupted"
    });
    cancellation.resolve();
    await stopping;
    await Promise.resolve();

    expect(events).toContainEqual({
      type: "turn_interrupted",
      threadId: "t1",
      turnId: "turn-1"
    });
    expect(
      events.filter((event) => event.type === "turn_interrupted")
    ).toHaveLength(1);
  });

  test("completion also wins when the in-flight cancellation rejects", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);
    const cancellation = deferred<void>();
    backend.interruptTurn.mockReturnValueOnce(cancellation.promise);

    const stopping = controller.interrupt("t1");
    backend.emit({
      kind: "turn_completed",
      threadId: "t1",
      turnId: "turn-1",
      status: "completed"
    });
    cancellation.reject(new Error("no active turn"));

    await expect(stopping).resolves.toBeUndefined();
    expect(events.some((event) => event.type === "turn_interrupted")).toBe(false);
  });

  test("terminal backend failure retains partial and error text", async () => {
    const { backend, events, controller } = setup();
    await startPartial(controller, backend);

    backend.emit({
      kind: "error",
      threadId: "t1",
      turnId: "turn-1",
      message: "provider disconnected",
      willRetry: false
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_committed",
        message: expect.objectContaining({
          text: expect.stringContaining("partial answer")
        })
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_committed",
        message: expect.objectContaining({
          text: expect.stringContaining("provider disconnected")
        })
      })
    );
  });

  test("does not adopt a foreign turn from a shared backend event stream", async () => {
    const { backend, controller } = setup();
    backend.emit({ kind: "turn_started", threadId: "foreign", turnId: "foreign-turn" });

    await controller.interrupt("foreign");
    expect(backend.interruptTurn).not.toHaveBeenCalled();
  });
});
