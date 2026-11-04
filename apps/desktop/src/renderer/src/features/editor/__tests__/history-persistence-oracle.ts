// Strict map oracle for the hook-only suites. A history request validates
// every write against a staged document and publishes it only on success.
// The SQLite suite separately verifies real transactions and replay receipts.
import { BundleLayerNode } from "@pwrsnap/shared";
import type { LayerEditOp } from "../useCaptureModel";
import type { UndoRedoDispatchEdit } from "../useUndoRedo";

export function historyPersistenceOracle(liveNodes: BundleLayerNode[] = []) {
  const state = {
    live: new Map(liveNodes.map((node) => [node.id, node])),
    calls: [] as string[],
    invalid: [] as string[],
    conflicts: 0,
    failOnceAt: null as string | null
  };
  const failure = (message: string) => ({
    ok: false as const,
    error: { kind: "persistence" as const, code: "insert_failed", message }
  });
  function apply(live: Map<string, BundleLayerNode>, op: Extract<LayerEditOp, { kind: "upsert" | "delete" }>) {
    const id = op.kind === "upsert" ? BundleLayerNode.parse(op.node).id : op.id;
    const key = op.kind + ":" + id;
    state.calls.push(key);
    if (state.failOnceAt === key) {
      state.failOnceAt = null;
      return failure("generated transient failure");
    }
    if ((op.kind === "upsert") === live.has(id)) {
      state.invalid.push(key);
      state.conflicts += 1;
      return failure("invalid live-ID transition");
    }
    if (op.kind === "upsert") {
      live.set(id, op.node);
      return { ok: true as const, value: { kind: "upsert" as const, artifact: { format: 2 as const, node: op.node } } };
    }
    live.delete(id);
    return { ok: true as const, value: { kind: "delete" as const } };
  }
  const dispatch: UndoRedoDispatchEdit = async (op) => {
    if (op.kind === "historyAck") return { ok: true, value: { kind: "historyAck" } };
    if (op.kind === "historyReplay") {
      const staged = new Map(state.live);
      const removals = op.removeIds.flatMap((id) => staged.get(id) ?? []);
      for (const node of op.restore) {
        const result = apply(staged, { kind: "upsert", node });
        if (!result.ok) return result;
      }
      for (const id of op.removeIds) {
        const result = apply(staged, { kind: "delete", id });
        if (!result.ok) return result;
      }
      state.live.clear();
      for (const [id, node] of staged) state.live.set(id, node);
      return { ok: true, value: { kind: "historyReplay", removals } };
    }
    if (op.kind === "upsert" || op.kind === "delete") return apply(state.live, op);
    throw new Error("unexpected history oracle operation: " + op.kind);
  };
  return Object.assign(state, { dispatch });
}
