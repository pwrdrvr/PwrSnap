import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { BundleLayerNode } from "@pwrsnap/shared";
import { useUndoRedo, type UseUndoRedoResult } from "../useUndoRedo";
import { historyPersistenceOracle } from "./history-persistence-oracle";

function node(index: number): BundleLayerNode {
  return BundleLayerNode.parse({
    id: index.toString(16).padStart(16, "0"), parent_id: null,
    kind: "vector", shape: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" },
    name: "Model arrow", visible: true, locked: false, opacity: 1,
    blend_mode: "normal", transform: [1, 0, 0, 1, 0, 0], z_index: index,
    source: "user", ai_run_id: null, applied_at: null, rejected_at: null,
    superseded_by: null, created_at: "2026-11-04T00:00:00Z"
  });
}

/** Persistence oracle: schema-validate writes and reject live-ID restores.
 * Missing deletes are also flagged as invalid replay attempts, even though
 * the production handler tolerates them as idempotent agent retries. */
async function mount(onBeforeHistory?: () => Promise<boolean>) {
  const state = historyPersistenceOracle();
  const { live, invalid, calls, dispatch } = state;
  let api!: UseUndoRedoResult;
  function Probe() {
    const value = useUndoRedo({ captureId: "model-capture", dispatchEdit: dispatch, onBeforeHistory });
    useEffect(() => { api = value; });
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Probe)); });
  let closed = false;
  return {
    get api() { return api; }, live, invalid, calls, dispatch,
    failOnce(key: string) { state.failOnceAt = key; },
    async close() {
      if (closed) return;
      closed = true;
      await act(async () => { root.unmount(); });
      host.remove();
    }
  };
}

type Real = Awaited<ReturnType<typeof mount>>;
// The model stores documents the user saw, not EditOps, merge keys, timers,
// replay cursors or dispatcher results. One closed gesture is one snapshot.
type Model = { documents: string[][]; cursor: number; nextId: number };
const documentAt = (model: Readonly<Model>) => model.documents[model.cursor]!;
function commit(model: Model, ids: string[]) {
  model.documents = [...model.documents.slice(0, model.cursor + 1), [...ids].sort()];
  model.cursor += 1;
}
function assertDocument(real: Real, expected: string[]) {
  expect([...real.live.keys()].sort()).toEqual([...expected].sort());
  expect(real.invalid).toEqual([]);
}
function assertModel(model: Model, real: Real) {
  assertDocument(real, documentAt(model));
  expect(real.api.canUndo).toBe(model.cursor > 0);
  expect(real.api.canRedo).toBe(model.cursor < model.documents.length - 1);
}
async function write(real: Real, kind: "create" | "delete", nodes: BundleLayerNode[], bracket = true) {
  const token = bracket ? real.api.beginInteraction("gesture", "selection") : null;
  for (const entry of nodes) {
    const result = await real.dispatch(kind === "create" ? { kind: "upsert", node: entry } : { kind: "delete", id: entry.id });
    expect(result.ok).toBe(true);
    real.api[kind === "create" ? "recordCreate" : "recordDelete"]({ id: entry.id }, {
      node: entry, ...(bracket ? { opKind: "gesture", layerId: "selection", mergeMode: "append" as const } : {})
    });
  }
  if (token !== null) real.api.endInteraction(token);
}

