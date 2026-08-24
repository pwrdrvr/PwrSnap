// Library chat handler boundaries: persisted-list/history reads, exact
// transport ownership, and Result-based approval retry. The controller is a
// kit-shaped fake; the real ChatThreadAccess and ChatApprovalBroker are used.

import type { ChatThreadSidecar } from "@pwrsnap/shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", once: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}));

const harness = vi.hoisted(() => {
  const sidecar: ChatThreadSidecar = {
    schemaVersion: 1,
    threadId: "th1",
    name: "Chat",
    createdAt: "",
    modifiedAt: "",
    anchorCaptureId: "cap_1",
    focusHistory: [],
    archived: false,
    pinned: false,
    provider: null,
    model: null,
    reasoning: null,
    ownerClientId: null
  };
  return {
    sidecar,
    store: {
      list: vi.fn(async (): Promise<ChatThreadSidecar[]> => [sidecar]),
      get: vi.fn(async (threadId: string): Promise<ChatThreadSidecar | null> =>
        threadId === "th1" ? sidecar : null
      ),
      readJournal: vi.fn(async (): Promise<unknown[]> => [])
    },
    accesses: [] as unknown[],
    brokers: [] as unknown[]
  };
});

vi.mock("../../ai/chat-thread-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/chat-thread-store")>();
  return {
    ...actual,
    rootKeyedChatThreadStore: () => () => harness.store
  };
});

vi.mock("../../ai/chat-thread-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/chat-thread-access")>();
  return {
    ...actual,
    ChatThreadAccess: class extends actual.ChatThreadAccess {
      constructor(options: ConstructorParameters<typeof actual.ChatThreadAccess>[0]) {
        super(options);
        harness.accesses.push(this);
      }
    }
  };
});

vi.mock("../../ai/chat-approval-broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/chat-approval-broker")>();
  return {
    ...actual,
    ChatApprovalBroker: class extends actual.ChatApprovalBroker {
      constructor(options: ConstructorParameters<typeof actual.ChatApprovalBroker>[0]) {
        super(options);
        harness.brokers.push(this);
      }
    }
  };
});

const { bus } = await import("../../command-bus");
const { registerLibraryChatHandlers } = await import("../library-chat-handlers");
const { ChatThreadAccess } = await import("../../ai/chat-thread-access");
const { ChatApprovalBroker } = await import("../../ai/chat-approval-broker");

const kitView = {
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorId: "cap_1",
  archived: false,
  pinned: false,
  lastMessagePreview: "",
  status: { kind: "idle" as const }
};

const controller = {
  listThreads: vi.fn(async () => [kitView]),
  createThread: vi.fn(async () => kitView),
  sendMessage: vi.fn(async () => ({ turnId: "turn1" })),
  getHistory: vi.fn(async () => []),
  rename: vi.fn(async () => kitView),
  archive: vi.fn(async () => kitView),
  interrupt: vi.fn(async () => undefined),
  resolveApproval: vi.fn(async () => undefined)
};

let access: InstanceType<typeof ChatThreadAccess>;
let approvalBroker: InstanceType<typeof ChatApprovalBroker>;

beforeAll(() => {
  bus.installLocalAgentAuthorizer(async (clientId) => ({
    clientId,
    capabilities: ["capture.edit"]
  }));
  registerLibraryChatHandlers({
    controller: controller as never,
    settingsReader: async () => ({
      ai: { defaults: { libraryChat: { provider: "codex" } } }
    }) as never
  });
  access = harness.accesses[0] as InstanceType<typeof ChatThreadAccess>;
  approvalBroker = harness.brokers[0] as InstanceType<typeof ChatApprovalBroker>;
});

afterAll(() => {
  bus.uninstallLocalAgentAuthorizerForTests();
});

