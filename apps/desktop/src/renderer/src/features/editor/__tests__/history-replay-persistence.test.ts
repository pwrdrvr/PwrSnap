// Exercise the production history/model/command/repository chain. A permissive
// dispatch mock cannot reproduce insertLayer's conflict on an already-live ID.
import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { useCaptureModel } from "../useCaptureModel";
import { useUndoRedo, type UseUndoRedoResult } from "../useUndoRedo";

let testDb: Database.Database;
let documentCounter = 0;
let sourceDocumentId: string;
let destroyed: boolean;
let liveWindow: EventEmitter & { id: number; isDestroyed: () => boolean; webContents: EventEmitter & { id: number; isDestroyed: () => boolean } };
vi.mock("electron", () => ({ BrowserWindow: { fromId: (id: number) => id === 7 ? liveWindow : null } }));
vi.mock("../../../../../main/persistence/db", () => ({ getDb: () => testDb }));
vi.mock("../../../../../main/log", () => ({
  getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
}));
const publications = vi.fn();
const repacks = vi.fn();
vi.mock("../../../../../main/handlers/broadcast-layers", () => ({
  broadcastLayersChanged: (...args: unknown[]) => publications(...args)
}));
vi.mock("../../../../../main/persistence/bundle-store", () => ({
  scheduleRepack: (...args: unknown[]) => repacks(...args)
}));
const dispatchMock = vi.fn();
const subscribers = new Map<string, Set<(payload: unknown) => void>>();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (channel: string, handler: (payload: unknown) => void) => {
    const callbacks = subscribers.get(channel) ?? new Set();
    callbacks.add(handler);
    subscribers.set(channel, callbacks);
    return () => { callbacks.delete(handler); };
  }
}));

const { admitHotkeyRecorderDocument } = await import("../../../../../main/hotkeys/hotkey-recorder-document");
const { bus } = await import("../../../../../main/command-bus");
const { registerLayersHandlers } = await import("../../../../../main/handlers/layers-handlers");
const { getCaptureById } = await import("../../../../../main/persistence/captures-repo");
const { insertLayer, rejectLayer, updateLayer, listLayerTree } = await import("../../../../../main/persistence/layers-repo");
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
function addSource(): void {
  insertLayer({ captureId, node: { ...node("source", 0), kind: "raster", source_ref: { kind: "embedded", sha256: "0".repeat(64) }, natural_width_px: 1000, natural_height_px: 800 } });
}
let api: UseUndoRedoResult;
let modelSnapshot: ReturnType<typeof useCaptureModel>;
let root: Root;
let host: HTMLDivElement;
function Probe(): null {
  const model = useCaptureModel(captureId);
  const applyingRef = useRef(false);
  const history = useUndoRedo({
    captureId, applyingRef,
    dispatchEdit: model.kind === "loaded" ? model.dispatchEdit : async () => { throw new Error("model not loaded"); }
  });
  useEffect(() => { api = history; modelSnapshot = model; });
  return null;
}

beforeEach(async () => {
  destroyed = false;
  sourceDocumentId = `history_doc_${++documentCounter}`.padEnd(20, "_");
  liveWindow = Object.assign(new EventEmitter(), {
    id: 7, isDestroyed: () => destroyed,
    webContents: Object.assign(new EventEmitter(), { id: 70, isDestroyed: () => destroyed })
  });
  const { allowNextHotkeyRecorderDocument } = await import("../../../../../main/hotkeys/hotkey-recorder-document");
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
  dispatchMock.mockReset();
  dispatchMock.mockImplementation(async (name: string, req: unknown) => {
    if (name === "library:byId") return { ok: true, value: getCaptureById(captureId) };
    return bus.dispatch(name as never, req as never, { principal: "ipc", sourceWindowId: 7, sourceDocumentId });
  });
  subscribers.clear();
  publications.mockClear();
  repacks.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(Probe)); });
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  destroyed = true;
  liveWindow.emit("closed");
  testDb.close();
});

