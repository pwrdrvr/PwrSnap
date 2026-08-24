import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ChatMessage,
  ChatThreadSidecar,
  LibraryChatThreadView,
  PwrSnapError,
  Result
} from "@pwrsnap/shared";
import { err, ok } from "@pwrsnap/shared";
import type { CommandContext } from "../command-bus";
import { getMainLogger } from "../log";
import type { ChatThreadStore } from "./chat-thread-store";

export type ChatThreadSurface = "library" | "sizzle";
export type ChatThreadActor = { ownerClientId: string | null };

/** One exact owner interpretation for every chat verb. Human transports
 *  require NULL ownership; MCP requires its authenticated clientId. */
export function chatThreadActorFor(
  ctx: Pick<CommandContext, "principal" | "localAgent">
): Result<ChatThreadActor, PwrSnapError> {
  if (ctx.principal !== "mcp") return ok({ ownerClientId: null });
  const clientId = ctx.localAgent?.clientId;
  if (clientId === undefined || clientId.length === 0) {
    return err({
      kind: "permission",
      code: "thread_owner_missing",
      message: "This chat request has no authenticated local-client owner."
    });
  }
  return ok({ ownerClientId: clientId });
}

/** Stable producer-side mapping used by backend-independent list responses.
 *  It intentionally needs no controller/backend construction. */
export function chatThreadViewFromSidecar(sidecar: ChatThreadSidecar): LibraryChatThreadView {
  return {
    threadId: sidecar.threadId,
    name: sidecar.name,
    createdAt: sidecar.createdAt,
    modifiedAt: sidecar.modifiedAt,
    anchorCaptureId: sidecar.anchorCaptureId,
    archived: sidecar.archived,
    pinned: sidecar.pinned,
    lastMessagePreview: "",
    status: { kind: "idle" },
    provider: sidecar.provider,
    model: sidecar.model,
    reasoning: sidecar.reasoning,
    pendingApproval: null
  };
}

export function chatThreadBelongsToSurface(
  sidecar: Pick<ChatThreadSidecar, "anchorCaptureId">,
  surface: ChatThreadSurface
): boolean {
  const isSizzle = sidecar.anchorCaptureId?.startsWith("sz_") === true;
  return surface === "sizzle" ? isSizzle : !isSizzle;
}

/** Parse only the kit's persisted message journal entries. Unknown/future
 *  entries are ignored; tool/approval payloads are never exposed here. */
export function chatMessagesFromJournal(entries: readonly unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { kind?: unknown; message?: unknown };
    if (record.kind !== "message" || record.message === null || typeof record.message !== "object") {
      continue;
    }
    const message = record.message as {
      id?: unknown;
      role?: unknown;
      text?: unknown;
      createdAt?: unknown;
    };
    if (
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.text !== "string"
    ) {
      continue;
    }
    messages.push({
      id: message.id,
      role: message.role,
      content: [{ kind: "text", text: message.text }],
      status: "complete",
      createdAt:
        typeof message.createdAt === "number"
          ? new Date(message.createdAt).toISOString()
          : new Date(0).toISOString()
    });
  }
  return messages;
}

export type ChatThreadAccessOptions = {
  surface: ChatThreadSurface;
  store: () => ChatThreadStore;
  loggerScope: string;
};

/**
 * Centralized owner/surface authorization and fail-closed live-event routing.
 * The create AsyncLocalStorage lets ThreadStoreAdapter put ownership in the
 * initial INSERT before the controller's first synchronous broadcast.
 */
export class ChatThreadAccess {
  private readonly createOwner = new AsyncLocalStorage<string | null>();
  private readonly knownOwners = new Map<string, string | null>();
  private readonly knownSidecars = new Map<string, ChatThreadSidecar>();
  private readonly liveViews = new Map<string, LibraryChatThreadView>();
  private readonly log;

  constructor(private readonly options: ChatThreadAccessOptions) {
    this.log = getMainLogger(options.loggerScope);
  }

  actorFor(ctx: Pick<CommandContext, "principal" | "localAgent">): Result<ChatThreadActor, PwrSnapError> {
    return chatThreadActorFor(ctx);
  }

  runCreate<T>(ownerClientId: string | null, task: () => Promise<T>): Promise<T> {
    return this.createOwner.run(ownerClientId, task);
  }

  ownerClientIdForCreate(): string | null {
    return this.createOwner.getStore() ?? null;
  }

  onThreadCreated(sidecar: ChatThreadSidecar): void {
    this.remember(sidecar);
  }

  async list(
    ctx: Pick<CommandContext, "principal" | "localAgent">,
    opts: { includeArchived?: boolean; anchorCaptureId?: string | null } = {}
  ): Promise<Result<ChatThreadSidecar[], PwrSnapError>> {
    const actor = this.actorFor(ctx);
    if (!actor.ok) return actor;
    try {
      const sidecars = await this.options.store().list(opts);
      const visible = sidecars.filter(
        (sidecar) =>
          chatThreadBelongsToSurface(sidecar, this.options.surface) &&
          sidecar.ownerClientId === actor.value.ownerClientId
      );
      for (const sidecar of visible) this.remember(sidecar);
      return ok(visible);
    } catch (cause) {
      return this.storeFailure("list", cause);
    }
  }

