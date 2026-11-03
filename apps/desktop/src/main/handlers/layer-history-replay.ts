// IPC history uses reserved monotonic IDs. A committed receipt survives a lost
// response; ACK releases its payload, never its sequence watermark. The owner
// token is sealed to the admitted main-frame epoch, so lifecycle cleanup cannot
// make an old request valid in a new document.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BrowserWindow } from "electron";
import { z } from "zod";
import { BundleLayerNode, err, ok } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { fenceHotkeyRecorderDocument, isLiveHotkeyRecorderDocument } from "../hotkeys/hotkey-recorder-document";
import { getDb } from "../persistence/db";
import { getCaptureById } from "../persistence/captures-repo";
import { insertLayer, listLayerTree, loadLayer, rejectLayer } from "../persistence/layers-repo";
import { scheduleRepack } from "../persistence/bundle-store";
import { broadcastLayersChanged } from "./broadcast-layers";

export const MAX_HISTORY_RECEIPTS_PER_DOCUMENT = 128;
export const MAX_HISTORY_DOCUMENTS = 64;
export const MAX_HISTORY_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_LAYERS = 10_000;
const replayIdSchema = z.object({ owner: z.string().length(64), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const captureIdSchema = z.string().min(1).max(128);
const requestSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("reserve"), captureId: captureIdSchema, removeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{16}$/)).max(MAX_HISTORY_LAYERS).optional() }).strict(),
  z.object({
    phase: z.literal("apply"), captureId: captureIdSchema, replayId: replayIdSchema,
    restore: z.array(BundleLayerNode).max(MAX_HISTORY_LAYERS),
    removeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{16}$/)).max(MAX_HISTORY_LAYERS),
    expectedRejected: z.array(BundleLayerNode).max(MAX_HISTORY_LAYERS).optional(),
    expectedRemovals: z.array(BundleLayerNode).max(MAX_HISTORY_LAYERS).optional()
  }).strict()
]);
const ackSchema = z.object({ captureId: captureIdSchema, replayId: replayIdSchema }).strict();

type Receipt = { captureId: string; fingerprint: string | null; committed: boolean };
type Owner = { documentId: string; token: string; watermark: number; receipts: Map<number, Receipt>; dispose: () => void };

