// Rule: a completed history command moves the whole group exactly once;
// failed replies retain a retryable entry and never overwrite unrelated rows.
// Oracle: real SQLite through the production hook/model/bus/repository chain,
// compared after each generated command with a plain map and two stacks.
import Database from "better-sqlite3";
import fc from "fast-check";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi, type TestContext } from "vitest";
import { BundleLayerNode as LayerSchema, type BundleLayerNode } from "@pwrsnap/shared";
import { useCaptureModel, type LayerEditOp } from "../useCaptureModel";
import { useUndoRedo, type UseUndoRedoResult } from "../useUndoRedo";

let db: Database.Database;
let destroyed = false;
let liveWindow: EventEmitter & { id: number; isDestroyed: () => boolean; webContents: EventEmitter & { id: number; isDestroyed: () => boolean } };
vi.mock("electron", () => ({ BrowserWindow: { fromId: (id: number) => id === 7 ? liveWindow : null } }));
vi.mock("../../../../../main/persistence/db", () => ({ getDb: () => db }));
vi.mock("../../../../../main/log", () => ({ getMainLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
const publications = vi.fn();
const repacks = vi.fn();
const subscribers = new Set<(payload: unknown) => void>();
vi.mock("../../../../../main/handlers/broadcast-layers", () => ({
  broadcastLayersChanged: (captureId: string) => {
    publications(captureId);
    for (const subscriber of subscribers) subscriber({ captureId, changedIds: [captureId] });
  }
}));
vi.mock("../../../../../main/persistence/bundle-store", () => ({ scheduleRepack: (id: string) => repacks(id) }));
const dispatch = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatch(...args),
  subscribe: (_channel: string, callback: (payload: unknown) => void) => {
    subscribers.add(callback);
    return () => { subscribers.delete(callback); };
  }
}));
const { bus } = await import("../../../../../main/command-bus");
const { registerLayersHandlers } = await import("../../../../../main/handlers/layers-handlers");
const { getCaptureById } = await import("../../../../../main/persistence/captures-repo");
const { listLayerTree } = await import("../../../../../main/persistence/layers-repo");
const { allowNextHotkeyRecorderDocument, admitHotkeyRecorderDocument } = await import("../../../../../main/hotkeys/hotkey-recorder-document");
registerLayersHandlers();
const migrations = resolve("apps/desktop/src/main/persistence/migrations");
const migrationSql = readdirSync(migrations).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()
  .map((file) => readFileSync(join(migrations, file), "utf8")).join("\n");
const captureId = "history_model";
let documentCounter = 0;
let history: UseUndoRedoResult;
let snapshot: ReturnType<typeof useCaptureModel>;
function Probe(): null {
  const model = useCaptureModel(captureId);
  const api = useUndoRedo({
    captureId,
    dispatchEdit: model.kind === "loaded" ? model.dispatchEdit : async () => { throw new Error("model not loaded"); }
  });
  useEffect(() => { history = api; snapshot = model; });
  return null;
}

