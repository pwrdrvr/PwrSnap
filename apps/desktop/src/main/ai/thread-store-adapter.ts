// Adapter: implements the @pwrdrvr/agent-core `ThreadStore` interface over
// PwrSnap's existing `ChatThreadStore` (SQLite index + on-disk journal +
// attachments) and `saveAiThreadUsage` accounting.
//
// The kit's `ThreadStore` was modeled on PwrSnap's `ChatThreadStore`, so the
// mapping is near-1:1. The only real translation is the type rename:
//   • kit `NormalizedThreadRecord`  ↔  PwrSnap `ChatThreadSidecar`
//       anchorId      ↔  anchorCaptureId
//       anchorHistory ↔  focusHistory  (NormalizedAnchorEntry.anchorId ↔ ChatFocusEntry.captureId)
//   • kit `appendAnchor`            →  PwrSnap `appendFocus` (+ sets anchor)
//   • kit `recordUsage`            →  `estimateAiUsageCost` + `saveAiThreadUsage`
//       carrying contextWindow → modelContextWindow (the kit now provides it).
//
// The journal API (`journalAppend` / `readJournal`) and `attachmentsDir` /
// `prepareThreadDir` / `discardPreparedThreadDir` / `create` / `list` / `get` /
// `update` / `delete` pass straight through.

import type {
  NormalizedThreadRecord,
  NormalizedUsageRecord,
  PreparedThreadDir,
  ThreadCreateOptions,
  ThreadListOptions,
  ThreadStore,
  ThreadUpdatePatch
} from "@pwrdrvr/agent-core";
import type { AiUsageThreadSurface, ChatThreadSidecar } from "@pwrsnap/shared";
import type { ChatThreadStore, PreparedChatThreadDir } from "./chat-thread-store";
import { estimateAiUsageCost } from "./ai-usage-cost";
import { saveAiThreadUsage } from "../persistence/ai-usage-repo";
import { getMainLogger } from "../log";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import { BrowserWindow } from "electron";

const log = getMainLogger("pwrsnap:thread-store-adapter");

export type ThreadStoreAdapterOptions = {
  store: ChatThreadStore;
  /** Usage-accounting surface. Omit to disable usage recording (tests). */
  usageSurface?: AiUsageThreadSurface;
};

/** Map a PwrSnap `ChatThreadSidecar` (DB row shape) to the kit's neutral
 *  `NormalizedThreadRecord`. */
function sidecarToRecord(sidecar: ChatThreadSidecar): NormalizedThreadRecord {
  return {
    threadId: sidecar.threadId,
    name: sidecar.name,
    createdAt: sidecar.createdAt,
    modifiedAt: sidecar.modifiedAt,
    anchorId: sidecar.anchorCaptureId,
    anchorHistory: sidecar.focusHistory.map((entry) => ({
      anchorId: entry.captureId,
      at: entry.at
    })),
    archived: sidecar.archived,
    pinned: sidecar.pinned
  };
}

/** PwrSnap's `PreparedChatThreadDir` carries a `dirName`; the kit's
 *  `PreparedThreadDir` carries only `{ threadId?, path }`. We round-trip the
 *  `dirName` through a parallel map keyed by path so the prepared dir handed
 *  back at `create()` time still resolves to the right on-disk directory. */
export class ThreadStoreAdapter implements ThreadStore {
  private readonly store: ChatThreadStore;
  private readonly usageSurface: AiUsageThreadSurface | undefined;
  /** Bridges the kit's path-only PreparedThreadDir back to PwrSnap's
   *  dirName-carrying handle, so `create({ preparedDir })` reuses the dir
   *  minted by `prepareThreadDir` instead of minting a second one. */
  private readonly preparedByPath = new Map<string, PreparedChatThreadDir>();

  constructor(options: ThreadStoreAdapterOptions) {
    this.store = options.store;
    this.usageSurface = options.usageSurface;
  }

  async prepareThreadDir(name: string): Promise<PreparedThreadDir> {
    const prepared = await this.store.prepareThreadDir(name);
    this.preparedByPath.set(prepared.path, prepared);
    return { path: prepared.path };
  }

  async discardPreparedThreadDir(prepared: PreparedThreadDir): Promise<void> {
    const native = this.preparedByPath.get(prepared.path);
    this.preparedByPath.delete(prepared.path);
    await this.store.discardPreparedThreadDir(native ?? { dirName: "", path: prepared.path });
  }

  async create(opts: ThreadCreateOptions): Promise<NormalizedThreadRecord> {
    const native =
      opts.preparedDir !== undefined ? this.preparedByPath.get(opts.preparedDir.path) : undefined;
    if (opts.preparedDir !== undefined) {
      this.preparedByPath.delete(opts.preparedDir.path);
    }
    const sidecar = await this.store.create({
      threadId: opts.threadId,
      name: opts.name,
      anchorCaptureId: opts.anchorId ?? null,
      ...(native !== undefined ? { preparedDir: native } : {})
    });
    return sidecarToRecord(sidecar);
  }