  async require(
    threadId: string,
    ctx: Pick<CommandContext, "principal" | "localAgent">
  ): Promise<Result<ChatThreadSidecar, PwrSnapError>> {
    const actor = this.actorFor(ctx);
    if (!actor.ok) return actor;
    let sidecar: ChatThreadSidecar | null;
    try {
      sidecar = await this.options.store().get(threadId);
    } catch (cause) {
      return this.storeFailure("read", cause);
    }
    if (sidecar === null) {
      return err({
        kind: "ai",
        code: "thread_not_found",
        message: "This chat thread could not be reopened."
      });
    }
    if (!chatThreadBelongsToSurface(sidecar, this.options.surface)) {
      return err({
        kind: "permission",
        code: "thread_surface_mismatch",
        message: "This chat belongs to a different PwrSnap surface."
      });
    }
    if (sidecar.ownerClientId !== actor.value.ownerClientId) {
      return err({
        kind: "permission",
        code: "thread_owner_mismatch",
        message: "This chat belongs to another user or local client."
      });
    }
    this.remember(sidecar);
    return ok(sidecar);
  }

  async history(
    sidecar: ChatThreadSidecar
  ): Promise<Result<ChatMessage[], PwrSnapError>> {
    try {
      const entries = await this.options.store().readJournal(sidecar.threadId);
      return ok(chatMessagesFromJournal(entries));
    } catch (cause) {
      return this.storeFailure("history", cause);
    }
  }

  /** Observe the truthful producer view before routing it. Unknown ownership
   *  remains unknown/fail-closed; this never promotes an event to human. */
  observeThreadView(view: LibraryChatThreadView): void {
    this.liveViews.set(view.threadId, view);
    const sidecar = this.knownSidecars.get(view.threadId);
    if (sidecar !== undefined) {
      // Controller update events are producer-truth for mutable row fields.
      // Preserve the authenticated owner and journal-only metadata while
      // keeping pendingChanged rebroadcasts from reverting rename/archive or
      // anchor changes to an older cached sidecar.
      this.knownSidecars.set(view.threadId, {
        ...sidecar,
        name: view.name,
        createdAt: view.createdAt,
        modifiedAt: view.modifiedAt,
        anchorCaptureId: view.anchorCaptureId,
        archived: view.archived,
        pinned: view.pinned,
        provider: view.provider,
        model: view.model,
        reasoning: view.reasoning
      });
    }
  }

  viewFor(sidecar: ChatThreadSidecar): LibraryChatThreadView {
    const live = this.liveViews.get(sidecar.threadId);
    return {
      ...(live ?? chatThreadViewFromSidecar(sidecar)),
      name: sidecar.name,
      createdAt: sidecar.createdAt,
      modifiedAt: sidecar.modifiedAt,
      anchorCaptureId: sidecar.anchorCaptureId,
      archived: sidecar.archived,
      pinned: sidecar.pinned,
      provider: sidecar.provider,
      model: sidecar.model,
      reasoning: sidecar.reasoning
    };
  }

  /** Synchronous router used by controller callbacks. Unknown, MCP-owned, or
   *  cross-surface ids are dropped; commands/list prime the cache first. */
  shouldBroadcastToHuman(threadId: string): boolean {
    if (!this.knownOwners.has(threadId) || this.knownOwners.get(threadId) !== null) return false;
    const sidecar = this.knownSidecars.get(threadId);
    return sidecar !== undefined && chatThreadBelongsToSurface(sidecar, this.options.surface);
  }

  /** Return the best current view only for a known human-owned thread. Used
   *  by main-owned transient lifecycle state to rebroadcast a reconciled row
   *  without a store read or backend/controller construction. */
  humanViewForThread(threadId: string): LibraryChatThreadView | null {
    if (!this.shouldBroadcastToHuman(threadId)) return null;
    const sidecar = this.knownSidecars.get(threadId);
    return sidecar === undefined ? null : this.viewFor(sidecar);
  }

  forget(threadId: string): void {
    this.knownOwners.delete(threadId);
    this.knownSidecars.delete(threadId);
    this.liveViews.delete(threadId);
  }

  private remember(sidecar: ChatThreadSidecar): void {
    this.knownOwners.set(sidecar.threadId, sidecar.ownerClientId);
    this.knownSidecars.set(sidecar.threadId, sidecar);
  }

  private storeFailure(operation: string, cause: unknown): Result<never, PwrSnapError> {
    this.log.warn("chat thread store operation failed", {
      operation,
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return err({
      kind: "persistence",
      code: "chat_store_unavailable",
      message: "PwrSnap could not read the chat library. Try again."
    });
  }
}
