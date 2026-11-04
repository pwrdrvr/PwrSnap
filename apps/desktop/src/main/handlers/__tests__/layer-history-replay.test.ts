// Main-side history admission, identity, retirement and lifecycle invariants
// against real SQLite. Renderer lost-response tests cover the complete chain.
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";

let testDb: Database.Database;
let documentCounter = 0;
let sourceDocumentId: string;
let destroyed: boolean;
let liveWindow: EventEmitter & { id: number; isDestroyed: () => boolean; webContents: EventEmitter & { id: number; isDestroyed: () => boolean } };
vi.mock("electron", () => ({ BrowserWindow: { fromId: (id: number) => id === 7 ? liveWindow : null } }));
vi.mock("../../persistence/db", () => ({ getDb: () => testDb }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}));
const publications = vi.fn();
const repacks = vi.fn();
vi.mock("../../handlers/broadcast-layers", () => ({
  broadcastLayersChanged: (...args: unknown[]) => publications(...args)
}));
vi.mock("../../persistence/bundle-store", () => ({
  scheduleRepack: (...args: unknown[]) => repacks(...args)
}));
const { admitHotkeyRecorderDocument } = await import("../../hotkeys/hotkey-recorder-document");
const { bus } = await import("../../command-bus");
const { registerLayersHandlers } = await import("../../handlers/layers-handlers");
const { insertLayer, rejectLayer, updateLayer } = await import("../../persistence/layers-repo");
registerLayersHandlers();

const captureId = "history_fixture";
function node(label: string, zIndex: number): BundleLayerNode {
  return {
    id: label.padEnd(16, "_"), parent_id: null, kind: "vector",
    shape: { kind: "arrow", from: { x: 0.1, y: 0.2 }, to: { x: 0.8, y: 0.9 }, color: "auto" },
    name: label, visible: true, locked: false, opacity: 1, blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0], z_index: zIndex, source: "user", ai_run_id: null,
    applied_at: "2026-05-24T12:00:00.000Z", rejected_at: null, superseded_by: null,
    created_at: "2026-05-24T12:00:00.000Z"
  };
}
const a = node("A", 1000);
const b = node("B", 2000);
const c = node("C", 3000);
const d = node("D", 4000);
beforeEach(async () => {
  destroyed = false;
  sourceDocumentId = `history_doc_${++documentCounter}`.padEnd(20, "_");
  liveWindow = Object.assign(new EventEmitter(), {
    id: 7, isDestroyed: () => destroyed,
    webContents: Object.assign(new EventEmitter(), { id: 70, isDestroyed: () => destroyed })
  });
  const { allowNextHotkeyRecorderDocument } = await import("../../hotkeys/hotkey-recorder-document");
  allowNextHotkeyRecorderDocument(70);
  admitHotkeyRecorderDocument(70, sourceDocumentId);
  testDb = new Database(":memory:");
  const dir = resolve("apps/desktop/src/main/persistence/migrations");
  testDb.pragma("foreign_keys = OFF");
  for (const file of readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    testDb.exec(readFileSync(join(dir, file), "utf8"));
  }
  testDb.pragma("foreign_keys = ON");
  testDb.prepare(`INSERT INTO captures (id, kind, captured_at, bundle_format_version,
    width_px, height_px, device_pixel_ratio, byte_size, sha256, edits_version)
    VALUES (?, 'image', '2026-05-24T12:00:00.000Z', 2, 1000, 800, 1, 0, ?, 0)`)
    .run(captureId, "0".repeat(64));
  for (const layer of [a, b, c, d]) insertLayer({ captureId, node: layer });
  publications.mockClear();
  repacks.mockClear();

});
afterEach(async () => {
  destroyed = true;
  liveWindow.emit("closed");
  testDb.close();
});

function context() {
  return { principal: "ipc" as const, sourceWindowId: 7, sourceDocumentId };
}
async function reserve() {
  const result = await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, context());
  if (!result.ok || result.value.phase !== "reserved") throw new Error("reservation refused");
  return result.value.replayId;
}
function rows() {
  return {
    layers: testDb.prepare("SELECT * FROM layers ORDER BY id").all(),
    captures: testDb.prepare("SELECT * FROM captures ORDER BY id").all(),
    publications: publications.mock.calls.length,
    repacks: repacks.mock.calls.length
  };
}