type Failure = "none" | "result" | "reject-before" | "reject-after";
type Transition = { added: BundleLayerNode[]; removed: BundleLayerNode[] };
type Model = { live: Map<string, BundleLayerNode>; past: Transition[]; future: Transition[]; serial: number };
type Real = { arm: (failure: Failure) => void };
type LayerKind = "vector" | "raster" | "effect";
type Action = "create" | "delete" | "replace" | "external" | "undo" | "redo" | "doubleUndo" | "doubleRedo";
function layer(serial: number, kind: LayerKind, value: number): BundleLayerNode {
  const common = {
    id: String(serial).padStart(16, "0"), parent_id: null, name: "layer " + value,
    visible: true, locked: false, opacity: 1, blend_mode: "normal" as const,
    transform: [1, 0, 0, 1, 0, 0], z_index: serial * 1000, source: "user" as const,
    ai_run_id: null, rejected_at: null, superseded_by: null,
    applied_at: "2026-05-24T12:00:00.000Z", created_at: "2026-05-24T12:00:00.000Z"
  };
  return LayerSchema.parse(kind === "vector"
    ? { ...common, kind, shape: { kind: "arrow", from: { x: value / 100, y: 0.2 }, to: { x: 0.8, y: 0.9 }, color: "auto" } }
    : kind === "raster"
      ? { ...common, kind, source_ref: { kind: "embedded", sha256: "0".repeat(64) }, natural_width_px: 200, natural_height_px: 100 }
      : { ...common, kind, effect: { type: "blur", radius_px: 10 }, clip_rect: { x: value, y: 80, w: 200, h: 120 } });
}
const ordered = (nodes: Iterable<BundleLayerNode>) => [...nodes].sort((a, b) => a.id.localeCompare(b.id));
function assertOracle(model: Model): void {
  expect(ordered(listLayerTree(captureId))).toEqual(ordered(model.live.values()));
  expect(history.canUndo).toBe(model.past.length > 0);
  expect(history.canRedo).toBe(model.future.length > 0);
  if (snapshot.kind !== "loaded") throw new Error("model not loaded");
  expect(ordered(snapshot.layers)).toEqual(ordered(model.live.values()));
  expect(snapshot.record.edits_version).toBe(getCaptureById(captureId)!.edits_version);
}
async function edit(op: LayerEditOp): Promise<void> {
  await act(async () => {
    if (snapshot.kind !== "loaded") throw new Error("model not loaded");
    const result = await snapshot.dispatchEdit(op);
    if (!result.ok) throw new Error(result.error.message);
  });
}
function applyTransition(live: Map<string, BundleLayerNode>, restore: BundleLayerNode[], remove: BundleLayerNode[]): void {
  for (const node of remove) live.delete(node.id);
  for (const node of restore) live.set(node.id, structuredClone(node));
}
class EditorCommand implements fc.AsyncCommand<Model, Real> {
  constructor(readonly action: Action, readonly count: number, readonly kind: LayerKind, readonly value: number, readonly failure: Failure) {}
  check(model: Readonly<Model>): boolean {
    if (this.action === "create") return true;
    if (this.action === "undo" || this.action === "doubleUndo") return model.past.length > 0;
    if (this.action === "redo" || this.action === "doubleRedo") return model.future.length > 0;
    return model.live.size > 0;
  }
  async run(model: Model, real: Real): Promise<void> {
    if (["undo", "redo", "doubleUndo", "doubleRedo"].includes(this.action)) {
      const undo = this.action === "undo" || this.action === "doubleUndo";
      const direction = undo ? "undo" : "redo";
      const burst = this.action === "doubleUndo" || this.action === "doubleRedo";
      const failure = burst ? "none" : this.failure;
      const from = undo ? model.past : model.future;
      const to = undo ? model.future : model.past;
      const transition = from[from.length - 1]!;
      const restore = undo ? transition.removed : transition.added;
      const remove = undo ? transition.added : transition.removed;
      const next = new Map(model.live);
      applyTransition(next, restore, remove);
      const before = ordered(model.live.values());
      const version = getCaptureById(captureId)!.edits_version;
      const published = publications.mock.calls.length;
      const packed = repacks.mock.calls.length;
      real.arm(failure);
      await act(async () => {
        // Two keyboard/menu requests from one render own only one in-flight
        // replay. Keep the same callback object until both requests settle.
        const current = history;
        await Promise.all(burst ? [current[direction](), current[direction]()] : [current[direction]()]);
      });
      if (failure !== "none") {
        expect(history.canUndo).toBe(model.past.length > 0);
        expect(history.canRedo).toBe(model.future.length > 0);
        const committed = failure === "reject-after";
        expect(ordered(listLayerTree(captureId))).toEqual(committed ? ordered(next.values()) : before);
        expect(publications).toHaveBeenCalledTimes(published + Number(committed));
        expect(repacks).toHaveBeenCalledTimes(packed + Number(committed));
        if (!committed) expect(getCaptureById(captureId)!.edits_version).toBe(version);
        const committedVersion = getCaptureById(captureId)!.edits_version;
        await act(async () => { await history[direction](); });
        if (committed) expect(getCaptureById(captureId)!.edits_version).toBe(committedVersion);
      }
      expect(publications).toHaveBeenCalledTimes(published + 1);
      expect(repacks).toHaveBeenCalledTimes(packed + 1);
      model.live = next;
      to.push(from.pop()!);
    } else if (this.action === "external") {
      const previous = ordered(model.live.values())[this.value % model.live.size]!;
      const changed = { ...previous, visible: !previous.visible, z_index: previous.z_index + this.value + 1 };
      await act(async () => {
        expect((await bus.dispatch("layers:update", { captureId, layer: changed }, { principal: "ipc" })).ok).toBe(true);
      });
      model.live.set(changed.id, changed);
    } else {
      const removed = this.action === "create" ? [] : ordered(model.live.values()).slice(0, this.count);
      const added = this.action === "delete" ? [] : Array.from({ length: this.count }, () => layer(++model.serial, this.kind, this.value));
      for (const node of added) await edit({ kind: "upsert", node });
      for (const node of removed) await edit({ kind: "delete", id: node.id });
      act(() => {
        if (this.action === "replace") {
          const items = (nodes: BundleLayerNode[]) => nodes.map((node) => ({ row: { id: node.id }, node }));
          history.recordReplace({ added: items(added), removed: items(removed) });
        } else {
          const kind = this.action === "create" ? "create" : "delete";
          const token = history.beginInteraction(kind, "generated group");
          for (const node of kind === "create" ? added : removed) {
            const opts = { node, opKind: kind, layerId: "generated group", mergeMode: "append" as const };
            if (kind === "create") history.recordCreate({ id: node.id }, opts);
            else history.recordDelete({ id: node.id }, opts);
          }
          history.endInteraction(token);
        }
      });
      applyTransition(model.live, added, removed);
      model.past.push({ added, removed });
      model.future = [];
    }
    assertOracle(model);
  }
  toString(): string {
    return [this.action, this.count, this.kind, this.value, this.failure].join(":");
  }
}
const command = fc.tuple(
  fc.constantFrom<Action>("create", "delete", "replace", "external", "undo", "redo", "doubleUndo", "doubleRedo"),
  fc.integer({ min: 1, max: 3 }), fc.constantFrom<LayerKind>("vector", "raster", "effect"),
  fc.integer({ min: 0, max: 100 }),
  fc.constantFrom<Failure>("none", "result", "reject-before", "reject-after")
).map((args) => new EditorCommand(...args));

