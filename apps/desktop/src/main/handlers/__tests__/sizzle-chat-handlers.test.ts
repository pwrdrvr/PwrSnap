// Sizzle chat verb registration + delegation. Uses a fake (kit-shaped)
// controller so the eight codex:sizzleChat:* verbs are exercised without a
// live Codex connection or DB. Also pins the unscoped-list guard (a Sizzle
// list with no project anchor must return empty, never the shared table's
// rows).
//
// Post-migration wiring: the controller is now the kit's `ChatThreadController`
// — it speaks `anchorId` (not `anchorCaptureId`) and the neutral approval
// decision `"approved" | "denied" | "abort"`. The verbs translate the wire
// payloads at the boundary: `anchorCaptureId → anchorId` on the way in,
// `NormalizedThreadView → LibraryChatThreadView` (anchorId → anchorCaptureId)
// on the way out, and `ChatApprovalDecision → NormalizedApprovalDecision`.

import type { ChatThreadSidecar } from "@pwrsnap/shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] }
}));

const { bus } = await import("../../command-bus");
const {
  forkProjectChats,
  registerSizzleChatHandlers
} = await import("../sizzle-chat-handlers");
const { ChatApprovalBroker } = await import("../../ai/chat-approval-broker");
const { ChatThreadAccess } = await import("../../ai/chat-thread-access");

/** What the kit controller returns: a `NormalizedThreadView` (anchorId). */
const kitView = {
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorId: "sz_1",
  archived: false,
  pinned: false,
  lastMessagePreview: "",
  status: { kind: "idle" as const }
};

/** What the renderer expects back over IPC: a `LibraryChatThreadView`
 *  (anchorCaptureId). */
const rendererView = {
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorCaptureId: "sz_1",
  archived: false,
  pinned: false,
  lastMessagePreview: "",
  status: { kind: "idle" as const },
  provider: null,
  model: null,
  reasoning: null,
  pendingApproval: null
};

const sidecar: ChatThreadSidecar = {
  schemaVersion: 1 as const,
  threadId: "th1",
  name: "Chat",
  createdAt: "",
  modifiedAt: "",
  anchorCaptureId: "sz_1",
  focusHistory: [],
  archived: false,
  pinned: false,
  provider: null,
  model: null,
  reasoning: null,
  ownerClientId: null
};

const store = {
  list: vi.fn(async () => [sidecar]),
  get: vi.fn(async (threadId: string) => (threadId === "th1" ? sidecar : null)),
  readJournal: vi.fn(async () => [])
};

const threadAccess = new ChatThreadAccess({
  surface: "sizzle",
  store: () => store as never,
  loggerScope: "test:sizzle-access"
});

const controller = {
  listThreads: vi.fn(async () => [kitView]),
  createThread: vi.fn(async () => kitView),
  sendMessage: vi.fn(async () => ({ turnId: "turn1" })),
  getHistory: vi.fn(async () => []),
  rename: vi.fn(async () => kitView),
  archive: vi.fn(async () => kitView),
  interrupt: vi.fn(async () => undefined),
  resolveApproval: vi.fn(async (_input: unknown) => undefined),
  forkThreadsForAnchor: vi.fn(async () => [])
};

const approvalBroker = new ChatApprovalBroker({
  surface: "sizzle",
  loggerScope: "test:sizzle-approval",
  emitResolved: vi.fn(),
  emitSuperseded: vi.fn()
});

beforeAll(() => {
  bus.installLocalAgentAuthorizer(async (clientId) => ({
    clientId,
    capabilities: ["sizzle.compose"]
  }));
  registerSizzleChatHandlers({
    controller: controller as never,
    settingsReader: async () => ({}) as never,
    store: store as never,
    access: threadAccess,
    approvalBroker
  });
});

afterAll(() => {
  bus.uninstallLocalAgentAuthorizerForTests();
});