type Action = "draw" | "delete" | "replace" | "interleave" | "undo" | "redo" | "double-undo" | "double-redo";
class UserAction implements fc.AsyncCommand<Model, Real> {
  constructor(readonly kind: Action, readonly size: number, readonly offset: number) {}
  check(model: Readonly<Model>) {
    if (this.kind.endsWith("undo")) return model.cursor > 0;
    if (this.kind.endsWith("redo")) return model.cursor < model.documents.length - 1;
    return this.kind === "draw" || documentAt(model).length >= (this.kind === "interleave" ? 2 : 1);
  }
  async run(model: Model, real: Real) {
    await act(async () => {
      if (this.kind.endsWith("undo") || this.kind.endsWith("redo")) {
        const direction = this.kind.endsWith("undo") ? "undo" : "redo";
        const api = real.api;
        // Same-render double taps overlap at reconciliation. They must not
        // replay one entry twice or let the second request pop an older entry.
        if (this.kind.startsWith("double")) await Promise.all([api[direction](), api[direction]()]);
        else await api[direction]();
        model.cursor += direction === "undo" ? -1 : 1;
        return;
      }
      const before = documentAt(model);
      if (this.kind === "draw") {
        const added = Array.from({ length: this.size }, () => node(model.nextId++));
        await write(real, "create", added);
        commit(model, [...before, ...added.map((entry) => entry.id)]);
        return;
      }
      const selected = Array.from({ length: Math.min(this.size, before.length) }, (_, i) => before[(this.offset + i) % before.length]!);
      const removed = selected.map((id) => real.live.get(id)!);
      if (this.kind === "interleave") {
        const [a, b] = [real.live.get(before[0]!)!, real.live.get(before[1]!)!];
        const token = real.api.beginInteraction("gesture", "selection");
        const taggedDelete = async (entry: BundleLayerNode) => {
          expect((await real.dispatch({ kind: "delete", id: entry.id })).ok).toBe(true);
          real.api.recordDelete({ id: entry.id }, { node: entry, opKind: "gesture", layerId: "selection", mergeMode: "append" });
        };
        await taggedDelete(a);
        commit(model, before.filter((id) => id !== a.id));
        const landing = node(model.nextId++);
        await write(real, "create", [landing], false);
        commit(model, [...documentAt(model), landing.id]);
        await taggedDelete(b);
        commit(model, documentAt(model).filter((id) => id !== b.id));
        real.api.endInteraction(token);
        return;
      }
      const remaining = before.filter((id) => !selected.includes(id));
      if (this.kind === "delete") {
        await write(real, "delete", removed);
        commit(model, remaining);
        return;
      }
      const added = [node(model.nextId++)];
      for (const entry of added) expect((await real.dispatch({ kind: "upsert", node: entry })).ok).toBe(true);
      for (const entry of removed) expect((await real.dispatch({ kind: "delete", id: entry.id })).ok).toBe(true);
      real.api.recordReplace({
        removed: removed.map((entry) => ({ row: { id: entry.id }, node: entry })),
        added: added.map((entry) => ({ row: { id: entry.id }, node: entry }))
      });
      commit(model, [...remaining, ...added.map((entry) => entry.id)]);
    });
    assertModel(model, real);
  }
  toString() { return `${this.kind}(${this.size},${this.offset})`; }
}