describe("IPC history receipt protocol", () => {
  test("closed cleanup never reads the destroyed BrowserWindow webContents accessor", async () => {
    await reserve();
    const contents = liveWindow.webContents;
    Object.defineProperty(liveWindow, "webContents", {
      configurable: true,
      get: () => {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return contents;
      }
    });
    destroyed = true;
    expect(() => liveWindow.emit("closed")).not.toThrow();
    expect(contents.listenerCount("render-process-gone")).toBe(0);
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(liveWindow.listenerCount("closed")).toBe(0);
    expect((await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, context())).ok).toBe(false);
  });

  test("reserved removal state is a precondition, not the later restore target", async () => {
    const changed = { ...a, visible: false, z_index: 9000 };
    updateLayer({ captureId, node: changed });
    const reservation = await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId, removeIds: [a.id] }, context());
    if (!reservation.ok || reservation.value.phase !== "reserved") throw new Error("reservation refused");
    expect(reservation.value.removals).toEqual([changed]);
    const request = { phase: "apply" as const, captureId, replayId: reservation.value.replayId, restore: [], removeIds: [a.id], expectedRemovals: reservation.value.removals };
    updateLayer({ captureId, node: { ...changed, name: "changed after reserve" } });
    const before = rows();
    expect((await bus.dispatch("layers:replayHistory", request, context())).ok).toBe(false);
    expect(rows()).toEqual(before);
  });

  test("separate rejected expectations preserve later edits and cannot target other IDs", async () => {
    const changed = { ...a, visible: false, z_index: 9000 };
    updateLayer({ captureId, node: changed });
    rejectLayer(a.id);
    const replayId = await reserve();
    const request = { phase: "apply" as const, captureId, replayId, restore: [a], removeIds: [], expectedRejected: [changed] };
    expect((await bus.dispatch("layers:replayHistory", request, context())).ok).toBe(true);
    updateLayer({ captureId, node: { ...a, name: "external edit" } });
    rejectLayer(a.id);
    const before = rows();
    const nextId = await reserve();
    expect((await bus.dispatch("layers:replayHistory", { ...request, replayId: nextId }, context())).ok).toBe(false);
    expect(rows()).toEqual(before);
    const malformedId = await reserve();
    expect(await bus.dispatch("layers:replayHistory", { ...request, replayId: malformedId, expectedRejected: [b] }, context())).toMatchObject({ ok: false, error: { code: "invalid_history_replay" } });
    expect(rows()).toEqual(before);
  });

  test("duplicate commits and late ACKs cannot write or erase a newer receipt", async () => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    const replayId = await reserve();
    const request = { phase: "apply" as const, captureId, replayId, restore: [a, b], removeIds: [c.id, d.id] };
    expect((await bus.dispatch("layers:replayHistory", request, context())).ok).toBe(true);
    updateLayer({ captureId, node: { ...a, name: "later unrelated edit" } });
    const before = rows();
    const repeated = await bus.dispatch("layers:replayHistory", request, context());
    expect(repeated.ok).toBe(true);
    if (!repeated.ok || repeated.value.phase !== "applied") throw new Error("expected snapshot");
    expect(repeated.value.layers.find((layer) => layer.id === a.id)?.name).toBe("later unrelated edit");
    expect(rows()).toEqual(before);
    const changed = await bus.dispatch("layers:replayHistory", { ...request, restore: [{ ...a, name: "forged different replay" }, b] }, context());
    expect(changed).toMatchObject({ ok: false, error: { code: "history_payload_mismatch" } });
    expect(rows()).toEqual(before);
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, context())).ok).toBe(true);
    expect((await bus.dispatch("layers:replayHistory", request, context())).ok).toBe(false);
    const nextId = await reserve();
    expect(nextId.sequence).toBeGreaterThan(replayId.sequence);
    // The first ACK is already retired. Its late duplicate must leave the
    // next receipt available, and neither old request may mutate any row.
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, context())).ok).toBe(true);
    const next = { phase: "apply" as const, captureId, replayId: nextId, restore: [c, d], removeIds: [a.id, b.id] };
    expect((await bus.dispatch("layers:replayHistory", next, context())).ok).toBe(true);
    const afterNext = rows();
    expect((await bus.dispatch("layers:replayHistory", request, context())).ok).toBe(false);
    expect((await bus.dispatch("layers:replayHistory", next, context())).ok).toBe(true);
    expect(rows()).toEqual(afterNext);
  });

  test("reservation capacity applies backpressure before mutation and never reuses retired IDs", async () => {
    const { MAX_HISTORY_RECEIPTS_PER_DOCUMENT } = await import("../../handlers/layer-history-replay");
    const reservations = [];
    const before = rows();
    for (let i = 0; i < MAX_HISTORY_RECEIPTS_PER_DOCUMENT; i += 1) reservations.push(await reserve());
    expect(await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, context())).toMatchObject({ ok: false, error: { code: "history_capacity" } });
    expect(rows()).toEqual(before);
    const first = reservations[0]!;
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId: first }, context())).ok).toBe(true);
    const next = await reserve();
    expect(next.sequence).toBeGreaterThan(reservations.at(-1)!.sequence);
    expect(await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId: first, restore: [], removeIds: [a.id] }, context())).toMatchObject({ ok: false, error: { code: "history_replay_retired" } });
    expect(rows()).toEqual(before);
  });

  test.each(["closed", "render-process-gone", "navigation"])("document %s cleanup frees capacity without admitting an old replay or ACK", async (event) => {
    const oldContext = context();
    const oldId = await reserve();
    const { MAX_HISTORY_RECEIPTS_PER_DOCUMENT } = await import("../layer-history-replay");
    for (let i = 1; i < MAX_HISTORY_RECEIPTS_PER_DOCUMENT; i += 1) await reserve();
    expect((await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, context())).ok).toBe(false);
    if (event === "closed") { destroyed = true; liveWindow.emit("closed"); }
    else if (event === "navigation") liveWindow.webContents.emit("did-start-navigation", {}, "file:///fixture", false, true);
    else liveWindow.webContents.emit("render-process-gone");
    destroyed = false;
    liveWindow = Object.assign(new EventEmitter(), {
      id: 7, isDestroyed: () => destroyed,
      webContents: Object.assign(new EventEmitter(), { id: 70, isDestroyed: () => destroyed })
    });
    sourceDocumentId = "new_main_document_";
    const { allowNextHotkeyRecorderDocument } = await import("../../hotkeys/hotkey-recorder-document");
    allowNextHotkeyRecorderDocument(70);
    admitHotkeyRecorderDocument(70, sourceDocumentId);
    const next = await reserve();
    expect(next.sequence).toBe(1);
    expect(next.owner).not.toBe(oldId.owner);
    const before = rows();
    const oldRequest = { phase: "apply" as const, captureId, replayId: oldId, restore: [], removeIds: [a.id] };
    expect(await bus.dispatch("layers:replayHistory", oldRequest, oldContext)).toMatchObject({ ok: false, error: { code: "history_document_required" } });
    expect(await bus.dispatch("layers:replayHistory", oldRequest, context())).toMatchObject({ ok: false, error: { code: "history_owner_mismatch" } });
    expect(await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId: oldId }, context())).toMatchObject({ ok: false, error: { code: "history_owner_mismatch" } });
    expect(rows()).toEqual(before);
    expect((await bus.dispatch("layers:replayHistory", { ...oldRequest, replayId: next }, context())).ok).toBe(true);
  });

  test.each(["rpc", "bridge", "seeder", "mcp"] as const)("%s cannot reserve or acknowledge IPC history", async (principal) => {
    const replayId = await reserve();
    const before = rows();
    const untrusted = { ...context(), principal };
    expect((await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, untrusted)).ok).toBe(false);
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, untrusted)).ok).toBe(false);
    expect(rows()).toEqual(before);
  });

  test("request fields cannot forge document identity, change capture ownership, or acknowledge a future sequence", async () => {
    const replayId = await reserve();
    const before = rows();
    expect((await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId, sourceWindowId: 7, sourceDocumentId } as never, { principal: "ipc" })).ok).toBe(false);
    expect((await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, { principal: "ipc", sourceWindowId: 7 })).ok).toBe(false);
    expect(await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId: { ...replayId, sequence: replayId.sequence + 1 } }, context())).toMatchObject({ ok: false, error: { code: "history_replay_unreserved" } });
    expect(await bus.dispatch("layers:ackHistoryReplay", { captureId: "different_capture", replayId }, context())).toMatchObject({ ok: false, error: { code: "history_payload_mismatch" } });
    expect(rows()).toEqual(before);
  });

  test("ordinary upsert still rejects an already-live layer", async () => {
    const before = rows();
    expect(await bus.dispatch("layers:upsert", { captureId, layer: { ...a, name: "overwrite" } }, context())).toMatchObject({ ok: false, error: { code: "insert_failed" } });
    expect(rows()).toEqual(before);
  });
});