async function withHarness(run: (real: Real) => Promise<void>): Promise<void> {
  db = new Database(":memory:");
  db.exec(migrationSql);
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO captures (id,kind,captured_at,bundle_format_version,width_px,height_px,device_pixel_ratio,byte_size,sha256,edits_version) VALUES (?, 'image', '2026-05-24T12:00:00.000Z', 2, 1000, 800, 1, 0, ?, 0)")
    .run(captureId, "0".repeat(64));
  const documentId = ("model_" + ++documentCounter).padEnd(20, "_");
  destroyed = false;
  liveWindow = Object.assign(new EventEmitter(), {
    id: 7, isDestroyed: () => destroyed,
    webContents: Object.assign(new EventEmitter(), { id: 70, isDestroyed: () => destroyed })
  });
  allowNextHotkeyRecorderDocument(70);
  admitHotkeyRecorderDocument(70, documentId);
  let armed: Failure = "none";
  const context = { principal: "ipc" as const, sourceWindowId: 7, sourceDocumentId: documentId };
  dispatch.mockImplementation(async (name: string, req: { phase?: string; restore?: BundleLayerNode[] | boolean; removeIds?: string[] }) => {
    if (name === "library:byId") return { ok: true, value: getCaptureById(captureId) };
    const failure = name === "layers:replayHistory" && req.phase === "apply" ? armed : "none";
    if (failure !== "none") armed = "none";
    const target = [...(Array.isArray(req.restore) ? req.restore : []).map((node) => node.id), ...req.removeIds ?? []].at(-1);
    if (failure === "result" || failure === "reject-before") {
      db.exec("CREATE TEMP TRIGGER fail_history BEFORE UPDATE OF rejected_at ON layers WHEN NEW.id = '" + target + "' BEGIN SELECT RAISE(ABORT, 'generated transaction rollback'); END");
    }
    try {
      const result = await bus.dispatch(name as never, req as never, context);
      if (failure === "reject-before" || failure === "reject-after") throw new Error("generated lost history reply");
      return result;
    } finally { db.exec("DROP TRIGGER IF EXISTS fail_history"); }
  });
  subscribers.clear();
  publications.mockClear();
  repacks.mockClear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Probe)); });
    await run({ arm: (failure: Failure) => { armed = failure; } });
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    destroyed = true;
    liveWindow.emit("closed");
    db.close();
  }
}