type Failure = "result" | "reject-before-commit" | "reject-after-commit";
function failNextReplay(mode: Failure): void {
  const ordinaryDispatch = dispatchMock.getMockImplementation()!;
  let failed = false;
  if (mode !== "reject-after-commit") {
    testDb.exec(`CREATE TEMP TRIGGER fail_b BEFORE UPDATE OF rejected_at ON layers
      WHEN NEW.id = '${b.id}' AND NEW.rejected_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'fixture B restore failure'); END`);
  }
  dispatchMock.mockImplementation(async (name: string, req: unknown) => {
    const target = (name === "layers:replayHistory" && (req as { phase: string }).phase === "apply") ||
      (name === "layers:upsert" && (req as { layer: BundleLayerNode }).layer.id === b.id);
    const result = await ordinaryDispatch(name, req);
    if (!failed && target) {
      failed = true;
      testDb.exec("DROP TRIGGER IF EXISTS fail_b");
      if (mode !== "result") throw new Error(`fixture ${mode}`);
    }
    return result;
  });
}

function recordPair(kind: "create" | "delete"): void {
  act(() => {
    const token = api.beginInteraction(kind, "group");
    for (const layer of [a, b]) {
      const opts = { node: layer, opKind: kind, layerId: "group", mergeMode: "append" as const };
      if (kind === "create") api.recordCreate({ id: layer.id }, opts);
      else api.recordDelete({ id: layer.id }, opts);
    }
    api.endInteraction(token);
  });
}

describe("grouped history with real layer persistence", () => {
  test.each(["crop", "reorder", "visibility"] as const)("create redo restores its target after intervening %s", async (change) => {
    act(() => api.recordCreate({ id: a.id }, { node: a }));
    if (change === "crop") {
      addSource();
      if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
      await act(async () => {
        if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
        const result = await modelSnapshot.dispatchEdit({ kind: "crop", rect: { x: 0.15, y: 0.2, w: 0.333, h: 0.517 } });
        if (!result.ok || result.value.kind !== "crop") throw new Error("crop failed");
        const artifact = result.value.artifact;
        api.recordCrop({ ...artifact, newWidthPx: artifact.widthPx, newHeightPx: artifact.heightPx });
      });
      await act(async () => { await api.undo(); });
      expect(api.canRedo).toBe(true);
    } else {
      updateLayer({ captureId, node: { ...a, ...(change === "reorder" ? { z_index: 8000 } : { visible: false }) } });
    }
    await act(async () => { await api.undo(); });
    expect(listLayerTree(captureId).some((layer) => layer.id === a.id)).toBe(false);
    await act(async () => { await api.redo(); });
    expect(api.canUndo).toBe(true);
    expect(listLayerTree(captureId).find((layer) => layer.id === a.id)).toEqual(a);
  });

  test("lost delete reply retains the rejected-state expectation independently of its restore target", async () => {
    recordPair("create");
    updateLayer({ captureId, node: { ...a, visible: false, z_index: 8000 } });
    failNextReplay("reject-after-commit");
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(true);
    const committed = rows();
    await act(async () => { await api.undo(); });
    expect(rows()).toEqual(committed);
    await act(async () => { await api.redo(); });
    expect(api.canRedo).toBe(false);
    expect(listLayerTree(captureId).find((layer) => layer.id === a.id)).toEqual(a);
  });

  test("replace round trips retain separate expectations on both sides", async () => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    act(() => api.recordReplace({ removed: [a, b].map((layer) => ({ row: { id: layer.id }, node: layer })), added: [c, d].map((layer) => ({ row: { id: layer.id }, node: layer })) }));
    updateLayer({ captureId, node: { ...c, visible: false, z_index: 8000 } });
    await act(async () => { await api.undo(); });
    updateLayer({ captureId, node: { ...a, visible: false, z_index: 9000 } });
    await act(async () => { await api.redo(); });
    expect(listLayerTree(captureId)).toEqual([c, d]);
    await act(async () => { await api.undo(); });
    expect(listLayerTree(captureId)).toEqual([a, b]);
  });

  test("lost removal reply never refreshes its expectation from a later external deletion", async () => {
    recordPair("create");
    updateLayer({ captureId, node: { ...a, visible: false } });
    failNextReplay("reject-after-commit");
    await act(async () => { await api.undo(); });
    insertLayer({ captureId, node: { ...a, name: "external replacement" } });
    rejectLayer(a.id);
    const before = rows();
    await act(async () => { await api.undo(); });
    expect(api.canRedo).toBe(true);
    expect(rows()).toEqual(before);
    await act(async () => { await api.redo(); });
    expect(api.canRedo).toBe(true);
    expect(rows()).toEqual(before);
  });

  test.each(["result", "reject-before-commit", "reject-after-commit"] as const)("delete undo retries after %s without live-row conflicts", async (failure) => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    recordPair("delete");
    failNextReplay(failure);
    const beforeFailure = rows();
    await act(async () => { await api.undo(); });
    if (failure !== "reject-after-commit") expect(rows()).toEqual(beforeFailure);
    expect(api.canUndo).toBe(true);
    if (failure === "reject-after-commit") updateLayer({ captureId, node: { ...a, name: "unrelated later edit" } });
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(true);
    expect(listLayerTree(captureId).filter((layer) => [a.id, b.id].includes(layer.id))).toHaveLength(2);
    if (failure === "reject-after-commit") expect(listLayerTree(captureId).find((layer) => layer.id === a.id)?.name).toBe("unrelated later edit");
    await act(async () => { await api.redo(); });
    expect(listLayerTree(captureId).some((layer) => [a.id, b.id].includes(layer.id))).toBe(false);
  });

  test.each(["result", "reject-before-commit", "reject-after-commit"] as const)("create redo retries after %s as one group", async (failure) => {
    recordPair("create");
    await act(async () => { await api.undo(); });
    failNextReplay(failure);
    const beforeFailure = rows();
    await act(async () => { await api.redo(); });
    if (failure !== "reject-after-commit") expect(rows()).toEqual(beforeFailure);
    expect(api.canRedo).toBe(true);
    await act(async () => { await api.redo(); });
    expect(api.canRedo).toBe(false);
    expect(api.canUndo).toBe(true);
    for (const expected of [a, b]) expect(listLayerTree(captureId).find((layer) => layer.id === expected.id)).toEqual(expected);
  });

  test.each(["result", "reject-before-commit", "reject-after-commit"] as const)("replace undo retries after %s without losing either side", async (failure) => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    act(() => api.recordReplace({ removed: [a, b].map((layer) => ({ row: { id: layer.id }, node: layer })), added: [c, d].map((layer) => ({ row: { id: layer.id }, node: layer })) }));
    failNextReplay(failure);
    const beforeFailure = rows();
    await act(async () => { await api.undo(); });
    if (failure !== "reject-after-commit") expect(rows()).toEqual(beforeFailure);
    expect(api.canUndo).toBe(true);
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(true);
    expect(listLayerTree(captureId).map((layer) => layer.id)).toEqual([a.id, b.id]);
    await act(async () => { await api.redo(); });
    expect(listLayerTree(captureId).map((layer) => layer.id)).toEqual([c.id, d.id]);
  });
});