describe("codex:sizzleChat verbs", () => {
  test("list scoped to a project is store-authoritative without constructing a controller", async () => {
    controller.listThreads.mockClear();
    const r = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    expect(store.list).toHaveBeenCalledWith({
      includeArchived: false,
      anchorCaptureId: "sz_1"
    });
    expect(controller.listThreads).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, value: { threads: [rendererView] } });
  });

  test("list WITHOUT a project anchor returns empty, never hits the shared table", async () => {
    controller.listThreads.mockClear();
    const r = await bus.dispatch(
      "codex:sizzleChat:list",
      { anchorCaptureId: null },
      { principal: "ipc" }
    );
    expect(r).toEqual({ ok: true, value: { threads: [] } });
    expect(controller.listThreads).not.toHaveBeenCalled();
  });

  test("create delegates to createThread", async () => {
    await bus.dispatch("codex:sizzleChat:create", { anchorCaptureId: "sz_1" }, { principal: "ipc" });
    expect(controller.createThread).toHaveBeenCalledWith({ anchorId: "sz_1" });
  });

  test("create binds the exact IPC-null or MCP-client owner during controller creation", async () => {
    const ownersSeen: Array<string | null> = [];
    controller.createThread
      .mockImplementationOnce(async () => {
        ownersSeen.push(threadAccess.ownerClientIdForCreate());
        return kitView;
      })
      .mockImplementationOnce(async () => {
        ownersSeen.push(threadAccess.ownerClientIdForCreate());
        return kitView;
      });

    const ipcResult = await bus.dispatch(
      "codex:sizzleChat:create",
      { anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    const mcpResult = await bus.dispatch(
      "codex:sizzleChat:create",
      { anchorCaptureId: "sz_1" },
      {
        principal: "mcp",
        localAgent: { clientId: "client-a", capabilities: [] }
      }
    );

    expect(ipcResult.ok).toBe(true);
    expect(mcpResult.ok).toBe(true);
    expect(ownersSeen).toEqual([null, "client-a"]);
  });

  test("send forwards threadId + text + anchor and returns the turnId", async () => {
    const r = await bus.dispatch(
      "codex:sizzleChat:send",
      { threadId: "th1", text: "make a reel", anchorCaptureId: "sz_1" },
      { principal: "ipc" }
    );
    expect(controller.sendMessage).toHaveBeenCalledWith({
      threadId: "th1",
      text: "make a reel",
      anchorId: "sz_1"
    });
    expect(r).toEqual({ ok: true, value: { turnId: "turn1" } });
  });

  test("approval forwards the full (threadId, turnId, approvalId, decision)", async () => {
    approvalBroker.register(
      { threadId: "th1", turnId: "turn1", approvalId: "ap1", summary: "Run tool" },
      {},
      async (decision) => {
        await controller.resolveApproval({
          threadId: "th1",
          turnId: "turn1",
          approvalId: "ap1",
          decision: decision === "approve" ? "approved" : "denied"
        });
      }
    );
    await bus.dispatch(
      "codex:sizzleChat:approval",
      { threadId: "th1", turnId: "turn1", approvalId: "ap1", decision: "approve" },
      { principal: "ipc" }
    );
    expect(controller.resolveApproval).toHaveBeenCalledWith({
      threadId: "th1",
      turnId: "turn1",
      approvalId: "ap1",
      // "approve" maps to the kit's neutral "approved" at the boundary.
      decision: "approved"
    });
  });

  test("approval Result failure keeps the exact request pending and retry succeeds", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-retry",
      approvalId: "approval-retry",
      summary: "Run tool",
      detail: "Existing chat-policy detail"
    };
    const resolver = vi.fn()
      .mockRejectedValueOnce(new Error("transport leaked raw tool args"))
      .mockResolvedValueOnce(undefined);
    approvalBroker.register(request, {}, resolver);

    const first = await bus.dispatch(
      "codex:sizzleChat:approval",
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
      expect(first.error.message).not.toContain("raw tool args");
    }
    expect(approvalBroker.pendingForThread("th1")).toEqual(request);

    const retry = await bus.dispatch(
      "codex:sizzleChat:approval",
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

  test("stale exact approval IDs return a Result error without reaching a controller", async () => {
    controller.resolveApproval.mockClear();

    const result = await bus.dispatch(
      "codex:sizzleChat:approval",
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

  test("archive failure preserves a live pending approval", async () => {
    const request = {
      threadId: "th1",
      turnId: "turn-archive-failure",
      approvalId: "approval-archive-failure",
      summary: "Run tool"
    };
    const resolver = vi.fn(async () => undefined);
    approvalBroker.openThread(request.threadId);
    approvalBroker.register(request, {}, resolver);
    controller.archive.mockRejectedValueOnce(new Error("archive store failed"));

    try {
      const result = await bus.dispatch(
        "codex:sizzleChat:archive",
        { threadId: request.threadId, archived: true },
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

  test("unarchive failure preserves the broker's closed state", async () => {
    const threadId = "th1";
    await approvalBroker.closeThread(threadId);
    controller.archive.mockRejectedValueOnce(new Error("unarchive store failed"));

    try {
      const result = await bus.dispatch(
        "codex:sizzleChat:archive",
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
        "codex:sizzleChat:interrupt",
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

  test("rejects an unknown approval decision instead of mapping it to deny", async () => {
    controller.resolveApproval.mockClear();

    const result = await bus.dispatch(
      "codex:sizzleChat:approval",
      {
        threadId: "th1",
        turnId: "turn-invalid",
        approvalId: "approval-invalid",
        decision: "allow"
      } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_approval_response");
    expect(controller.resolveApproval).not.toHaveBeenCalled();
  });

  test("every thread verb rejects IPC/MCP owner mismatches before side effects", async () => {
    const ownerSidecars = new Map<string, typeof sidecar>();
    store.get.mockImplementation(async (threadId: string) => ownerSidecars.get(threadId) ?? null);

    const cases = [
      {
        suffix: "send",
        command: "codex:sizzleChat:send",
        request: (threadId: string) => ({ threadId, text: "make a reel", anchorCaptureId: "sz_1" }),
        sideEffect: () => controller.sendMessage
      },
      {
        suffix: "history",
        command: "codex:sizzleChat:history",
        request: (threadId: string) => ({ threadId }),
        sideEffect: () => store.readJournal
      },
      {
        suffix: "rename",
        command: "codex:sizzleChat:rename",
        request: (threadId: string) => ({ threadId, name: "Renamed" }),
        sideEffect: () => controller.rename
      },
      {
        suffix: "archive",
        command: "codex:sizzleChat:archive",
        request: (threadId: string) => ({ threadId, archived: true }),
        sideEffect: () => controller.archive
      },
      {
        suffix: "interrupt",
        command: "codex:sizzleChat:interrupt",
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
          const threadId = `th-${scenario.suffix}-${entry.suffix}`;
          ownerSidecars.set(threadId, {
            ...sidecar,
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

        const threadId = `th-${scenario.suffix}-approval`;
        const approvalId = `approval-${scenario.suffix}`;
        ownerSidecars.set(threadId, {
          ...sidecar,
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
          "codex:sizzleChat:approval",
          { threadId, turnId: "turn-owner", approvalId, decision: "approve" },
          scenario.dispatch
        );

        expect(result.ok, `${scenario.suffix} approval`).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("thread_owner_mismatch");
        expect(resolver, `${scenario.suffix} approval`).not.toHaveBeenCalled();
        await approvalBroker.closeThread(threadId);
      }
    } finally {
      store.get.mockImplementation(async (threadId: string) => (threadId === "th1" ? sidecar : null));
    }
  });

  test("list filters exact IPC-null and MCP-client ownership", async () => {
    const human = { ...sidecar, threadId: "th-human", ownerClientId: null };
    const clientA = { ...sidecar, threadId: "th-client-a", ownerClientId: "client-a" };
    const clientB = { ...sidecar, threadId: "th-client-b", ownerClientId: "client-b" };
    store.list.mockResolvedValue([human, clientA, clientB]);

    try {
      const ipc = await bus.dispatch(
        "codex:sizzleChat:list",
        { anchorCaptureId: "sz_1" },
        { principal: "ipc" }
      );
      const mcp = await bus.dispatch(
        "codex:sizzleChat:list",
        { anchorCaptureId: "sz_1" },
        {
          principal: "mcp",
          localAgent: { clientId: "client-a", capabilities: [] }
        }
      );

      expect(ipc.ok && ipc.value.threads.map((thread) => thread.threadId)).toEqual(["th-human"]);
      expect(mcp.ok && mcp.value.threads.map((thread) => thread.threadId)).toEqual(["th-client-a"]);
    } finally {
      store.list.mockResolvedValue([sidecar]);
    }
  });

  test("interrupt delegates", async () => {
    await bus.dispatch("codex:sizzleChat:interrupt", { threadId: "th1" }, { principal: "ipc" });
    expect(controller.interrupt).toHaveBeenCalledWith("th1");
  });

  test("forkProjectChats delegates to the shared Sizzle controller", async () => {
    controller.forkThreadsForAnchor.mockClear();
    await forkProjectChats("source-project", "target-project");
    expect(controller.forkThreadsForAnchor).toHaveBeenCalledWith({
      sourceAnchorId: "source-project",
      targetAnchorId: "target-project"
    });
  });
});