// A Vitest timeout aborts the signal before its finish hooks. Stop admitting
// fresh property cases and drain the current one before another test can bind
// the shared command bus to its own database. The original timeout still fails.
function drainPropertyOnFinish(context: TestContext, work: Promise<void>): Promise<void> {
  context.onTestFinished(async () => { await work.catch(() => undefined); });
  return work;
}

test("generated edit sessions agree with document/history stacks across rollback and lost replies", async (context) => {
  const error = console.error;
  const errors = vi.spyOn(console, "error").mockImplementation((message, ...args: unknown[]) => {
    if (message !== "editor undo failed" && message !== "editor redo failed" && message !== "Editor history replay failed") error(message, ...args);
  });
  try {
    // Each case migrates/queries real SQLite and may replay a group twice.
    // Bound the workload for the default 5s CI timeout; shrinking stays on.
    await drainPropertyOnFinish(context, fc.assert(fc.asyncProperty(
      fc.constantFrom<Action>("external", "delete", "replace"),
      command,
      fc.commands([command], { maxCommands: 16 }),
      async (intervening, generated, commands) => {
        context.signal.throwIfAborted();
        await withHarness(async (real) => {
          const model: Model = { live: new Map(), past: [], future: [], serial: 0 };
          // Generate complete user workflows as well as arbitrary suffixes, so
          // every run reaches a grouped restore instead of mostly skipped undo
          // commands on an empty document. Counts, kinds, fields and reply loss
          // remain generated and shrink with the command sequence.
          for (const action of ["create", intervening, "undo", "redo"] as const) {
            await new EditorCommand(action, generated.count, generated.kind, generated.value, generated.failure).run(model, real);
          }
          await fc.asyncModelRun(() => ({ model, real }), commands);
        });
      }
    ), { numRuns: 50 }));
  } finally { errors.mockRestore(); }
});

const patch = fc.record({
  kind: fc.constantFrom("geometry", "style"),
  x: fc.integer({ min: -100, max: 200 }),
  color: fc.constantFrom("auto", "#2489ff", "#ff8000")
});

test("generated newer snapshots supersede local create/reorder caches before later patches", async (context) => {
  await drainPropertyOnFinish(context, fc.assert(fc.asyncProperty(
    fc.boolean(), fc.integer({ min: -100, max: 200 }), fc.boolean(),
    async (reorder, value, visible) => {
      context.signal.throwIfAborted();
      await withHarness(async () => {
        const original = layer(1, "vector", value);
        // Model coalesced publication: only the later external state reaches
        // this editor; it never incorporates the exact local node.
        const listeners = [...subscribers];
        subscribers.clear();
        await edit({ kind: "upsert", node: original });
        if (reorder) await edit({ kind: "reorder", layerId: original.id, zIndex: 8000 });
        for (const listener of listeners) subscribers.add(listener);
        const persisted = listLayerTree(captureId)[0]!;
        const expected = { ...persisted, name: "external " + value, visible, z_index: 9000 };
        await act(async () => {
          expect((await bus.dispatch("layers:update", { captureId, layer: expected }, { principal: "ipc" })).ok).toBe(true);
        });
        await edit({ kind: "updateOverlay", layerId: original.id, patch: { kind: "arrow", color: "#ff8000" } });
        expect(listLayerTree(captureId)[0]).toMatchObject({ name: expected.name, visible, z_index: expected.z_index });
      });
    }
  ), { numRuns: 50 }));
});