function context() {
  return { principal: "ipc" as const, sourceWindowId: 7, sourceDocumentId };
}
function rows() {
  return {
    layers: testDb.prepare("SELECT * FROM layers ORDER BY id").all(),
    captures: testDb.prepare("SELECT * FROM captures ORDER BY id").all(),
    publications: publications.mock.calls.length,
    repacks: repacks.mock.calls.length
  };
}

describe("history acknowledgement failures", () => {
  test.each(["result", "rejected-before", "rejected-after"] as const)("ACK %s cannot undo a confirmed history transition", async (failure) => {
    recordPair("create");
    const ordinaryDispatch = dispatchMock.getMockImplementation()!;
    let failed = false;
    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      if (name === "layers:ackHistoryReplay" && !failed) {
        failed = true;
        if (failure === "rejected-before") throw new Error("lost ACK request");
        if (failure === "result") return { ok: false, error: { kind: "persistence", code: "fixture_ack", message: "fixture acknowledgement refused" } };
        await ordinaryDispatch(name, req);
        throw new Error("lost ACK reply");
      }
      return ordinaryDispatch(name, req);
    });
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(api.canRedo).toBe(true);
    const apply = dispatchMock.mock.calls.find(([name, req]) => name === "layers:replayHistory" && req.phase === "apply")!;
    const replayId = apply[1].replayId;
    const afterCommit = rows();
    // ACK may or may not have arrived. A delayed duplicate retires the same
    // sequence in either case, without turning it into an insert opportunity.
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, context())).ok).toBe(true);
    expect((await bus.dispatch("layers:ackHistoryReplay", { captureId, replayId }, context())).ok).toBe(true);
    expect((await bus.dispatch("layers:replayHistory", apply[1], context())).ok).toBe(false);
    expect(rows()).toEqual(afterCommit);
    await act(async () => { await api.redo(); });
    expect(api.canUndo).toBe(true);
    expect(api.canRedo).toBe(false);
  });

});