describe("editor history document oracle", () => {
  test("one draw followed by a same-render double Undo deletes the layer once", async () => {
    const real = await mount();
    const model: Model = { documents: [[]], cursor: 0, nextId: 1 };
    try {
      await new UserAction("draw", 1, 0).run(model, real);
      await new UserAction("double-undo", 1, 0).run(model, real);
      expect(real.calls.filter((call) => call.startsWith("delete:"))).toHaveLength(1);
    } finally { await real.close(); }
  });

  test("a two-layer Undo failure rolls back before retrying the whole group", async () => {
    const real = await mount();
    const a = node(1);
    const b = node(2);
    try {
      await act(async () => { await write(real, "create", [a, b]); });
      real.calls.length = 0;
      real.failOnce(`delete:${b.id}`);
      await act(async () => { await real.api.undo(); });
      assertDocument(real, [a.id, b.id]);
      await act(async () => { await real.api.undo(); });
      assertDocument(real, []);
      expect(real.calls).toEqual([`delete:${a.id}`, `delete:${b.id}`, `delete:${a.id}`, `delete:${b.id}`]);
    } finally { await real.close(); }
  });

  test("generated user sessions visit the document snapshots in gesture order", async () => {
    const action = fc.tuple(fc.constantFrom<Action>("draw", "draw", "delete", "replace", "interleave", "undo", "redo", "double-undo", "double-redo"), fc.integer({ min: 1, max: 3 }), fc.nat({ max: 20 }))
      .map(([kind, size, offset]) => new UserAction(kind, size, offset));
    await fc.assert(fc.asyncProperty(fc.commands([action], { maxCommands: 25 }), async (commands) => {
      const real = await mount();
      const model: Model = { documents: [[]], cursor: 0, nextId: 1 };
      try {
        await fc.asyncModelRun(() => ({ model, real }), commands);
        // Never settle for a coincidentally matching final document: drain
        // every undo/redo and verify all remaining user-visible checkpoints.
        while (model.cursor > 0) await new UserAction("undo", 1, 0).run(model, real);
        while (model.cursor < model.documents.length - 1) await new UserAction("redo", 1, 0).run(model, real);
      } finally { await real.close(); }
    }), { numRuns: 300 });
  });

  test("generated atomic failure cut points preserve the committed document and recovery", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 2, max: 8 }), fc.nat({ max: 20 }), fc.constantFrom("undo", "redo"), fc.constantFrom("retry", "reverse", "edit"),
      async (size, cut, direction, recovery) => {
        const real = await mount();
        const nodes = Array.from({ length: size }, (_, i) => node(i + 1));
        const ids = nodes.map((entry) => entry.id);
        const prefixSize = 1 + cut % (size - 1);
        const before = direction === "redo" ? [] : ids;
        const after = direction === "redo" ? ids : [];
        try {
          await act(async () => { await write(real, "create", nodes); });
          if (direction === "redo") await act(async () => { await real.api.undo(); });
          real.failOnce(`${direction === "redo" ? "upsert" : "delete"}:${ids[prefixSize]}`);
          await act(async () => { await real.api[direction](); });
          assertDocument(real, before);
          if (recovery === "retry") {
            await act(async () => { await real.api[direction](); });
            assertDocument(real, direction === "redo" ? ids : []);
            await act(async () => { await real.api[direction === "redo" ? "undo" : "redo"](); });
            assertDocument(real, direction === "redo" ? [] : ids);
          } else if (recovery === "reverse") {
            await act(async () => { await real.api[direction === "redo" ? "undo" : "redo"](); });
            assertDocument(real, before);
            await act(async () => { await real.api[direction](); });
            assertDocument(real, after);
            await act(async () => { await real.api[direction](); });
            assertDocument(real, direction === "redo" ? ids : []);
          } else {
            const landing = node(size + 1);
            await act(async () => { await write(real, "create", [landing]); });
            assertDocument(real, [...before, landing.id]);
            await act(async () => { await real.api.undo(); });
            assertDocument(real, before);
            await act(async () => { await real.api.undo(); });
            assertDocument(real, []);
          }
        } finally { await real.close(); }
      }
    ), { numRuns: 300 });
  });

  test("scheduled reconciliation, new writes and unmount agree with their external serial order", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("edit", "unmount"), async (scheduler, action) => {
      const order: string[] = [];
      const real = await mount(() => scheduler.schedule(Promise.resolve(false), "release reconciliation").then((value) => {
        order.push("history");
        return value;
      }));
      const [a, b, c] = [node(1), node(2), node(3)];
      try {
        await act(async () => { await write(real, "create", [a]); await write(real, "create", [b]); });
        let history!: Promise<void>;
        let overlap!: Promise<void>;
        await act(async () => {
          const api = real.api;
          history = api.undo();
          overlap = api.redo();
        });
        const external = scheduler.schedule(Promise.resolve(), action).then(async () => {
          order.push(action);
          if (action === "unmount") await real.close();
          else await write(real, "create", [c]);
        });
        await act(async () => { await scheduler.waitIdle(); await Promise.all([history, overlap, external]); });
        // The oracle uses only the release order of external events, never
        // the hook's stack, selected replay entry, or persistence call count.
        const historyFirst = order[0] === "history";
        const expected = action === "unmount" ? (historyFirst ? [a.id] : [a.id, b.id]) :
          (historyFirst ? [a.id, c.id] : [a.id, b.id]);
        assertDocument(real, expected);
      } finally { await real.close(); }
    }), { numRuns: 100 });
  });
});