describe("codex:libraryChat handlers", () => {
  test("list is store-authoritative and does not construct/use a controller", async () => {
    controller.listThreads.mockClear();
    harness.store.list.mockClear();

    const result = await bus.dispatch(
      "codex:libraryChat:list",
      { anchorCaptureId: "cap_1" },
      { principal: "ipc" }
    );

    expect(harness.store.list).toHaveBeenCalledWith({
      includeArchived: false,
      anchorCaptureId: "cap_1"
    });
    expect(controller.listThreads).not.toHaveBeenCalled();
    expect(result.ok && result.value.threads.map((thread) => thread.threadId)).toEqual(["th1"]);
  });

  test("history reads only the persisted journal, not the controller", async () => {
    harness.store.readJournal.mockResolvedValueOnce([
      {
        kind: "message",
        message: { id: "msg1", role: "assistant", text: "Done", createdAt: 1 }
      }
    ]);
    controller.getHistory.mockClear();

    const result = await bus.dispatch(
      "codex:libraryChat:history",
      { threadId: "th1" },
      { principal: "ipc" }
    );

    expect(harness.store.readJournal).toHaveBeenCalledWith("th1");
    expect(controller.getHistory).not.toHaveBeenCalled();
    expect(result.ok && result.value.messages).toEqual([
      {
        id: "msg1",
        role: "assistant",
        content: [{ kind: "text", text: "Done" }],
        status: "complete",
        createdAt: "1970-01-01T00:00:00.001Z"
      }
    ]);
  });

  test("approval failure keeps the exact request pending and exact retry succeeds", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-retry",
      approvalId: "approval-retry",
      summary: "Run tool",
      detail: "Existing chat-policy detail"
    };
    const resolver = vi.fn()
      .mockRejectedValueOnce(new Error("transport included private tool arguments"))
      .mockResolvedValueOnce(undefined);
    approvalBroker.register(request, {}, resolver);

    const first = await bus.dispatch(
      "codex:libraryChat:approval",
      {
        threadId: request.threadId,
        turnId: request.turnId,
        approvalId: request.approvalId,
        decision: "approve"
      },
      { principal: "ipc" }
    );

    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe("approval_response_failed");
      expect(first.error.message).not.toContain("private tool arguments");
    }
    expect(approvalBroker.pendingForThread("th1")).toEqual(request);

    const retry = await bus.dispatch(
      "codex:libraryChat:approval",
      {
        threadId: request.threadId,
        turnId: request.turnId,
        approvalId: request.approvalId,
        decision: "approve"
      },
      { principal: "ipc" }
    );

    expect(retry).toEqual({ ok: true, value: undefined });
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(1, "approve");
    expect(resolver).toHaveBeenNthCalledWith(2, "approve");
    expect(approvalBroker.pendingForThread("th1")).toBeNull();
  });

  test("stale exact approval IDs return a Result error without controller resolution", async () => {
    controller.resolveApproval.mockClear();

    const result = await bus.dispatch(
      "codex:libraryChat:approval",
      {
        threadId: "th1",
        turnId: "turn-stale",
        approvalId: "approval-stale",
        decision: "deny"
      },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("approval_stale");
    expect(controller.resolveApproval).not.toHaveBeenCalled();
  });

  test("archive store failure leaves the visible thread quiesced and approval terminal", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-archive-failure",
      approvalId: "approval-archive-failure",
      summary: "Run tool"
    };
    const resolver = vi.fn(async () => undefined);
    approvalBroker.openThread(request.threadId);
    approvalBroker.register(request, {}, resolver);
    controller.interrupt.mockClear();
    controller.archive.mockRejectedValueOnce(new Error("archive store failed"));

    try {
      const result = await bus.dispatch(
        "codex:libraryChat:archive",
        { threadId: request.threadId, archived: true },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(false);
      expect(controller.interrupt).toHaveBeenCalledWith(request.threadId);
      expect(approvalBroker.pendingForThread(request.threadId)).toBeNull();
      expect(resolver).toHaveBeenCalledWith("deny");
    } finally {
      approvalBroker.openThread(request.threadId);
    }
  });

  test("awaiting-approval archive interrupts before denial and permits no hidden tool continuation", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-archive-quiesce",
      approvalId: "approval-archive-quiesce",
      summary: "Run tool"
    };
    const order: string[] = [];
    let interrupted = false;
    let archived = false;
    const postArchiveTool = vi.fn();
    controller.interrupt.mockImplementationOnce(async () => {
      order.push("interrupt");
      interrupted = true;
    });
    controller.archive.mockImplementationOnce(async (_threadId, nextArchived) => {
      order.push("archive");
      archived = nextArchived;
      return { ...kitView, archived: nextArchived };
    });
    const resolver = vi.fn(async (decision: string) => {
      order.push(`resolve:${decision}`);
      // Denial resumes an approval waiter. It may only do so after backend
      // cancellation and before the thread becomes hidden.
      if (!interrupted || archived) postArchiveTool();
    });
    approvalBroker.openThread(request.threadId);
    approvalBroker.register(request, {}, resolver);

    try {
      const result = await bus.dispatch(
        "codex:libraryChat:archive",
        { threadId: request.threadId, archived: true },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(true);
      expect(order).toEqual(["interrupt", "resolve:deny", "archive"]);
      expect(postArchiveTool).not.toHaveBeenCalled();
      expect(approvalBroker.pendingForThread(request.threadId)).toBeNull();
      if (result.ok) expect(result.value.archived).toBe(true);
    } finally {
      approvalBroker.openThread(request.threadId);
    }
  });

  test("archive aborts before metadata or denial when quiescing interrupt fails", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-archive-interrupt-failure",
      approvalId: "approval-archive-interrupt-failure",
      summary: "Run tool"
    };
    const resolver = vi.fn(async () => undefined);
    approvalBroker.openThread(request.threadId);
    approvalBroker.register(request, {}, resolver);
    controller.archive.mockClear();
    controller.interrupt.mockRejectedValueOnce(new Error("backend cancellation failed"));

    try {
      const result = await bus.dispatch(
        "codex:libraryChat:archive",
        { threadId: request.threadId, archived: true },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(false);
      expect(controller.archive).not.toHaveBeenCalled();
      expect(approvalBroker.pendingForThread(request.threadId)).toEqual(request);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await approvalBroker.closeThread(request.threadId);
      approvalBroker.openThread(request.threadId);
    }
  });

  test("unarchive failure preserves the broker's closed state", async () => {
    const threadId = "th1";
    await approvalBroker.closeThread(threadId);
    controller.archive.mockRejectedValueOnce(new Error("unarchive store failed"));

    try {
      const result = await bus.dispatch(
        "codex:libraryChat:archive",
        { threadId, archived: false },
        { principal: "ipc" }
      );
      expect(result.ok).toBe(false);

      const resolver = vi.fn(async () => undefined);
      expect(
        approvalBroker.register(
          {
            threadId,
            turnId: "turn-after-unarchive-failure",
            approvalId: "approval-after-unarchive-failure",
            summary: "Run tool"
          },
          {},
          resolver
        )
      ).toBe(false);
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("deny"));
    } finally {
      approvalBroker.openThread(threadId);
    }
  });

  test("interrupt failure preserves a live pending approval", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-interrupt-failure",
      approvalId: "approval-interrupt-failure",
      summary: "Run tool"
    };
    const resolver = vi.fn(async () => undefined);
    approvalBroker.openThread(request.threadId);
    approvalBroker.register(request, {}, resolver);
    controller.interrupt.mockRejectedValueOnce(new Error("interrupt failed"));

    try {
      const result = await bus.dispatch(
        "codex:libraryChat:interrupt",
        { threadId: request.threadId },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(false);
      expect(approvalBroker.pendingForThread(request.threadId)).toEqual(request);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await approvalBroker.closeThread(request.threadId);
      approvalBroker.openThread(request.threadId);
    }
  });

  test("create binds the exact IPC-null or MCP-client owner", async () => {
    const ownersSeen: Array<string | null> = [];
    controller.createThread
      .mockImplementationOnce(async () => {
        ownersSeen.push(access.ownerClientIdForCreate());
        return kitView;
      })
      .mockImplementationOnce(async () => {
        ownersSeen.push(access.ownerClientIdForCreate());
        return kitView;
      });

    const ipc = await bus.dispatch(
      "codex:libraryChat:create",
      { anchorCaptureId: "cap_1" },
      { principal: "ipc" }
    );
    const mcp = await bus.dispatch(
      "codex:libraryChat:create",
      { anchorCaptureId: "cap_1" },
      {
        principal: "mcp",
        localAgent: { clientId: "client-a", capabilities: [] }
      }
    );

    expect(ipc.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    expect(ownersSeen).toEqual([null, "client-a"]);
  });

  test("every existing-thread verb rejects IPC/MCP owner mismatches before side effects", async () => {
    const ownerSidecars = new Map<string, ChatThreadSidecar>();
    harness.store.get.mockImplementation(
      async (threadId: string) => ownerSidecars.get(threadId) ?? null
    );

    const cases = [
      {
        suffix: "send",
        command: "codex:libraryChat:send",
        request: (threadId: string) => ({ threadId, text: "edit this", anchorCaptureId: "cap_1" }),
        sideEffect: () => controller.sendMessage
      },
      {
        suffix: "wait",
        command: "codex:libraryChat:wait",
        request: (threadId: string) => ({ threadId, timeoutMs: 1_000 }),
        sideEffect: () => controller.listThreads
      },
      {
        suffix: "history",
        command: "codex:libraryChat:history",
        request: (threadId: string) => ({ threadId }),
        sideEffect: () => harness.store.readJournal
      },
      {
        suffix: "rename",
        command: "codex:libraryChat:rename",
        request: (threadId: string) => ({ threadId, name: "Renamed" }),
        sideEffect: () => controller.rename
      },
      {
        suffix: "archive",
        command: "codex:libraryChat:archive",
        request: (threadId: string) => ({ threadId, archived: true }),
        sideEffect: () => controller.archive
      },
      {
        suffix: "interrupt",
        command: "codex:libraryChat:interrupt",
        request: (threadId: string) => ({ threadId }),
        sideEffect: () => controller.interrupt
      }
    ] as const;
    const scenarios = [
      {
        suffix: "ipc-to-mcp",
        storedOwner: "client-a",
        dispatch: { principal: "ipc" as const }
      },
      {
        suffix: "mcp-to-ipc",
        storedOwner: null,
        dispatch: {
          principal: "mcp" as const,
          localAgent: { clientId: "client-a", capabilities: [] }
        }
      }
    ] as const;

    try {
      for (const scenario of scenarios) {
        for (const entry of cases) {
          const threadId = `th-library-${scenario.suffix}-${entry.suffix}`;
          ownerSidecars.set(threadId, {
            ...(harness.sidecar as ChatThreadSidecar),
            threadId,
            ownerClientId: scenario.storedOwner
          });
          const sideEffect = entry.sideEffect();
          sideEffect.mockClear();

          const result = await bus.dispatch(
            entry.command as never,
            entry.request(threadId) as never,
            scenario.dispatch
          );

          expect(result.ok, `${scenario.suffix} ${entry.suffix}`).toBe(false);
          if (!result.ok) expect(result.error.code).toBe("thread_owner_mismatch");
          expect(sideEffect, `${scenario.suffix} ${entry.suffix}`).not.toHaveBeenCalled();
        }

        const threadId = `th-library-${scenario.suffix}-approval`;
        const approvalId = `approval-library-${scenario.suffix}`;
        ownerSidecars.set(threadId, {
          ...(harness.sidecar as ChatThreadSidecar),
          threadId,
          ownerClientId: scenario.storedOwner
        });
        const resolver = vi.fn(async () => undefined);
        approvalBroker.register(
          { threadId, turnId: "turn-owner", approvalId, summary: "Run tool" },
          {},
          resolver
        );

        const result = await bus.dispatch(
          "codex:libraryChat:approval",
          { threadId, turnId: "turn-owner", approvalId, decision: "approve" },
          scenario.dispatch
        );

        expect(result.ok, `${scenario.suffix} approval`).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("thread_owner_mismatch");
        expect(resolver, `${scenario.suffix} approval`).not.toHaveBeenCalled();
        await approvalBroker.closeThread(threadId);
      }
    } finally {
      harness.store.get.mockImplementation(
        async (threadId: string) => (threadId === "th1" ? harness.sidecar : null)
      );
    }
  });

  test("list filters exact IPC-null and MCP-client ownership", async () => {
    const human = { ...(harness.sidecar as ChatThreadSidecar), threadId: "th-human" };
    const clientA = { ...human, threadId: "th-client-a", ownerClientId: "client-a" };
    const clientB = { ...human, threadId: "th-client-b", ownerClientId: "client-b" };
    harness.store.list.mockResolvedValue([human, clientA, clientB]);

    try {
      const ipc = await bus.dispatch(
        "codex:libraryChat:list",
        {},
        { principal: "ipc" }
      );
      const mcp = await bus.dispatch(
        "codex:libraryChat:list",
        {},
        {
          principal: "mcp",
          localAgent: { clientId: "client-a", capabilities: [] }
        }
      );

      expect(ipc.ok && ipc.value.threads.map((thread) => thread.threadId)).toEqual(["th-human"]);
      expect(mcp.ok && mcp.value.threads.map((thread) => thread.threadId)).toEqual(["th-client-a"]);
    } finally {
      harness.store.list.mockResolvedValue([harness.sidecar]);
    }
  });
});