describe("history snapshot ordering", () => {
  test.each(["history", "crop"] as const)("an older in-flight read cannot replace the committed %s snapshot", async (kind) => {
    if (kind === "crop") addSource();
    else recordPair("create");
    const ordinaryDispatch = dispatchMock.getMockImplementation()!;
    let allowCommit!: () => void;
    let arrived!: () => void;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const commitGate = new Promise<void>((resolve) => { allowCommit = resolve; });
    const arrivedGate = new Promise<void>((resolve) => { arrived = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const startedGate = new Promise<void>((resolve) => { readStarted = resolve; });
    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      if (name === "bundle:cropCanvas" || (name === "layers:replayHistory" && (req as { phase: string }).phase === "apply")) {
        arrived();
        await commitGate;
      }
      const result = await ordinaryDispatch(name, req);
      if (name === "layers:list") { readStarted(); await readGate; }
      return result;
    });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    const dispatchEdit = modelSnapshot.dispatchEdit;
    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = kind === "history" ? api.undo() : dispatchEdit({ kind: "crop", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
      await arrivedGate;
    });
    await act(async () => {
      for (const callback of subscribers.get("events:captures:changed") ?? []) callback({ changedIds: [captureId] });
      await startedGate;
    });
    await act(async () => { allowCommit(); await mutation; });
    const committedRecord = getCaptureById(captureId)!;
    const committedLayers = listLayerTree(captureId);
    await act(async () => { releaseRead(); });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    expect(modelSnapshot.record.edits_version).toBe(committedRecord.edits_version);
    expect(modelSnapshot.layers).toEqual(committedLayers);
  });

  test.each(["history", "crop"] as const)("%s reply preserves a newer refetch still in flight and the next edit", async (kind) => {
    if (kind === "crop") addSource();
    else recordPair("create");
    const ordinaryDispatch = dispatchMock.getMockImplementation()!;
    let releaseReply!: () => void;
    let committed!: () => void;
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const replyGate = new Promise<void>((resolve) => { releaseReply = resolve; });
    const committedGate = new Promise<void>((resolve) => { committed = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const startedGate = new Promise<void>((resolve) => { readStarted = resolve; });
    let holdReads = false;
    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      const result = await ordinaryDispatch(name, req);
      if (name === "bundle:cropCanvas" || (name === "layers:replayHistory" && (req as { phase: string }).phase === "apply")) {
        committed();
        await replyGate;
      }
      if (name === "layers:list" && holdReads) {
        readStarted();
        await readGate;
      }
      return result;
    });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    const dispatchEdit = modelSnapshot.dispatchEdit;
    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = kind === "history" ? api.undo() : dispatchEdit({ kind: "crop", rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
      await committedGate;
    });
    const current = listLayerTree(captureId).find((layer) => layer.id === c.id)!;
    updateLayer({ captureId, node: { ...current, name: "newer in-flight edit" } });
    const newestVersion = getCaptureById(captureId)!.edits_version;
    holdReads = true;
    await act(async () => {
      for (const callback of subscribers.get("events:captures:changed") ?? []) callback({ changedIds: [captureId] });
      await startedGate;
    });
    await act(async () => { releaseReply(); await mutation; });
    // The next full-node write must wait for the read already in flight.
    let next!: ReturnType<typeof dispatchEdit>;
    await act(async () => { next = dispatchEdit({ kind: "updateOverlay", layerId: c.id, patch: { kind: "arrow", color: "#2489ff" } }); });
    await act(async () => { releaseRead(); await next; });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    expect(modelSnapshot.record.edits_version).toBeGreaterThanOrEqual(newestVersion);
    expect(modelSnapshot.layers.find((layer) => layer.id === c.id)?.name).toBe("newer in-flight edit");
    expect(listLayerTree(captureId).find((layer) => layer.id === c.id)?.name).toBe("newer in-flight edit");
  });

  test("lost commit reply reconciles after a later local edit and retains the next patch's committed predecessor", async () => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    recordPair("delete");
    failNextReplay("reject-after-commit");
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(true);
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    const dispatchEdit = modelSnapshot.dispatchEdit;
    await act(async () => {
      expect((await dispatchEdit({ kind: "updateOverlay", layerId: a.id, patch: { kind: "arrow", color: "#2489ff" } })).ok).toBe(true);
    });
    const beforeRetry = rows();
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(rows()).toEqual(beforeRetry);
    let result;
    await act(async () => { result = await dispatchEdit({ kind: "updateOverlay", layerId: a.id, patch: { kind: "arrow", thickness: "large" } }); });
    expect(result).toMatchObject({ ok: true, value: { kind: "update", artifact: { previousNode: { shape: { color: "#2489ff" } }, node: { shape: { color: "#2489ff", thickness: "large" } } } } });
  });

  test("delayed history reply cannot publish an older snapshot over a newer refetch", async () => {
    recordPair("create");
    const ordinaryDispatch = dispatchMock.getMockImplementation()!;
    let release!: () => void;
    let committed!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const committedGate = new Promise<void>((resolve) => { committed = resolve; });
    dispatchMock.mockImplementation(async (name: string, req: unknown) => {
      const result = await ordinaryDispatch(name, req);
      if (name === "layers:replayHistory" && (req as { phase: string }).phase === "apply") {
        committed();
        await gate;
      }
      return result;
    });
    let undo!: Promise<void>;
    await act(async () => { undo = api.undo(); await committedGate; });
    updateLayer({ captureId, node: { ...c, name: "newer model snapshot" } });
    const newest = getCaptureById(captureId)!;
    await act(async () => {
      for (const callback of subscribers.get("events:captures:changed") ?? []) callback({ changedIds: [captureId] });
    });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    expect(modelSnapshot.record.edits_version).toBe(newest.edits_version);
    await act(async () => { release(); await undo; });
    if (modelSnapshot.kind !== "loaded") throw new Error("model not loaded");
    expect(modelSnapshot.record.edits_version).toBe(newest.edits_version);
    expect(modelSnapshot.layers.find((layer) => layer.id === c.id)?.name).toBe("newer model snapshot");
    expect(api.canUndo).toBe(false);
  });

  test("a delete failure after both replace restores rolls every row and version back", async () => {
    rejectLayer(a.id);
    rejectLayer(b.id);
    act(() => api.recordReplace({ removed: [a, b].map((layer) => ({ row: { id: layer.id }, node: layer })), added: [c, d].map((layer) => ({ row: { id: layer.id }, node: layer })) }));
    testDb.exec(`CREATE TEMP TRIGGER fail_remove_d BEFORE UPDATE OF rejected_at ON layers
      WHEN NEW.id = '${d.id}' AND NEW.rejected_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'fixture later delete failure'); END`);
    const before = rows();
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(true);
    expect(rows()).toEqual(before);
    testDb.exec("DROP TRIGGER fail_remove_d");
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(listLayerTree(captureId).map((layer) => layer.id)).toEqual([a.id, b.id]);
    expect(publications).toHaveBeenCalledTimes(1);
    expect(repacks).toHaveBeenCalledTimes(1);
  });
});