describe("history request boundaries", () => {
  test("oversized requests are refused before reserving receipt storage", async () => {
    const { MAX_HISTORY_REQUEST_BYTES } = await import("../layer-history-replay");
    const before = rows();
    const oversized = { phase: "reserve", captureId, padding: "x".repeat(MAX_HISTORY_REQUEST_BYTES) };
    expect(await bus.dispatch("layers:replayHistory", oversized as never, context())).toMatchObject({ ok: false, error: { code: "history_request_too_large" } });
    expect(rows()).toEqual(before);
    expect((await reserve()).sequence).toBe(1);
  });

  test("a replay cannot restore or delete a layer owned by another capture", async () => {
    testDb.prepare(`INSERT INTO captures (id, kind, captured_at, bundle_format_version,
      width_px, height_px, device_pixel_ratio, byte_size, sha256, edits_version)
      VALUES ('other_capture', 'image', '2026-05-24T12:00:00.000Z', 2, 1000, 800, 1, 0, ?, 0)`)
      .run("1".repeat(64));
    const other = { ...a, id: "other".padEnd(16, "_") };
    insertLayer({ captureId: "other_capture", node: other });
    rejectLayer(other.id);
    const before = rows();
    for (const payload of [{ restore: [other], removeIds: [] }, { restore: [], removeIds: [other.id] }]) {
      const replayId = await reserve();
      expect((await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId, ...payload }, context())).ok).toBe(false);
      expect(rows()).toEqual(before);
    }
  });

  test("malformed, empty, overlapping and oversized groups cannot mutate", async () => {
    const before = rows();
    for (const payload of [
      { restore: [], removeIds: [] },
      { restore: [a], removeIds: [a.id] },
      { restore: [], removeIds: [a.id, a.id] },
      { restore: [{ ...a, rejected_at: "2026-05-24T12:00:00.000Z" }], removeIds: [] },
      { restore: [], removeIds: ["invalid"] },
      { restore: Array.from({ length: 10_001 }, () => a), removeIds: [] }
    ]) {
      const replayId = await reserve();
      expect((await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId, ...payload } as never, context())).ok).toBe(false);
      expect(rows()).toEqual(before);
    }
  });

  test("even an authenticated MCP editor cannot reserve IPC history", async () => {
    bus.installLocalAgentAuthorizer(async () => ({ clientId: "fixture", capabilities: ["capture.edit"] }));
    try {
      expect(await bus.dispatch("layers:replayHistory", { phase: "reserve", captureId }, { principal: "mcp", localAgent: { clientId: "fixture", capabilities: ["capture.edit"] }, sourceWindowId: 7, sourceDocumentId })).toMatchObject({ ok: false, error: { code: "local_agent_capability_denied" } });
    } finally { bus.uninstallLocalAgentAuthorizerForTests(); }
  });
});