test("generated odd edge crops preserve valid redo and source-pixel geometry across repeated history cycles", async (context) => {
  await drainPropertyOnFinish(context, fc.assert(fc.asyncProperty(
    fc.integer({ min: 256, max: 2047 }).map((size) => size * 2 + 1),
    fc.integer({ min: 256, max: 2047 }).map((size) => size * 2 + 1),
    fc.boolean(), fc.integer({ min: 0, max: 100 }),
    async (width, height, right, value) => {
      context.signal.throwIfAborted();
      await withHarness(async () => {
        db.prepare("UPDATE captures SET width_px = ?, height_px = ? WHERE id = ?").run(width, height, captureId);
        const source = { ...layer(1, "raster", 0), kind: "raster" as const, source_ref: { kind: "embedded" as const, sha256: "0".repeat(64) }, natural_width_px: width, natural_height_px: height };
        for (const node of [source, layer(2, "vector", value), layer(3, "effect", value)]) await edit({ kind: "upsert", node });
        await act(async () => {
          if (snapshot.kind !== "loaded") throw new Error("model not loaded");
          const rect = right ? { x: 0.5, y: 0, w: 0.5, h: 1 } : { x: 0, y: 0.5, w: 1, h: 0.5 };
          const result = await snapshot.dispatchEdit({ kind: "crop", rect });
          if (!result.ok || result.value.kind !== "crop") throw new Error("crop failed");
          history.recordCrop({ ...result.value.artifact, newWidthPx: result.value.artifact.widthPx, newHeightPx: result.value.artifact.heightPx });
        });
        const cropped = listLayerTree(captureId);
        for (let cycle = 0; cycle < 2; cycle++) {
          await act(async () => { await history.undo(); });
          expect(getCaptureById(captureId)).toMatchObject({ width_px: width, height_px: height });
          await act(async () => { await history.redo(); });
          expect(history.canRedo).toBe(false);
          expect(getCaptureById(captureId)).toMatchObject({ width_px: right ? Math.round(width / 2) : width, height_px: right ? height : Math.round(height / 2) });
          const restored = listLayerTree(captureId);
          for (const node of restored) LayerSchema.parse(node);
          for (const original of cropped.filter((node) => !(node.kind === "vector" && node.shape.kind === "crop"))) {
            const current = restored.find((node) => node.id === original.id)!;
            expect(current).toBeDefined();
            for (let i = 0; i < 6; i++) expect(current.transform[i]).toBeCloseTo(original.transform[i]!, 8);
            if (current.kind === "raster") expect(current).toMatchObject({ source_ref: source.source_ref, natural_width_px: width, natural_height_px: height });
            if (current.kind === "vector" && current.shape.kind === "arrow" && original.kind === "vector" && original.shape.kind === "arrow") {
              for (const point of ["from", "to"] as const) for (const axis of ["x", "y"] as const)
                expect(current.shape[point][axis]).toBeCloseTo(original.shape[point][axis], 8);
            }
            if (current.kind === "effect" && original.kind === "effect") {
              for (const axis of ["x", "y", "w", "h"] as const) expect(current.clip_rect![axis]).toBeCloseTo(original.clip_rect![axis], 8);
            }
          }
        }
      });
    }
  ), { numRuns: 25 }));
});