test("a rejected layer changed after rollback is a conflict, not an overwrite", async () => {
  rejectLayer(a.id);
  rejectLayer(b.id);
  recordPair("delete");
  failNextReplay("result");
  await act(async () => { await api.undo(); });
  expect(api.canUndo).toBe(true);
  // Another edit restores, changes, then deletes this same logical layer.
  insertLayer({ captureId, node: { ...a, name: "changed outside this history" } });
  rejectLayer(a.id);
  const beforeRetry = rows();
  await act(async () => { await api.undo(); });
  expect(api.canUndo).toBe(true);
  expect(api.canRedo).toBe(false);
  expect(rows()).toEqual(beforeRetry);
});

test("an unconfirmed replay cannot coalesce with a later delete or overwrite that edit on retry", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    rejectLayer(a.id);
    rejectLayer(b.id);
    const options = { opKind: "delete", layerId: "group", mergeMode: "append" as const };
    act(() => {
      api.recordDelete({ id: a.id }, { ...options, node: a });
      api.recordDelete({ id: b.id }, { ...options, node: b });
    });
    failNextReplay("reject-after-commit");
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(true);
    rejectLayer(c.id);
    act(() => api.recordDelete({ id: c.id }, { ...options, node: c }));
    // Undo the later delete as its own entry, then reconcile the first
    // operation's lost reply without issuing its writes a second time.
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(true);
    expect(listLayerTree(captureId).some((layer) => layer.id === c.id)).toBe(true);
    const beforeRetry = rows();
    await act(async () => { await api.undo(); });
    expect(api.canUndo).toBe(false);
    expect(rows()).toEqual(beforeRetry);
  } finally { vi.restoreAllMocks(); }
});