test("another window cannot replay or ACK even when its document label matches", async () => {
  const replayId = await reserve();
  const { BrowserWindow } = await import("electron");
  const other = Object.assign(new EventEmitter(), {
    id: 8, isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { id: 80, isDestroyed: () => false })
  });
  admitHotkeyRecorderDocument(80, sourceDocumentId);
  const fromId = vi.spyOn(BrowserWindow, "fromId").mockImplementation((id) => (id === 8 ? other : liveWindow) as unknown as InstanceType<typeof BrowserWindow>);
  const otherContext = { ...context(), sourceWindowId: 8 };
  const before = rows();
  try {
    expect(await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId, restore: [], removeIds: [a.id] }, otherContext)).toMatchObject({ ok: false, error: { code: "history_owner_mismatch" } });
    expect(await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, otherContext)).toMatchObject({ ok: false, error: { code: "history_owner_mismatch" } });
    expect(rows()).toEqual(before);
    expect((await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId, restore: [], removeIds: [a.id] }, context())).ok).toBe(true);
  } finally { other.emit("closed"); fromId.mockRestore(); }
});

test("subframe and in-place navigation keep an outstanding receipt valid", async () => {
  const replayId = await reserve();
  liveWindow.webContents.emit("did-start-navigation", {}, "file:///child", false, false);
  liveWindow.webContents.emit("did-start-navigation", {}, "file:///same#fragment", true, true);
  expect((await bus.dispatch("layers:replayHistory", { phase: "apply", captureId, replayId, restore: [], removeIds: [a.id] }, context())).ok).toBe(true);
});
