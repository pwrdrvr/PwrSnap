import { describe, expect, it, vi } from "vitest";
import type {
  ChatApprovalRequest,
  ChatApprovalResolvedEvent,
  ChatApprovalSupersededEvent,
  LibraryChatThreadView
} from "@pwrsnap/shared";
import { ChatApprovalBroker } from "../chat-approval-broker";

function approval(
  overrides: Partial<ChatApprovalRequest> = {}
): ChatApprovalRequest {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    approvalId: "approval-1",
    summary: "Run a command",
    detail: "npm test",
    ...overrides
  };
}

function threadView(
  overrides: Partial<LibraryChatThreadView> = {}
): LibraryChatThreadView {
  return {
    threadId: "thread-1",
    name: "Chat",
    createdAt: "2026-08-23T00:00:00.000Z",
    modifiedAt: "2026-08-23T00:00:00.000Z",
    anchorCaptureId: null,
    archived: false,
    pinned: false,
    lastMessagePreview: "",
    status: { kind: "streaming", turnId: "turn-1" },
    provider: "codex",
    model: "gpt-5.6",
    reasoning: "high",
    pendingApproval: null,
    ...overrides
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (cause?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function harness() {
  const resolved: ChatApprovalResolvedEvent[] = [];
  const superseded: ChatApprovalSupersededEvent[] = [];
  const pendingChanged = vi.fn();
  const broker = new ChatApprovalBroker({
    surface: "library",
    loggerScope: "test:chat-approval-broker",
    emitResolved: (event) => resolved.push(event),
    emitSuperseded: (event) => superseded.push(event),
    pendingChanged
  });
  return { broker, resolved, superseded, pendingChanged };
}

describe("ChatApprovalBroker", () => {
  it("fails closed when a backend request has no exact turn identity", async () => {
    const { broker, resolved, superseded } = harness();
    const request = approval({ turnId: "" });
    const resolver = vi.fn(async () => undefined);

    expect(broker.register(request, {}, resolver)).toBe(false);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledWith("deny"));
    expect(broker.pendingForThread(request.threadId)).toBeNull();
    expect(resolved).toEqual([]);
    expect(superseded).toEqual([]);
  });

  it("replays the exact pending request in a decorated thread and resolves it once", async () => {
    const { broker, resolved, pendingChanged } = harness();
    const request = approval();
    const owner = {};
    const resolver = vi.fn(async () => undefined);

    expect(broker.register(request, owner, resolver)).toBe(true);
    expect(broker.pendingForThread(request.threadId)).toBe(request);
    expect(broker.decorateThread(threadView())).toMatchObject({
      status: { kind: "awaiting_approval", approvalId: request.approvalId },
      pendingApproval: request
    });

    const result = await broker.resolve({ ...request, decision: "approve" });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("approve");
    expect(resolved).toEqual([
      {
        threadId: request.threadId,
        turnId: request.turnId,
        approvalId: request.approvalId,
        decision: "approve"
      }
    ]);
    expect(broker.pendingForThread(request.threadId)).toBeNull();
    expect(pendingChanged.mock.calls).toEqual([
      [request.threadId],
      [request.threadId]
    ]);
    expect(
      broker.decorateThread(
        threadView({
          status: { kind: "awaiting_approval", approvalId: request.approvalId },
          pendingApproval: request
        })
      )
    ).toMatchObject({
      status: { kind: "streaming", turnId: request.turnId },
      pendingApproval: null
    });
  });

  it("keeps the exact request pending after resolver failure and allows retry", async () => {
    const { broker, resolved } = harness();
    const request = approval({ detail: "sensitive existing chat detail" });
    const resolver = vi
      .fn<(decision: "approve" | "reject-layer" | "reject-run" | "deny") => Promise<void>>()
      .mockRejectedValueOnce(new Error("backend leaked secret: abc123"))
      .mockResolvedValueOnce(undefined);
    broker.register(request, {}, resolver);

    const failed = await broker.resolve({ ...request, decision: "approve" });

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("approval_response_failed");
      expect(failed.error.message).not.toContain("abc123");
      expect(failed.error.message).not.toContain(request.detail);
    }
    expect(broker.pendingForThread(request.threadId)).toBe(request);
    expect(resolved).toEqual([]);

    const retried = await broker.resolve({ ...request, decision: "deny" });
    expect(retried.ok).toBe(true);
    expect(resolver.mock.calls).toEqual([["approve"], ["deny"]]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.decision).toBe("deny");
  });

  it("coalesces duplicate same-decision submissions into one resolver call", async () => {
    const { broker, resolved } = harness();
    const request = approval();
    const gate = deferred<void>();
    const resolver = vi.fn(() => gate.promise);
    broker.register(request, {}, resolver);

    const first = broker.resolve({ ...request, decision: "approve" });
    const duplicate = broker.resolve({ ...request, decision: "approve" });

    expect(duplicate).toBe(first);
    expect(resolver).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    await expect(first).resolves.toEqual({ ok: true, value: undefined });
    await expect(duplicate).resolves.toEqual({ ok: true, value: undefined });
    expect(resolved).toHaveLength(1);
  });

  it("rejects a conflicting decision while an exact response is submitting", async () => {
    const { broker } = harness();
    const request = approval();
    const gate = deferred<void>();
    const resolver = vi.fn(() => gate.promise);
    broker.register(request, {}, resolver);

    const approve = broker.resolve({ ...request, decision: "approve" });
    const deny = await broker.resolve({ ...request, decision: "deny" });

    expect(deny.ok).toBe(false);
    if (!deny.ok) expect(deny.error.code).toBe("approval_response_in_progress");
    expect(resolver).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    await approve;
  });

  it("tombstones terminal tuples for idempotent duplicate and stale/conflicting responses", async () => {
    const { broker, resolved } = harness();
    const request = approval();
    const resolver = vi.fn(async () => undefined);
    broker.register(request, {}, resolver);
    await broker.resolve({ ...request, decision: "approve" });

    await expect(broker.resolve({ ...request, decision: "approve" })).resolves.toEqual({
      ok: true,
      value: undefined
    });
    const conflict = await broker.resolve({ ...request, decision: "deny" });
    const unknown = await broker.resolve({
      ...request,
      approvalId: "approval-never-registered",
      decision: "deny"
    });

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("approval_already_resolved");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("approval_stale");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveLength(3);
    expect(resolved.every((event) => event.decision === "approve")).toBe(true);
  });

  it("emits terminal authority when a stale renderer outlives bounded tombstone retention", async () => {
    const { broker, superseded } = harness();
    const requests = Array.from({ length: 257 }, (_, index) =>
      approval({
        threadId: `thread-retention-${index}`,
        turnId: `turn-retention-${index}`,
        approvalId: `approval-retention-${index}`
      })
    );

    for (const request of requests) {
      expect(broker.register(request, {}, async () => undefined)).toBe(true);
      await expect(
        broker.resolve({ ...request, decision: "approve" })
      ).resolves.toEqual({ ok: true, value: undefined });
    }

    const evicted = requests[0]!;
    const stale = await broker.resolve({ ...evicted, decision: "approve" });

    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("approval_stale");
    expect(superseded.at(-1)).toEqual({
      threadId: evicted.threadId,
      turnId: evicted.turnId,
      approvalId: evicted.approvalId,
      reason: "request_stale"
    });

    // Once terminalized again, a repeated stale click replays the same exact
    // clearing event instead of becoming an uncloseable retry loop.
    const repeated = await broker.resolve({ ...evicted, decision: "deny" });
    expect(repeated.ok).toBe(false);
    if (!repeated.ok) expect(repeated.error.code).toBe("approval_stale");
    expect(superseded.at(-1)).toMatchObject({
      approvalId: evicted.approvalId,
      reason: "request_stale"
    });
  });

  it("supersedes an older exact request without clearing the newer request", async () => {
    const { broker, resolved, superseded } = harness();
    const oldRequest = approval();
    const newRequest = approval({ turnId: "turn-2", approvalId: "approval-2" });
    const oldGate = deferred<void>();
    const oldResolver = vi.fn(() => oldGate.promise);
    const newResolver = vi.fn(async () => undefined);
    broker.register(oldRequest, {}, oldResolver);

    const oldSubmission = broker.resolve({ ...oldRequest, decision: "approve" });
    expect(broker.register(newRequest, {}, newResolver)).toBe(true);

    expect(superseded).toEqual([
      {
        threadId: oldRequest.threadId,
        turnId: oldRequest.turnId,
        approvalId: oldRequest.approvalId,
        reason: "request_replaced"
      }
    ]);
    expect(broker.pendingForThread(newRequest.threadId)).toBe(newRequest);

    oldGate.resolve(undefined);
    await expect(oldSubmission).resolves.toEqual({ ok: true, value: undefined });
    expect(broker.pendingForThread(newRequest.threadId)).toBe(newRequest);
    expect(resolved).toEqual([]);

    const staleOld = await broker.resolve({ ...oldRequest, decision: "approve" });
    expect(staleOld.ok).toBe(false);
    if (!staleOld.ok) expect(staleOld.error.code).toBe("approval_stale");

    await broker.resolve({ ...newRequest, decision: "deny" });
    expect(newResolver).toHaveBeenCalledWith("deny");
    expect(resolved.map((event) => event.approvalId)).toEqual([newRequest.approvalId]);
  });

  it("safe-denies only approvals owned by a closing controller, then a closing thread", async () => {
    const { broker, superseded } = harness();
    const ownerA = {};
    const ownerB = {};
    const requestA1 = approval({ threadId: "thread-a1", approvalId: "approval-a1" });
    const requestA2 = approval({ threadId: "thread-a2", approvalId: "approval-a2" });
    const requestB = approval({ threadId: "thread-b", approvalId: "approval-b" });
    const resolverA1 = vi.fn(async () => undefined);
    const resolverA2 = vi.fn(async () => undefined);
    const resolverB = vi.fn(async () => undefined);
    broker.register(requestA1, ownerA, resolverA1);
    broker.register(requestA2, ownerA, resolverA2);
    broker.register(requestB, ownerB, resolverB);

    await broker.closeOwner(ownerA);

    expect(resolverA1).toHaveBeenCalledWith("deny");
    expect(resolverA2).toHaveBeenCalledWith("deny");
    expect(resolverB).not.toHaveBeenCalled();
    expect(broker.pendingForThread(requestA1.threadId)).toBeNull();
    expect(broker.pendingForThread(requestA2.threadId)).toBeNull();
    expect(broker.pendingForThread(requestB.threadId)).toBe(requestB);
    expect(superseded.filter((event) => event.reason === "controller_disposed")).toHaveLength(2);
    expect(
      broker.decorateThread(
        threadView({
          threadId: requestA1.threadId,
          status: { kind: "awaiting_approval", approvalId: requestA1.approvalId },
          pendingApproval: requestA1
        })
      )
    ).toMatchObject({ status: { kind: "idle" }, pendingApproval: null });
    expect(
      broker.decorateThread(
        threadView({
          threadId: requestA1.threadId,
          status: { kind: "streaming", turnId: requestA1.turnId }
        })
      )
    ).toMatchObject({ status: { kind: "idle" }, pendingApproval: null });

    await broker.closeThread(requestB.threadId);

    expect(resolverB).toHaveBeenCalledWith("deny");
    expect(broker.pendingForThread(requestB.threadId)).toBeNull();
    expect(superseded.at(-1)).toMatchObject({
      approvalId: requestB.approvalId,
      reason: "thread_closed"
    });
  });

  it("keeps destructive thread closure idle when an in-flight response wins the race", async () => {
    const { broker } = harness();
    const request = approval();
    const gate = deferred<void>();
    broker.register(request, {}, () => gate.promise);

    const submission = broker.resolve({ ...request, decision: "approve" });
    const closure = broker.closeThread(request.threadId);
    gate.resolve(undefined);
    await Promise.all([submission, closure]);

    expect(
      broker.decorateThread(
        threadView({ status: { kind: "streaming", turnId: request.turnId } })
      )
    ).toMatchObject({ status: { kind: "idle" }, pendingApproval: null });

    broker.openThread(request.threadId);
    expect(
      broker.decorateThread(
        threadView({ status: { kind: "streaming", turnId: "turn-2" } })
      )
    ).toMatchObject({ status: { kind: "streaming", turnId: "turn-2" } });
  });

  it("retires and broadcasts synchronously while an approval resolver is stuck", () => {
    const { broker, superseded } = harness();
    const request = approval({ approvalId: "approval-stuck" });
    broker.register(request, {}, () => new Promise<void>(() => undefined));
    void broker.resolve({ ...request, decision: "approve" });

    broker.closeThread(request.threadId);

    expect(broker.pendingForThread(request.threadId)).toBeNull();
    expect(superseded).toContainEqual({
      threadId: request.threadId,
      turnId: request.turnId,
      approvalId: request.approvalId,
      reason: "thread_closed"
    });
    expect(
      broker.decorateThread(
        threadView({ status: { kind: "awaiting_approval", approvalId: request.approvalId } })
      )
    ).toMatchObject({ status: { kind: "idle" }, pendingApproval: null });
  });

  it("denies and suppresses late requests after their owner or thread has closed", async () => {
    const { broker, resolved, superseded } = harness();
    const owner = {};
    await broker.closeOwner(owner);
    const lateOwnerRequest = approval({ approvalId: "approval-after-owner-close" });
    const lateOwnerResolver = vi.fn(async () => undefined);

    expect(broker.register(lateOwnerRequest, owner, lateOwnerResolver)).toBe(false);
    await vi.waitFor(() => expect(lateOwnerResolver).toHaveBeenCalledWith("deny"));
    expect(broker.pendingForThread(lateOwnerRequest.threadId)).toBeNull();

    const closedThreadId = "closed-thread";
    await broker.closeThread(closedThreadId);
    const lateThreadRequest = approval({
      threadId: closedThreadId,
      approvalId: "approval-after-thread-close"
    });
    const lateThreadResolver = vi.fn(async () => undefined);

    expect(broker.register(lateThreadRequest, {}, lateThreadResolver)).toBe(false);
    await vi.waitFor(() => expect(lateThreadResolver).toHaveBeenCalledWith("deny"));
    expect(broker.pendingForThread(closedThreadId)).toBeNull();
    expect(resolved).toEqual([]);
    expect(superseded).toEqual([]);
  });
});