  async list(opts: ThreadListOptions = {}): Promise<NormalizedThreadRecord[]> {
    const sidecars = await this.store.list({
      includeArchived: opts.includeArchived ?? false,
      ...(opts.anchorId !== undefined ? { anchorCaptureId: opts.anchorId } : {})
    });
    return sidecars.map(sidecarToRecord);
  }

  async get(threadId: string): Promise<NormalizedThreadRecord | null> {
    const sidecar = await this.store.get(threadId);
    return sidecar === null ? null : sidecarToRecord(sidecar);
  }

  async update(threadId: string, patch: ThreadUpdatePatch): Promise<NormalizedThreadRecord> {
    const sidecar = await this.store.update(threadId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {})
    });
    return sidecarToRecord(sidecar);
  }

  async delete(threadId: string): Promise<void> {
    await this.store.delete(threadId);
  }

  async appendAnchor(threadId: string, anchorId: string): Promise<void> {
    // PwrSnap stores the current anchor + a focus-history entry separately:
    // `update({ anchorCaptureId })` sets the current anchor, `appendFocus`
    // pushes the history entry. The kit's single `appendAnchor` does both.
    await this.store.update(threadId, { anchorCaptureId: anchorId });
    await this.store.appendFocus(threadId, anchorId);
  }

  async journalAppend(threadId: string, entry: unknown): Promise<void> {
    await this.store.journalAppend(threadId, entry);
  }

  async readJournal(threadId: string): Promise<unknown[]> {
    return this.store.readJournal(threadId);
  }

  async attachmentsDir(threadId: string): Promise<string> {
    return this.store.attachmentsDir(threadId);
  }

  async recordUsage(record: NormalizedUsageRecord): Promise<void> {
    if (this.usageSurface === undefined) return;
    const sidecar = await this.store.get(record.threadId);
    if (sidecar === null) return;
    const usage = record.usage;
    // The kit's NormalizedTokenUsage is flat + optional; PwrSnap's
    // AiUsageTokenBreakdown is flat + required. Build it, carrying
    // contextWindow → modelContextWindow (the kit now provides it).
    const tokens = {
      totalTokens: usage.totalTokens ?? 0,
      inputTokens: usage.inputTokens ?? 0,
      cachedInputTokens: usage.cachedInputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
      modelContextWindow: record.contextWindow ?? usage.contextWindow ?? null
    };
    const model = record.model ?? null;
    const meta = this.threadModelMeta.get(record.threadId);
    const modelProvider = meta?.modelProvider ?? null;
    const serviceTier = meta?.serviceTier ?? null;
    saveAiThreadUsage({
      threadId: record.threadId,
      surface: this.usageSurface,
      anchorId: sidecar.anchorCaptureId,
      name: sidecar.name,
      turnId: record.turnId,
      model,
      modelProvider,
      serviceTier,
      usageStatus: "available",
      usageUnavailableReason: null,
      tokens,
      cost: estimateAiUsageCost({
        model,
        provider: modelProvider,
        serviceTier,
        tokens
      })
    });
    this.broadcastUsageUpdated(record.threadId, record.turnId);
  }

  // The kit's NormalizedUsageRecord carries `model` but not provider /
  // serviceTier. PwrSnap's usage row + cost estimate persist all three.
  // The kit controller learns provider + tier from `thread/start` +
  // `thread/settings/updated` but only forwards `model` on recordUsage, so
  // the handler tees the backend's `thread_settings` events into this
  // per-thread map (keyed by threadId) and the adapter reads it back when a
  // turn's usage lands. Cost estimation tolerates a missing provider/tier
  // (it defaults provider to "openai" and matches null tiers), so this is a
  // persisted-metadata nicety, not a correctness dependency.
  private readonly threadModelMeta = new Map<
    string,
    { modelProvider: string | null; serviceTier: string | null }
  >();

  /** Record the provider / service tier the backend reported for a thread,
   *  so usage rows persist them (the kit's recordUsage carries only model). */
  setThreadModelMeta(
    threadId: string,
    meta: { modelProvider: string | null; serviceTier: string | null }
  ): void {
    this.threadModelMeta.set(threadId, meta);
  }

  private broadcastUsageUpdated(threadId: string, turnId: string): void {
    if (this.usageSurface === undefined) return;
    const surface = this.usageSurface;
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send(EVENT_CHANNELS.aiUsageUpdated, {
          subjectKind: "thread",
          threadId,
          threadSurface: surface,
          turnId
        });
      }
    } catch (cause) {
      log.warn("ai usage updated broadcast failed", {
        threadId,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
}