export function registerLayerHistoryReplayHandlers(): void {
  const secret = randomBytes(32);
  const owners = new Map<number, Owner>();
  const failure = (code: string, message: string) => err({ kind: "validation" as const, code, message });
  function ownerFor(ctx: CommandContext): Owner | null {
    if (ctx.principal !== "ipc" || ctx.sourceWindowId === undefined || ctx.sourceDocumentId === undefined) return null;
    const window = BrowserWindow.fromId(ctx.sourceWindowId);
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed() ||
      !isLiveHotkeyRecorderDocument(window.webContents.id, ctx.sourceDocumentId)) return null;
    const old = owners.get(window.id);
    if (old?.documentId === ctx.sourceDocumentId) return old;
    if (old !== undefined) old.dispose();
    if (owners.size >= MAX_HISTORY_DOCUMENTS) return null;
    const clear = (): void => {
      const owner = owners.get(window.id);
      if (owner?.token === token) {
        fenceHotkeyRecorderDocument(window.webContents.id);
        owner.dispose();
      }
    };
    const onNavigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) clear();
    };
    const token = createHmac("sha256", secret).update(JSON.stringify([window.id, ctx.sourceDocumentId])).digest("hex");
    const owner: Owner = {
      documentId: ctx.sourceDocumentId, token, watermark: 0, receipts: new Map(),
      dispose: () => {
        window.removeListener("closed", clear);
        window.webContents.removeListener("render-process-gone", clear);
        window.webContents.removeListener("did-start-navigation", onNavigation);
        owners.delete(window.id);
      }
    };
    window.on("closed", clear);
    window.webContents.on("render-process-gone", clear);
    window.webContents.on("did-start-navigation", onNavigation);
    owners.set(window.id, owner);
    return owner;
  }
  function snapshot(captureId: string) {
    const record = getCaptureById(captureId);
    if (record === null) throw new Error("history capture no longer exists");
    return { phase: "applied" as const, record, layers: listLayerTree(captureId) };
  }

  bus.register("layers:replayHistory", async (req, ctx) => {
    if (Buffer.byteLength(JSON.stringify(req)) > MAX_HISTORY_REQUEST_BYTES) {
      return failure("history_request_too_large", "history replay exceeds the request byte limit");
    }
    const parsed = requestSchema.safeParse(req);
    if (!parsed.success) return failure("invalid_history_replay", "invalid history replay request");
    const owner = ownerFor(ctx);
    if (owner === null) return failure("history_document_required", "history replay requires a live IPC main document");
    const input = parsed.data;
    const record = getCaptureById(input.captureId);
    if (record === null || record.bundle_format_version < 2) return failure("not_found", "v2 history capture not found");
    if (ctx.signal.aborted) return failure("history_cancelled", "history replay cancelled before commit");
    if (input.phase === "reserve") {
      if (owner.receipts.size >= MAX_HISTORY_RECEIPTS_PER_DOCUMENT || owner.watermark === Number.MAX_SAFE_INTEGER) {
        return failure("history_capacity", "acknowledge outstanding history before admitting another replay");
      }
      // Read the actual deletion pre-state, independently of history's desired
      // restore target. The renderer retains it, including across a lost apply
      // reply; the bounded receipt never retains layer snapshots.
      const requestedIds = input.removeIds ?? [];
      const live = new Map(listLayerTree(input.captureId).map((node) => [node.id, node]));
      const removals = requestedIds.flatMap((id) => live.get(id) ?? []);
      if (new Set(requestedIds).size !== requestedIds.length || removals.length !== requestedIds.length) {
        return failure("invalid_history_replay", "history removal requires distinct live layers in this capture");
      }
      const sequence = ++owner.watermark;
      owner.receipts.set(sequence, { captureId: input.captureId, fingerprint: null, committed: false });
      return ok({ phase: "reserved", replayId: { owner: owner.token, sequence }, removals });
    }
    if (input.replayId.owner !== owner.token) return failure("history_owner_mismatch", "history replay belongs to another document");
    const receipt = owner.receipts.get(input.replayId.sequence);
    if (receipt === undefined) return failure("history_replay_retired", "history replay was not reserved or has been acknowledged");
    if (receipt.captureId !== input.captureId) return failure("history_payload_mismatch", "history replay capture changed");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    if (receipt.fingerprint !== null && receipt.fingerprint !== fingerprint) return failure("history_payload_mismatch", "history replay payload changed");
    receipt.fingerprint = fingerprint;
    if (receipt.committed) return ok(snapshot(input.captureId));
    const ids = [...input.restore.map((layer) => layer.id), ...input.removeIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length || input.restore.some((layer) => layer.rejected_at !== null || layer.superseded_by !== null)) {
      return failure("invalid_history_replay", "history requires distinct live restore nodes and delete IDs");
    }
    const expectedRejected = input.expectedRejected ?? input.restore;
    const expectationsMatch = (nodes: BundleLayerNode[], expectedIds: string[]): boolean => {
      const ids = new Set(expectedIds);
      return nodes.length === ids.size && new Set(nodes.map((node) => node.id)).size === nodes.length &&
        nodes.every((node) => ids.has(node.id) && node.rejected_at === null && node.superseded_by === null);
    };
    if (!expectationsMatch(expectedRejected, input.restore.map((node) => node.id)) ||
      (input.expectedRemovals !== undefined && !expectationsMatch(input.expectedRemovals, input.removeIds))) {
      return failure("invalid_history_replay", "history conflict expectations must match their targets");
    }
    const rejectedById = new Map(expectedRejected.map((node) => [node.id, node]));
    try {
      const db = getDb();
      const result = db.transaction(() => {
        // Validate ownership of EVERY row before any write. insertLayer's
        // ordinary restore path does not change a row's capture_id.
        const find = db.prepare<[string], { capture_id: string; superseded_by: string | null }>("SELECT capture_id, superseded_by FROM layers WHERE id = ?");
        for (const id of ids) {
          const row = find.get(id);
          if (row === undefined || row.capture_id !== input.captureId || row.superseded_by !== null) throw new Error("history layer missing, superseded, or owned by another capture");
        }
        for (const expected of input.expectedRemovals ?? []) {
          if (!isDeepStrictEqual(loadLayer(expected.id), expected)) throw new Error("history delete conflicts with a changed live layer");
        }
        for (const node of input.restore) {
          const existing = loadLayer(node.id);
          if (existing.rejected_at !== null && !isDeepStrictEqual({ ...existing, rejected_at: null }, rejectedById.get(node.id))) {
            throw new Error("history restore conflicts with a changed rejected layer");
          }
          // A live collision still takes insertLayer's ordinary conflict path.
          insertLayer({ captureId: input.captureId, node });
        }
        for (const id of input.removeIds) rejectLayer(id);
        return snapshot(input.captureId);
      })();
      // No await between commit and receipt publication. Rejected responses
      // can be reconciled without reapplying any restore or cascading delete.
      receipt.committed = true;
      broadcastLayersChanged(input.captureId);
      scheduleRepack(input.captureId);
      return ok(result);
    } catch (cause) {
      return err({ kind: "persistence", code: "history_replay_failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
  });

  bus.register("layers:ackHistoryReplay", async (req, ctx) => {
    const parsed = ackSchema.safeParse(req);
    if (!parsed.success) return failure("invalid_history_ack", "invalid history acknowledgement");
    const owner = ownerFor(ctx);
    if (owner === null) return failure("history_document_required", "history acknowledgement requires a live IPC main document");
    if (req.replayId.owner !== owner.token) return failure("history_owner_mismatch", "history acknowledgement belongs to another document");
    if (req.replayId.sequence > owner.watermark) return failure("history_replay_unreserved", "cannot acknowledge a future replay");
    const receipt = owner.receipts.get(req.replayId.sequence);
    if (receipt !== undefined && receipt.captureId !== req.captureId) return failure("history_payload_mismatch", "history acknowledgement capture changed");
    owner.receipts.delete(req.replayId.sequence);
    // The watermark is retained. Duplicate/late ACK is harmless; a retired
    // sequence can never become a fresh mutation even after capacity frees.
    return ok(undefined);
  });
}