// Preserve 100 schedules in four independent batches, giving each a quarter
// of the former workload under the default 5s CI timeout.
for (const batch of [1, 2, 3, 4]) {
  test(`scheduled geometry/style replies preserve FIFO edits and a newer external field (batch ${batch})`, async (context) => {
    await drainPropertyOnFinish(context, fc.assert(fc.asyncProperty(
      fc.scheduler({ act: async (step) => { await act(step); } }),
      fc.array(patch, { minLength: 2, maxLength: 8 }),
      async (scheduler, patches) => {
        context.signal.throwIfAborted();
        await withHarness(async () => {
          const original = layer(1, "vector", 10);
          await edit({ kind: "upsert", node: original });
          if (original.kind !== "vector" || original.shape.kind !== "arrow") throw new Error("missing arrow");
          const expected = { ...original, name: "external field", shape: { ...original.shape } };
          const ordinary = dispatch.getMockImplementation()!;
          dispatch.mockImplementation(scheduler.scheduleFunction(ordinary));
          let work: Promise<unknown>[] = [];
          try {
            await act(async () => {
              expect((await bus.dispatch("layers:update", { captureId, layer: { ...original, name: expected.name } }, { principal: "ipc" })).ok).toBe(true);
              if (snapshot.kind !== "loaded") throw new Error("model not loaded");
              const edit = snapshot.dispatchEdit;
              work = patches.map((patch) => {
                if (patch.kind === "geometry") {
                  const from = { x: patch.x / 100, y: 0.25 };
                  const to = { x: 0.75, y: 0.875 };
                  expected.shape = { ...expected.shape, from, to };
                  return edit({ kind: "updateGeometry", layerId: original.id, geometry: { kind: "arrow", from, to } });
                }
                expected.shape = { ...expected.shape, color: patch.color };
                return edit({ kind: "updateOverlay", layerId: original.id, patch: { kind: "arrow", color: patch.color } });
              });
            });
            const results = await scheduler.waitFor(Promise.all(work));
            await scheduler.waitAll();
            for (const result of results) expect(result).toMatchObject({ ok: true });
            expect(listLayerTree(captureId)).toEqual([expected]);
            if (snapshot.kind !== "loaded") throw new Error("model not loaded");
            expect(snapshot.layers).toEqual([expected]);
            expect(snapshot.record.edits_version).toBe(getCaptureById(captureId)!.edits_version);
          } finally {
            // Release scheduled replies and settle queued writes even when an
            // assertion fails, before withHarness closes this SQLite connection.
            await scheduler.waitFor(Promise.allSettled(work));
            await scheduler.waitAll();
          }
        });
      }
    ), { numRuns: 25 }));
  });
}

test("a pending external refetch survives two queued geometry writes", async () => {
  // Plain regression for the scheduler's two-geometry-write counterexample.
  await withHarness(async () => {
    const original = layer(1, "vector", 10);
    await edit({ kind: "upsert", node: original });
    const ordinary = dispatch.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const readGate = new Promise<void>((resolve) => { release = resolve; });
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    dispatch.mockImplementation(async (name: string, req: unknown) => {
      const result = await ordinary(name, req);
      if (name === "library:byId") { started(); await readGate; }
      return result;
    });
    await act(async () => {
      expect((await bus.dispatch("layers:update", { captureId, layer: { ...original, name: "external field" } }, { principal: "ipc" })).ok).toBe(true);
      await startedGate;
    });
    let work: Promise<unknown>[] = [];
    await act(async () => {
      if (snapshot.kind !== "loaded") throw new Error("model not loaded");
      const edit = snapshot.dispatchEdit;
      work = [0, 0.5].map((x) => edit({ kind: "updateGeometry", layerId: original.id, geometry: { kind: "arrow", from: { x, y: 0.25 }, to: { x: 0.75, y: 0.875 } } }));
    });
    await act(async () => { release(); await Promise.all(work); });
    expect(listLayerTree(captureId)[0]).toMatchObject({ id: original.id, name: "external field", shape: { from: { x: 0.5, y: 0.25 } } });
  });
});
