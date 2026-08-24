import type {
  ChatApprovalDecision,
  ChatApprovalRequest,
  ChatApprovalResolvedEvent,
  ChatApprovalSupersededEvent,
  LibraryChatThreadStatus,
  LibraryChatThreadView,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";
import { err, ok } from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const MAX_TOMBSTONES = 256;

export type ChatApprovalOwner = object;
export type ChatApprovalResolver = (decision: ChatApprovalDecision) => Promise<void>;

type PendingEntry = {
  request: ChatApprovalRequest;
  owner: ChatApprovalOwner;
  resolve: ChatApprovalResolver;
  submission: {
    decision: ChatApprovalDecision;
    result: Promise<Result<void, PwrSnapError>>;
  } | null;
};

type Tombstone =
  | { kind: "resolved"; decision: ChatApprovalDecision }
  | { kind: "superseded"; reason: ChatApprovalSupersededEvent["reason"] };

type PostTerminalStatus = {
  status: LibraryChatThreadStatus;
  /** Destructive controller/thread closure stays idle until an explicit
   *  `openThread`; a late event from the retiring controller is not fresh. */
  sticky: boolean;
};

export type ChatApprovalBrokerOptions = {
  surface: "library" | "sizzle";
  emitResolved: (event: ChatApprovalResolvedEvent) => void;
  emitSuperseded: (event: ChatApprovalSupersededEvent) => void;
  /** Lets the surface publish a fresh decorated thread view after pending
   *  state changes. The callback is signal-only; the owner decides how to
   *  obtain the view without constructing a backend controller. */
  pendingChanged?: (threadId: string) => void;
  loggerScope: string;
};

function approvalKey(
  surface: "library" | "sizzle",
  request: Pick<ChatApprovalRequest, "threadId" | "turnId" | "approvalId">
): string {
  return JSON.stringify([surface, request.threadId, request.turnId, request.approvalId]);
}

function sameRequest(
  a: Pick<ChatApprovalRequest, "threadId" | "turnId" | "approvalId">,
  b: Pick<ChatApprovalRequest, "threadId" | "turnId" | "approvalId">
): boolean {
  return a.threadId === b.threadId && a.turnId === b.turnId && a.approvalId === b.approvalId;
}

/**
 * Main-process authority for user-facing chat approvals.
 *
 * The agent-client controller intentionally keeps its resolver private. The
 * broker therefore captures a closure bound to the exact controller that
 * emitted the request, retains the sanitized request across renderer/window
 * remounts, and only declares success after that closure acknowledges. Nothing
 * here is persisted: a backend promise cannot survive app restart.
 */
export class ChatApprovalBroker {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  /** A controller may be disposed before its async post-approval status event
   *  replaces a cached `awaiting_approval` view. Keep the truthful terminal
   *  fallback until a later non-awaiting producer view arrives. */
  private readonly postTerminalStatus = new Map<string, PostTerminalStatus>();
  private readonly closingOwners = new WeakSet<ChatApprovalOwner>();
  private readonly closingThreads = new Set<string>();
  private readonly log;

  constructor(private readonly options: ChatApprovalBrokerOptions) {
    this.log = getMainLogger(options.loggerScope);
  }

  /** Register a request before it is broadcast. Returns false for an already
   *  terminal/duplicate exact event, which callers must not re-broadcast. */
  register(
    request: ChatApprovalRequest,
    owner: ChatApprovalOwner,
    resolve: ChatApprovalResolver
  ): boolean {
    if (
      request.threadId.length === 0 ||
      request.turnId.length === 0 ||
      request.approvalId.length === 0
    ) {
      // agent-client 0.8.x can surface an empty turnId when a backend request
      // omits it. Such a request cannot round-trip through the strict exact-ID
      // response contract, so fail closed instead of displaying an approval
      // the user can never resolve.
      void resolve("deny").catch((cause: unknown) => {
        this.log.warn("failed to deny approval with incomplete identity", {
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
      return false;
    }
    const key = approvalKey(this.options.surface, request);
    if (
      this.tombstones.has(key) ||
      this.pending.has(key) ||
      this.closingOwners.has(owner) ||
      this.closingThreads.has(request.threadId)
    ) {
      // A duplicate/stale request must not strand a fresh backend callback.
      // Deny it on the originating controller, but never show it or reuse a
      // prior approval decision.
      void resolve("deny").catch((cause: unknown) => {
        this.log.warn("failed to deny stale approval callback", {
          threadId: request.threadId,
          turnId: request.turnId,
          approvalId: request.approvalId,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      });
      return false;
    }

    // The renderer contract presents one actionable request per thread. A new
    // exact request makes every older request for that thread stale. Deny an
    // unclaimed old request on its originating controller; never auto-approve.
    for (const [otherKey, entry] of this.pending) {
      if (entry.request.threadId !== request.threadId) continue;
      this.pending.delete(otherKey);
      this.addTombstone(otherKey, { kind: "superseded", reason: "request_replaced" });
      if (entry.submission === null) {
        void entry.resolve("deny").catch((cause: unknown) => {
          this.log.warn("failed to deny superseded approval", {
            threadId: entry.request.threadId,
            turnId: entry.request.turnId,
            approvalId: entry.request.approvalId,
            message: cause instanceof Error ? cause.message : String(cause)
          });
        });
      }
      this.emitSuperseded({
        threadId: entry.request.threadId,
        turnId: entry.request.turnId,
        approvalId: entry.request.approvalId,
        reason: "request_replaced"
      });
    }

    this.pending.set(key, { request, owner, resolve, submission: null });
    this.notifyPendingChanged(request.threadId);
    return true;
  }

  pendingForThread(threadId: string): ChatApprovalRequest | null {
    for (const entry of this.pending.values()) {
      if (entry.request.threadId === threadId) return entry.request;
    }
    return null;
  }

  decorateThread(view: LibraryChatThreadView): LibraryChatThreadView {
    const pendingApproval = this.pendingForThread(view.threadId);
    if (pendingApproval !== null) {
      return {
        ...view,
        pendingApproval,
        status: { kind: "awaiting_approval", approvalId: pendingApproval.approvalId }
      };
    }

    const fallback = this.postTerminalStatus.get(view.threadId);
    if (fallback?.sticky === true) {
      return { ...view, pendingApproval: null, status: fallback.status };
    }
    if (view.status.kind !== "awaiting_approval") {
      this.postTerminalStatus.delete(view.threadId);
      return { ...view, pendingApproval: null };
    }
    return {
      ...view,
      pendingApproval: null,
      // Never expose an impossible awaiting state without its exact request.
      // Successful responses resume the same turn; destructive lifecycle
      // closure leaves the thread idle.
      status: fallback?.status ?? { kind: "idle" }
    };
  }

  resolve(input: {
    threadId: string;
    turnId: string;
    approvalId: string;
    decision: ChatApprovalDecision;
  }): Promise<Result<void, PwrSnapError>> {
    const key = approvalKey(this.options.surface, input);
    const terminal = this.tombstones.get(key);
    if (terminal !== undefined) {
      if (terminal.kind === "resolved") {
        // Replay the terminal event as the idempotent acknowledgement. A
        // sibling window may have missed the first broadcast yet still hold
        // the exact old modal; Result success alone is intentionally not its
        // clearing authority.
        this.emitResolved({
          threadId: input.threadId,
          turnId: input.turnId,
          approvalId: input.approvalId,
          decision: terminal.decision
        });
      } else {
        this.emitSuperseded({
          threadId: input.threadId,
          turnId: input.turnId,
          approvalId: input.approvalId,
          reason: terminal.reason
        });
      }
      this.notifyPendingChanged(input.threadId);
      if (terminal.kind === "resolved" && terminal.decision === input.decision) {
        return Promise.resolve(ok(undefined));
      }
      return Promise.resolve(
        terminal.kind === "resolved"
          ? err({
              kind: "ai",
              code: "approval_already_resolved",
              message: "This approval was already answered with a different decision."
            })
          : this.staleResult("This approval request is no longer active.")
      );
    }

    const entry = this.pending.get(key);
    if (entry === undefined || !sameRequest(entry.request, input)) {
      return Promise.resolve(this.staleResult("This approval request is no longer active."));
    }
    if (entry.submission !== null) {
      if (entry.submission.decision === input.decision) return entry.submission.result;
      return Promise.resolve(
        err({
          kind: "ai",
          code: "approval_response_in_progress",
          message: "Another response to this approval is already being submitted."
        })
      );
    }

    const result = this.submit(key, entry, input.decision);
    entry.submission = { decision: input.decision, result };
    return result;
  }

  /** Safely retire every approval owned by a controller that is about to be
   *  replaced/closed. The deny closure is bound to that original controller. */
  async closeOwner(owner: ChatApprovalOwner): Promise<void> {
    this.closingOwners.add(owner);
    const entries = [...this.pending.entries()].filter(
      ([, entry]) => entry.owner === owner
    );
    for (const [, entry] of entries) {
      this.postTerminalStatus.set(entry.request.threadId, {
        status: { kind: "idle" },
        sticky: true
      });
    }
    await Promise.all(
      entries.map(([key, entry]) =>
        this.terminate(key, entry, "controller_disposed")
      )
    );
  }

  /** Safely retire a thread's approval before archive/interrupt/delete. */
  async closeThread(
    threadId: string,
    reason: ChatApprovalSupersededEvent["reason"] = "thread_closed"
  ): Promise<void> {
    this.closingThreads.add(threadId);
    this.postTerminalStatus.set(threadId, { status: { kind: "idle" }, sticky: true });
    const entries = [...this.pending.entries()].filter(
      ([, entry]) => entry.request.threadId === threadId
    );
    await Promise.all(entries.map(([key, entry]) => this.terminate(key, entry, reason)));
  }

  /** A later user turn/unarchive re-opens the thread after its prior turn was
   *  interrupted or archived. Controller-owner teardown remains permanent. */
  openThread(threadId: string): void {
    this.closingThreads.delete(threadId);
    // This is the only operation that admits producer status from a new turn
    // after destructive thread closure. A stale awaiting view still falls
    // back to idle because there is no matching broker request.
    this.postTerminalStatus.delete(threadId);
  }

  private async submit(
    key: string,
    entry: PendingEntry,
    decision: ChatApprovalDecision
  ): Promise<Result<void, PwrSnapError>> {
    try {
      await entry.resolve(decision);
    } catch (cause) {
      // Keep the exact request/actionable detail intact for retry. Never put
      // backend error text or tool arguments into the cross-process Result.
      if (this.pending.get(key) === entry) entry.submission = null;
      this.log.warn("approval response failed", {
        threadId: entry.request.threadId,
        turnId: entry.request.turnId,
        approvalId: entry.request.approvalId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
      return err({
        kind: "ai",
        code: "approval_response_failed",
        message: "PwrSnap could not send that response. The approval is still pending; try again or send Deny instead."
      });
    }

    // A superseding request/controller teardown may have retired this entry
    // while the response was in flight. In that case its terminal event is
    // already authoritative; do not clear or mutate the newer request.
    if (this.pending.get(key) !== entry) return ok(undefined);
    this.pending.delete(key);
    if (
      !this.closingThreads.has(entry.request.threadId) &&
      !this.closingOwners.has(entry.owner)
    ) {
      this.postTerminalStatus.set(entry.request.threadId, {
        status: { kind: "streaming", turnId: entry.request.turnId },
        sticky: false
      });
    }
    this.addTombstone(key, { kind: "resolved", decision });
    this.emitResolved({
      threadId: entry.request.threadId,
      turnId: entry.request.turnId,
      approvalId: entry.request.approvalId,
      decision
    });
    this.notifyPendingChanged(entry.request.threadId);
    return ok(undefined);
  }

  private async terminate(
    key: string,
    entry: PendingEntry,
    reason: ChatApprovalSupersededEvent["reason"]
  ): Promise<void> {
    if (this.pending.get(key) !== entry) return;

    if (entry.submission !== null) {
      await entry.submission.result;
      const current = this.pending.get(key);
      if (current !== entry) return;
    }

    this.pending.delete(key);
    this.postTerminalStatus.set(entry.request.threadId, {
      status: { kind: "idle" },
      sticky: true
    });
    this.addTombstone(key, { kind: "superseded", reason });
    try {
      await entry.resolve("deny");
    } catch (cause) {
      this.log.warn("failed to deny closing approval", {
        threadId: entry.request.threadId,
        turnId: entry.request.turnId,
        approvalId: entry.request.approvalId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
    this.emitSuperseded({
      threadId: entry.request.threadId,
      turnId: entry.request.turnId,
      approvalId: entry.request.approvalId,
      reason
    });
    this.notifyPendingChanged(entry.request.threadId);
  }

  private staleResult(message: string): Result<never, PwrSnapError> {
    return err({ kind: "ai", code: "approval_stale", message });
  }

  private emitResolved(event: ChatApprovalResolvedEvent): void {
    try {
      this.options.emitResolved(event);
    } catch (cause) {
      this.log.warn("approval resolved observer failed", {
        threadId: event.threadId,
        turnId: event.turnId,
        approvalId: event.approvalId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private emitSuperseded(event: ChatApprovalSupersededEvent): void {
    try {
      this.options.emitSuperseded(event);
    } catch (cause) {
      this.log.warn("approval superseded observer failed", {
        threadId: event.threadId,
        turnId: event.turnId,
        approvalId: event.approvalId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private notifyPendingChanged(threadId: string): void {
    try {
      this.options.pendingChanged?.(threadId);
    } catch (cause) {
      this.log.warn("approval pending observer failed", {
        threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }

  private addTombstone(key: string, tombstone: Tombstone): void {
    this.tombstones.set(key, tombstone);
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.tombstones.delete(oldest);
    }
  }
}
