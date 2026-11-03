// Unit tests for the editor's session-memory undo/redo hook. The hook
// hands layer ops to a `dispatchEdit` callback (wired from the resolved
// CaptureModel); tests stub that callback so we can assert the op shape
// without spinning up the main process.

import { act, createElement, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import { BundleLayerNode, type OverlayRow } from "@pwrsnap/shared";
import { registerCaptureUndoFallback, useEditMenuBridge } from "../../../lib/editMenuBridge";

import {
  useUndoRedo,
  type UndoRedoDispatchEdit,
  type UseUndoRedoResult
} from "../useUndoRedo";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

// A v2 dispatchEdit spy that records every op and returns plausible
// results. Tests assert against `dispatchEditMock.mock.calls`. Reset
// per-test in beforeEach.
const dispatchEditMock = vi.fn<UndoRedoDispatchEdit>();

beforeEach(() => {
  dispatchEditMock.mockReset();
  let n = 0;
  dispatchEditMock.mockImplementation(async (op) => {
    n += 1;
    if (op.kind === "upsert") {
      return { ok: true, value: { kind: "upsert", artifact: { format: 2, node: op.node } } };
    }
    if (op.kind === "delete") {
      return { ok: true, value: { kind: "delete" } };
    }
    if (op.kind === "crop") {
      return {
        ok: true,
        value: { kind: "crop", artifact: { previousWidthPx: 0, previousHeightPx: 0 } }
      };
    }
    if (op.kind === "updateGeometry" || op.kind === "updateOverlay") {
      return {
        ok: true,
        value: {
          kind: "update",
          artifact: {
            format: 2,
            node: makeNode(`fresh-${n}`),
            previousNode: makeNode(`previous-${n}`)
          }
        }
      };
    }
    return { ok: false, error: { kind: "validation", code: "unknown", message: op.kind } };
  });
});

function makeNode(id: string): BundleLayerNode {
  return {
    id,
    parent_id: null,
    kind: "vector",
    shape: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" },
    name: "Arrow",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 0,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-05-20T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-05-20T00:00:00.000Z"
  };
}

function makeRow(id: string): OverlayRow {
  return {
    id,
    capture_id: "cap-x",
    data: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: "auto" },
    schema_version: 1,
    source: "user",
    ai_run_id: null,
    z_index: 0,
    rejected_at: null,
    applied_at: "2026-05-20T00:00:00.000Z",
    superseded_by: null,
    created_at: "2026-05-20T00:00:00.000Z"
  };
}

// Tiny probe: surfaces the hook's full return value out to the test so
// we can drive recordCreate / undo / redo and inspect canUndo/canRedo.
type ProbeProps = {
  readonly captureId: string;
  readonly applyingRef?: React.RefObject<boolean>;
  readonly onSnapshot: (api: UseUndoRedoResult) => void;
  readonly onBeforeHistory?: () => Promise<boolean>;
};

function Probe(props: ProbeProps): null {
  const internal = useRef(false);
  const api = useUndoRedo({
    captureId: props.captureId,
    applyingRef: props.applyingRef ?? internal,
    dispatchEdit: dispatchEditMock,
    onBeforeHistory: props.onBeforeHistory
  });
  useEffect(() => {
    props.onSnapshot(api);
  });
  return null;
}

function BridgeProbe(props: ProbeProps) {
  useEditMenuBridge();
  return createElement(Probe, props);
}

type RerenderProbeProps = {
  readonly onSnapshot: (api: UseUndoRedoResult) => void;
  readonly onReady: (rerender: () => void) => void;
};

function RerenderProbe(props: RerenderProbeProps): null {
  const internal = useRef(false);
  const [, setTick] = useState(0);
  const api = useUndoRedo({
    captureId: "cap-1",
    applyingRef: internal,
    dispatchEdit: dispatchEditMock
  });
  useEffect(() => {
    props.onReady(() => setTick((tick) => tick + 1));
  }, [props]);
  useEffect(() => {
    props.onSnapshot(api);
  });
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactElement): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (host !== null) {
    document.body.removeChild(host);
    host = null;
  }
  root = null;
});

describe("useUndoRedo", () => {
  test("a busy undo owns opposite-direction menu admission instead of invoking the capture fallback", async () => {
    let api: UseUndoRedoResult | null = null;
    render(createElement(BridgeProbe, { captureId: "cap-1", onSnapshot: (a) => { api = a; } }));
    const fallback = { undo: vi.fn(), redo: vi.fn() };
    const unregister = registerCaptureUndoFallback(fallback);
    act(() => { api!.recordCreate(makeRow("pending"), { node: makeNode("pending") }); });
    let release!: (result: Awaited<ReturnType<UndoRedoDispatchEdit>>) => void;
    dispatchEditMock.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    let pending!: Promise<void>;
    try {
      await act(async () => { pending = api!.undo(); });
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true }));
      });
      await act(async () => {
        release({ ok: true, value: { kind: "delete" } });
        await pending;
      });
      expect(fallback.redo).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  test("unmount during reconciliation prevents a stale history dispatch", async () => {
    let api: UseUndoRedoResult | null = null;
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((done) => { release = done; });
    render(createElement(Probe, {
      captureId: "cap-1", onBeforeHistory: () => gate, onSnapshot: (a) => { api = a; }
    }));
    act(() => { api!.recordCreate(makeRow("old-session"), { node: makeNode("old-session") }); });
    let pending!: Promise<void>;
    await act(async () => { pending = api!.undo(); });
    await act(async () => { root!.render(null); });
    await act(async () => { release(false); await pending; });
    expect(dispatchEditMock).not.toHaveBeenCalled();
  });

  test("history admits one request while reconciliation waits, and reads the entry recorded during that wait", async () => {
    let api: UseUndoRedoResult | null = null;
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((done) => { release = done; });
    const before = vi.fn(() => gate);
    render(createElement(Probe, {
      captureId: "cap-1", onBeforeHistory: before, onSnapshot: (a) => { api = a; }
    }));
    act(() => { api!.recordCreate(makeRow("older"), { node: makeNode("older") }); });
    let undo!: Promise<void>;
    let redo!: Promise<void>;
    await act(async () => {
      undo = api!.undo();
      redo = api!.redo();
    });
    const admissions = before.mock.calls.length;
    await act(async () => {
      // Model the released gesture's record and completion in one task,
      // before React has republished a new API snapshot.
      api!.recordCreate(makeRow("released"), { node: makeNode("released") });
      release(false);
      await Promise.all([undo, redo]);
    });
    expect(admissions).toBe(1);
    expect(dispatchEditMock.mock.calls).toEqual([[{ kind: "delete", id: "released" }]]);
    expect(api!.canUndo).toBe(true);
  });

  test("overlapping redo requests restore an entry once", async () => {
    let api: UseUndoRedoResult | null = null;
    const applyingRef = { current: false };
    render(createElement(Probe, { captureId: "cap-1", applyingRef, onSnapshot: (a) => { api = a; } }));
    act(() => { api!.recordCreate(makeRow("redo"), { node: makeNode("redo") }); });
    await act(async () => { await api!.undo(); });
    dispatchEditMock.mockClear();
    let release!: (result: Awaited<ReturnType<UndoRedoDispatchEdit>>) => void;
    dispatchEditMock.mockImplementationOnce(() => new Promise((done) => { release = done; }));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = api!.redo();
      second = api!.redo();
    });
    const count = dispatchEditMock.mock.calls.length;
    await act(async () => {
      release({ ok: true, value: { kind: "upsert", artifact: { format: 2, node: makeNode("redo") } } });
      await Promise.all([first, second]);
    });
    expect(count).toBe(1);
    expect(applyingRef.current).toBe(false);
    await act(async () => { await api!.undo(); });
    expect(api!.canUndo).toBe(false);
  });

  test("overlapping undo requests replay the stack top once and keep the older entry", async () => {
    let api: UseUndoRedoResult | null = null;
    const applyingRef = { current: false };
    render(createElement(Probe, { captureId: "cap-1", applyingRef, onSnapshot: (a) => { api = a; } }));
    act(() => {
      api!.recordCreate(makeRow("older"), { node: makeNode("older") });
      api!.recordCreate(makeRow("newer"), { node: makeNode("newer") });
    });
    let resolve!: (result: Awaited<ReturnType<UndoRedoDispatchEdit>>) => void;
    dispatchEditMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = api!.undo();
      second = api!.undo();
    });
    expect(dispatchEditMock.mock.calls).toEqual([[{ kind: "delete", id: "newer" }]]);
    expect(applyingRef.current).toBe(true);
    await act(async () => {
      resolve({ ok: true, value: { kind: "delete" } });
      await Promise.all([first, second]);
    });
    expect(applyingRef.current).toBe(false);
    expect(api!.canUndo).toBe(true);
    await act(async () => { await api!.undo(); });
    expect(dispatchEditMock.mock.calls.at(-1)).toEqual([{ kind: "delete", id: "older" }]);
  });

  test("a failed undo remains available for retry and does not create redo history", async () => {
    let api: UseUndoRedoResult | null = null;
    render(createElement(Probe, { captureId: "cap-1", onSnapshot: (a) => { api = a; } }));
    act(() => { api!.recordCreate(makeRow("retry"), { node: makeNode("retry") }); });
    dispatchEditMock.mockResolvedValueOnce({
      ok: false, error: { kind: "validation", code: "refused", message: "fixture failure" }
    });
    await act(async () => { await api!.undo(); });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);
    await act(async () => { await api!.undo(); });
    expect(dispatchEditMock.mock.calls).toEqual([
      [{ kind: "delete", id: "retry" }], [{ kind: "delete", id: "retry" }]
    ]);
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);
  });

  test("keeps API identity stable across unrelated renders", () => {
    const snapshots: UseUndoRedoResult[] = [];
    let rerender: (() => void) | null = null;
    render(
      createElement(RerenderProbe, {
        onSnapshot: (api) => {
          snapshots.push(api);
        },
        onReady: (fn) => {
          rerender = fn;
        }
      })
    );

    const first = snapshots.at(-1)!;
    act(() => {
      rerender!();
    });

    expect(snapshots.at(-1)).toBe(first);
  });

  test("recordCreate then undo → dispatches layers:delete with the layer id", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const row = makeRow("row-A");
    act(() => {
      api!.recordCreate(row, { node: makeNode("row-A") });
    });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);

    await act(async () => {
      await api!.undo();
    });

    expect(dispatchEditMock).toHaveBeenCalledWith({ kind: "delete", id: "row-A" });
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);
  });

  test("recordDelete then undo → dispatches layers:upsert with the original node", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const row = makeRow("row-B");
    const node = makeNode("row-B");
    act(() => {
      api!.recordDelete(row, { node });
    });
    await act(async () => {
      await api!.undo();
    });

    // Undo of delete re-inserts the structurally-identical layer; the
    // node carries its original z_index so the restored layer comes
    // back where it was (layers:upsert preserves node.z_index when
    // bumpZIndexToMax isn't set).
    expect(dispatchEditMock).toHaveBeenCalledWith({ kind: "upsert", node });
  });

  test("recordDelete with a bare { id } ref (raster — no OverlayRow) round-trips undo/redo", async () => {
    // Rasters (pasted images, the captured cursor) have no overlay
    // projection, so their delete records an id-ref + the full node.
    // Pre-fix they recorded NOTHING: deleting the Cursor layer left the
    // editor history empty and Cmd+Z fell through to the Library's
    // capture-restore fallback, resurrecting an unrelated trashed
    // capture instead of the layer.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const rasterNode: BundleLayerNode = {
      id: "ras-cursor",
      parent_id: "grp_root",
      name: "Cursor",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 10, 20],
      z_index: 1,
      source: "user",
      ai_run_id: null,
      applied_at: "2026-01-01T00:00:00.000Z",
      rejected_at: null,
      superseded_by: null,
      created_at: "2026-01-01T00:00:00.000Z",
      kind: "raster",
      source_ref: { kind: "embedded", sha256: "c".repeat(64) },
      natural_width_px: 32,
      natural_height_px: 48
    };
    act(() => {
      api!.recordDelete({ id: "ras-cursor" }, { node: rasterNode });
    });
    await act(async () => {
      await api!.undo();
    });
    // Undo restores the raster via its node.
    expect(dispatchEditMock).toHaveBeenCalledWith({ kind: "upsert", node: rasterNode });
    await act(async () => {
      await api!.redo();
    });
    // Redo re-deletes by the recorded id — the only field replay reads.
    expect(dispatchEditMock).toHaveBeenCalledWith({ kind: "delete", id: "ras-cursor" });
  });

  test("undo then redo replays the original op", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const row = makeRow("row-C");
    const node = makeNode("row-C");
    act(() => {
      api!.recordCreate(row, { node });
    });
    await act(async () => {
      await api!.undo();
    });
    dispatchEditMock.mockClear();

    await act(async () => {
      await api!.redo();
    });

    // Redoing a `create` re-dispatches the upsert with the original
    // node — so the redone layer lands at the same logical position.
    expect(dispatchEditMock).toHaveBeenCalledWith({ kind: "upsert", node });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);
  });

  test("recording a new op clears the redo stack", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.recordCreate(makeRow("row-D"));
    });
    await act(async () => {
      await api!.undo();
    });
    expect(api!.canRedo).toBe(true);

    act(() => {
      api!.recordCreate(makeRow("row-E"));
    });
    expect(api!.canRedo).toBe(false);
  });

  test("applyingRef gate prevents the hook from re-recording its own replay", async () => {
    let api: UseUndoRedoResult | null = null;
    const applyingRef = { current: false };
    render(
      createElement(Probe, {
        captureId: "cap-1",
        applyingRef,
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Simulate the caller's persistOverlay path: after a successful
    // upsert, persistOverlay reads applyingRef. If we're applying,
    // we should NOT recordCreate. Here we exercise the inverse: the
    // hook should suppress its own re-entrant push during undo.
    act(() => {
      api!.recordCreate(makeRow("row-F"));
    });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);

    await act(async () => {
      await api!.undo();
    });

    // After undo: past should be empty, future should have one entry.
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);

    // Verify the applyingRef was set + cleared cleanly (not left true).
    expect(applyingRef.current).toBe(false);
  });

  test("v2 capture: recordCreate with node → undo routes through dispatchEdit (layers:delete)", async () => {
    let api: UseUndoRedoResult | null = null;
    // Spy dispatcher — every call lands here; the hook never touches
    // the bus directly when dispatchEdit is provided.
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async () => ({
      ok: true,
      value: { kind: "delete" }
    }));
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_v2",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    const row = makeRow("layer_A");
    // Cast to BundleLayerNode-shaped fixture; the hook only reads .id
    // off the node, so a minimal shape is enough for this assertion.
    const node = {
      id: "layer_A",
      kind: "vector",
      parent_id: null,
      shape: row.data,
      name: "Arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: row.applied_at,
      rejected_at: null,
      superseded_by: null,
      created_at: row.created_at
    } as unknown as Parameters<NonNullable<typeof api>["recordCreate"]>[1] extends infer T
      ? T extends { node?: infer N } | undefined
        ? N
        : never
      : never;
    act(() => {
      api!.recordCreate(row, { node });
    });

    await act(async () => {
      await api!.undo();
    });

    // The hook routes the inverse through dispatchEdit.
    expect(dispatchEdit).toHaveBeenCalledTimes(1);
    expect(dispatchEdit.mock.calls[0]?.[0]).toEqual({
      kind: "delete",
      id: "layer_A"
    });
  });

  test("v2 capture: undo + redo create round-trips through layers:upsert with original node", async () => {
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "delete")
        return { ok: true, value: { kind: "delete" } };
      if (op.kind === "upsert" && "node" in op)
        return {
          ok: true,
          value: {
            kind: "upsert",
            artifact: { format: 2, node: op.node }
          }
        };
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_v2",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    const row = makeRow("layer_B");
    const node = {
      id: "layer_B",
      kind: "vector",
      parent_id: null,
      shape: row.data,
      name: "Arrow",
      visible: true,
      locked: false,
      opacity: 1,
      blend_mode: "normal",
      transform: [1, 0, 0, 1, 0, 0],
      z_index: 0,
      source: "user",
      ai_run_id: null,
      applied_at: row.applied_at,
      rejected_at: null,
      superseded_by: null,
      created_at: row.created_at
    } as never;

    act(() => {
      api!.recordCreate(row, { node });
    });
    await act(async () => {
      await api!.undo();
    });
    await act(async () => {
      await api!.redo();
    });

    // Redo must dispatch an upsert with the ORIGINAL node (not a v1
    // overlay) so layers:upsert lands a structurally-identical layer.
    const upsertCalls = dispatchEdit.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "upsert"
    );
    expect(upsertCalls.length).toBe(1);
    expect((upsertCalls[0]![0] as { node: { id: string } }).node.id).toBe(
      "layer_B"
    );
  });

  test("recordCrop + undo dispatches crop with the previous-dims-normalized rect", async () => {
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "crop") {
        return {
          ok: true,
          value: {
            kind: "crop",
            artifact: { previousWidthPx: 0, previousHeightPx: 0 }
          }
        };
      }
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_v2",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    // Record a crop: pre-crop canvas 1000x1000, post-crop 500x500
    // (user cropped to 50%×50%).
    act(() => {
      api!.recordCrop({
        rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
        previousWidthPx: 1000,
        previousHeightPx: 1000,
        newWidthPx: 500,
        newHeightPx: 500
      });
    });

    await act(async () => {
      await api!.undo();
    });

    // Undo: restore previous dims. The dispatcher interprets `rect.w *
    // currentCanvasWidth` as the new width. Current canvas after the
    // crop is 500; restoring 1000 means rect.w = 1000/500 = 2.
    const cropCalls = dispatchEdit.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "crop"
    );
    expect(cropCalls.length).toBe(1);
    const sent = cropCalls[0]?.[0] as { rect: { w: number; h: number } };
    expect(sent.rect.w).toBe(2);
    expect(sent.rect.h).toBe(2);
  });

  test("recordCrop + undo of an OFF-ORIGIN crop dispatches the inverse rect with negative origin (otherwise raster + overlays don't return to start)", async () => {
    // PR #110 review: a user-reported bug. The undo path used to
    // pass `{ x: 0, y: 0, w: 1/cw, h: 1/ch }` regardless of the
    // forward crop's offset. For an edge-aligned crop that's fine
    // (origin was 0,0 already), but for a center crop the forward
    // dispatch translates the raster by (-cx × oldW, -cy × oldH);
    // the undo MUST translate by the inverse offset to restore the
    // identity transform. Math:
    //   forward: tx → tx - cx*W
    //   undo offset:  (-cx/cw) × newW = (-cx/cw) × (cw*W) = -cx*W
    //   undo transform delta: -(-cx*W) = +cx*W
    //   net: (tx - cx*W) + cx*W = tx  ✓
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "crop") {
        return {
          ok: true,
          value: {
            kind: "crop",
            artifact: { previousWidthPx: 0, previousHeightPx: 0 }
          }
        };
      }
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe3(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_v2",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe3));

    // Forward crop: center crop of a 2880×1920 canvas keeping the
    // middle 60% × 60% — matches the user's diagnostic on PR #110.
    act(() => {
      api!.recordCrop({
        rect: { x: 0.354, y: 0.187, w: 0.6, h: 0.6 },
        previousWidthPx: 2880,
        previousHeightPx: 1920,
        newWidthPx: 1728,
        newHeightPx: 1152
      });
    });

    await act(async () => {
      await api!.undo();
    });

    const cropCalls = dispatchEdit.mock.calls.filter(
      (c) => (c[0] as { kind: string }).kind === "crop"
    );
    expect(cropCalls.length).toBe(1);
    const sent = cropCalls[0]?.[0] as {
      rect: { x: number; y: number; w: number; h: number };
    };
    // inverse w = 1/0.6 ≈ 1.6667 (restores 2880 from 1728).
    expect(sent.rect.w).toBeCloseTo(2880 / 1728, 5);
    expect(sent.rect.h).toBeCloseTo(1920 / 1152, 5);
    // inverse x = -cx/cw — what makes the undo restore the raster's
    // identity transform. Pre-fix this was 0 and the user saw the
    // post-undo image at a different position than the original.
    expect(sent.rect.x).toBeCloseTo(-0.354 / 0.6, 5);
    expect(sent.rect.y).toBeCloseTo(-0.187 / 0.6, 5);
  });

  test("recordGeometry + undo dispatches updateGeometry with previousGeometry", async () => {
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "updateGeometry") {
        return {
          ok: true,
          value: {
            kind: "update",
            artifact: {
              format: 2,
              node: makeNode(`fresh-${Math.random()}`),
              previousNode: makeNode("previous")
            }
          }
        };
      }
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_1",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    const currentIdRef = { current: "ov_post" };
    act(() => {
      api!.recordGeometry({
        currentIdRef,
        previousGeometry: {
          kind: "arrow",
          from: { x: 0, y: 0 },
          to: { x: 0.5, y: 0.5 }
        },
        nextGeometry: {
          kind: "arrow",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 }
        }
      });
    });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);

    await act(async () => {
      await api!.undo();
    });

    // Undo should dispatch updateGeometry with the PREVIOUS geometry
    // against the chain's CURRENT id.
    expect(dispatchEdit).toHaveBeenCalledTimes(1);
    const call = dispatchEdit.mock.calls[0]?.[0] as {
      kind: string;
      layerId: string;
      geometry: { kind: string; to: { x: number } };
    };
    expect(call.kind).toBe("updateGeometry");
    expect(call.layerId).toBe("ov_post");
    expect(call.geometry.kind).toBe("arrow");
    expect(call.geometry.to.x).toBeCloseTo(0.5);
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);
  });

  test("recordGeometry + undo + redo round-trips through updateGeometry; currentIdRef follows new ids", async () => {
    let api: UseUndoRedoResult | null = null;
    let idCounter = 0;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "updateGeometry") {
        idCounter += 1;
        return {
          ok: true,
          value: {
            kind: "update",
            artifact: {
              format: 2,
              node: makeNode(`replay-${idCounter}`),
              previousNode: makeNode("previous")
            }
          }
        };
      }
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_1",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    const currentIdRef = { current: "ov_post" };
    act(() => {
      api!.recordGeometry({
        currentIdRef,
        previousGeometry: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 0.5, y: 0.5 } },
        nextGeometry: { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }
      });
    });
    await act(async () => {
      await api!.undo();
    });
    // After undo, the chain id has been re-anchored to the freshly-
    // inserted replay row. The id should NOT be `ov_post` anymore.
    expect(currentIdRef.current).toBe("replay-1");
    await act(async () => {
      await api!.redo();
    });
    expect(currentIdRef.current).toBe("replay-2");
    // Total dispatches: 1 undo + 1 redo = 2 updateGeometry calls.
    expect(dispatchEdit).toHaveBeenCalledTimes(2);
  });

  test("recordStyle + undo dispatches updateOverlay with previousPatch", async () => {
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "updateOverlay") {
        return {
          ok: true,
          value: {
            kind: "update",
            artifact: {
              format: 2,
              node: makeNode("fresh"),
              previousNode: makeNode("previous")
            }
          }
        };
      }
      return { ok: true, value: { kind: "delete" } };
    });
    function Probe2(): null {
      const internal = useRef(false);
      const a = useUndoRedo({
        captureId: "cap_1",
        applyingRef: internal,
        dispatchEdit
      });
      useEffect(() => {
        api = a;
      });
      return null;
    }
    render(createElement(Probe2));

    const currentIdRef = { current: "ov_post" };
    act(() => {
      api!.recordStyle({
        currentIdRef,
        previousPatch: { kind: "shape", color: "auto" },
        nextPatch: { kind: "shape", color: "#ff0000" }
      });
    });

    await act(async () => {
      await api!.undo();
    });

    const call = dispatchEdit.mock.calls[0]?.[0] as {
      kind: string;
      layerId: string;
      patch: { color: string };
    };
    expect(call.kind).toBe("updateOverlay");
    expect(call.layerId).toBe("ov_post");
    expect(call.patch.color).toBe("auto");
  });

  test("constrained shape kind and bounds undo together in one history step", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (snapshot) => {
          api = snapshot;
        }
      })
    );

    const rectangle = { x: 0.1, y: 0.2, w: 0.6, h: 0.3 };
    const circle = { x: 0.325, y: 0.2, w: 0.15, h: 0.3 };
    act(() => {
      api!.recordStyle({
        currentIdRef: { current: "ly_shape" },
        previousPatch: { kind: "shape", shape: "rect", rect: rectangle },
        nextPatch: { kind: "shape", shape: "circle", rect: circle }
      });
    });

    await act(async () => {
      await api!.undo();
    });

    // One Cmd+Z makes one complete update — never an intermediate
    // rectangle-in-a-circle-bounds (or circle-in-a-rectangle-bounds) state.
    expect(dispatchEditMock).toHaveBeenCalledTimes(1);
    expect(dispatchEditMock).toHaveBeenCalledWith({
      kind: "updateOverlay",
      layerId: "ly_shape",
      patch: { kind: "shape", shape: "rect", rect: rectangle }
    });
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);

    await act(async () => {
      await api!.redo();
    });
    expect(dispatchEditMock).toHaveBeenCalledTimes(2);
    expect(dispatchEditMock.mock.calls[1]?.[0]).toEqual({
      kind: "updateOverlay",
      layerId: "fresh-1",
      patch: { kind: "shape", shape: "circle", rect: circle }
    });
  });

  test("successive style entries undo one queued value at a time", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap_1",
        onSnapshot: (snapshot) => {
          api = snapshot;
        }
      })
    );

    // Mirrors red → blue before the layer model can refetch. The
    // second entry's inverse must be red, not the original green.
    act(() => {
      api!.recordStyle({
        currentIdRef: { current: "ly_arrow" },
        previousPatch: { kind: "arrow", color: "#28c840" },
        nextPatch: { kind: "arrow", color: "#ff5a5a" }
      });
      api!.recordStyle({
        currentIdRef: { current: "ly_arrow" },
        previousPatch: { kind: "arrow", color: "#ff5a5a" },
        nextPatch: { kind: "arrow", color: "#2489ff" }
      });
    });

    await act(async () => {
      await api!.undo();
    });
    await act(async () => {
      await api!.undo();
    });

    expect(dispatchEditMock.mock.calls.map(([op]) => op)).toEqual([
      {
        kind: "updateOverlay",
        layerId: "ly_arrow",
        patch: { kind: "arrow", color: "#ff5a5a" }
      },
      {
        kind: "updateOverlay",
        layerId: "ly_arrow",
        patch: { kind: "arrow", color: "#28c840" }
      }
    ]);
  });

  test("text re-edit then full undo rolls back in the user's expected order", async () => {
    // Executable spec for the text-edit undo bug. Repro: draw arrow1,
    // type "Hi Mom", draw arrow2, type "Hi Dad", then edit "Hi Mom" →
    // "Hi Mommy". ⌘Z must walk back as:
    //   Hi Mommy → Hi Mom, delete Hi Dad, delete arrow2,
    //   delete Hi Mom, delete arrow1
    //
    // Pre-fix the body edit recorded NOTHING on the stack, so the first
    // ⌘Z skipped straight to deleting "Hi Dad" and (because the edit had
    // also churned the text's layer id) the edited text could never be
    // removed. This pins both halves: the edit IS recorded (first undo
    // reverts the body), and the id is stable so the original create
    // entry still deletes "hiMom" near the end.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    act(() => {
      api!.recordCreate(makeRow("arrow1"), { node: makeNode("arrow1") });
      api!.recordCreate(makeRow("hiMom"), { node: makeNode("hiMom") });
      api!.recordCreate(makeRow("arrow2"), { node: makeNode("arrow2") });
      api!.recordCreate(makeRow("hiDad"), { node: makeNode("hiDad") });
      // The text body edit. updateOverlay now preserves the layer id, so
      // currentIdRef tracks the (unchanged) "hiMom".
      api!.recordStyle({
        currentIdRef: { current: "hiMom" },
        previousPatch: { kind: "text", body: "Hi Mom" },
        nextPatch: { kind: "text", body: "Hi Mommy" }
      });
    });

    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
    }

    const ops = dispatchEditMock.mock.calls.map((c) => c[0]);
    expect(ops).toEqual([
      // 1. Hi Mommy → Hi Mom (body reverted, NOT a delete).
      {
        kind: "updateOverlay",
        layerId: "hiMom",
        patch: { kind: "text", body: "Hi Mom" }
      },
      // 2-5. creates unwind in LIFO order, each deleting its own layer.
      { kind: "delete", id: "hiDad" },
      { kind: "delete", id: "arrow2" },
      { kind: "delete", id: "hiMom" },
      { kind: "delete", id: "arrow1" }
    ]);
  });

  test("geometry drag then full undo rolls back in the user's expected order", async () => {
    // Executable spec for the geometry-edit undo orphan. Repro: draw
    // arrow1, draw arrow2, drag arrow1 to a new spot, then ⌘Z must walk
    // back as:
    //   revert arrow1's drag, delete arrow2, delete arrow1
    //
    // Pre-fix the drag churned arrow1's layer id, so the original create
    // entry pointed at a dead id — the final ⌘Z that should delete
    // arrow1 was a silent no-op and arrow1 stayed on the canvas. With
    // applyGeometryToLayer preserving the id, currentIdRef tracks the
    // (unchanged) "arrow1" and the create entry still deletes it last.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const previousGeometry = {
      kind: "arrow" as const,
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.5, y: 0.5 }
    };
    act(() => {
      api!.recordCreate(makeRow("arrow1"), { node: makeNode("arrow1") });
      api!.recordCreate(makeRow("arrow2"), { node: makeNode("arrow2") });
      // The drag of arrow1. updateGeometry now preserves the layer id,
      // so currentIdRef tracks the (unchanged) "arrow1".
      api!.recordGeometry({
        currentIdRef: { current: "arrow1" },
        previousGeometry,
        nextGeometry: {
          kind: "arrow",
          from: { x: 0.3, y: 0.3 },
          to: { x: 0.8, y: 0.8 }
        }
      });
    });

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
    }

    const ops = dispatchEditMock.mock.calls.map((c) => c[0]);
    expect(ops).toEqual([
      // 1. revert arrow1's drag (geometry restored, NOT a delete).
      { kind: "updateGeometry", layerId: "arrow1", geometry: previousGeometry },
      // 2-3. creates unwind in LIFO order, each deleting its own layer —
      // arrow1's delete targets its ORIGINAL id (stable across the drag).
      { kind: "delete", id: "arrow2" },
      { kind: "delete", id: "arrow1" }
    ]);
  });

  test("MAX_DEPTH caps the past stack (older ops drop off the back)", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Push 102 ops; depth cap is 100.
    act(() => {
      for (let i = 0; i < 102; i++) {
        api!.recordCreate(makeRow(`row-${i}`));
      }
    });

    // Drain the entire past stack — should take exactly 100 undos.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 200) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(100);
  });
  test("recordReplace (an eraser pass) undoes and redoes as ONE step, restoring before removing", async () => {
    // The eraser swaps every stroke it crossed for that stroke's pieces.
    // ⌘Z must put all of it back in one keystroke, and each replay must
    // add the other side BEFORE removing this one, so a failure halfway
    // leaves an extra stroke rather than a hole.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );
    const original = makeNode("stroke-orig");
    const pieceA = makeNode("piece-a");
    const pieceB = makeNode("piece-b");
    act(() => {
      api!.recordReplace({
        removed: [{ row: { id: original.id }, node: original }],
        added: [
          { row: { id: pieceA.id }, node: pieceA },
          { row: { id: pieceB.id }, node: pieceB }
        ]
      });
    });
    expect(api!.canUndo).toBe(true);

    await act(async () => {
      await api!.undo();
    });
    expect(dispatchEditMock.mock.calls.map(([op]) => op)).toEqual([
      { kind: "upsert", node: original },
      { kind: "delete", id: "piece-a" },
      { kind: "delete", id: "piece-b" }
    ]);
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);

    dispatchEditMock.mockClear();
    await act(async () => {
      await api!.redo();
    });
    expect(dispatchEditMock.mock.calls.map(([op]) => op)).toEqual([
      { kind: "upsert", node: pieceA },
      { kind: "upsert", node: pieceB },
      { kind: "delete", id: "stroke-orig" }
    ]);
    expect(api!.canUndo).toBe(true);
  });
});

describe("useUndoRedo partial replay retries", () => {
  function node(label: string): BundleLayerNode {
    return BundleLayerNode.parse(makeNode(label.padEnd(16, "_")));
  }

  /** layers-repo.insertLayer restores rejected rows, but a live id always
   * fails with insert_failed. A transient failure has that same code: the
   * hook must distinguish acknowledged progress, never guess from errors. */
  function persistence(liveNodes: BundleLayerNode[]) {
    const state = {
      live: new Map(liveNodes.map((entry) => [entry.id, entry])),
      calls: [] as string[],
      conflicts: 0,
      failOnceAt: null as string | null
    };
    dispatchEditMock.mockImplementation(async (op) => {
      if (op.kind !== "upsert" && op.kind !== "delete") throw new Error("unexpected fixture operation");
      const id = op.kind === "upsert" ? op.node.id : op.id;
      const call = `${op.kind}:${id}`;
      state.calls.push(call);
      if (state.failOnceAt === call) {
        state.failOnceAt = null;
        return { ok: false, error: { kind: "persistence", code: "insert_failed", message: "transient fixture failure" } };
      }
      if (op.kind === "upsert") {
        BundleLayerNode.parse(op.node);
        if (state.live.has(id)) {
          state.conflicts += 1;
          return { ok: false, error: { kind: "persistence", code: "insert_failed", message: "UNIQUE constraint failed: layers.id" } };
        }
        state.live.set(id, op.node);
        return { ok: true, value: { kind: "upsert", artifact: { format: 2, node: op.node } } };
      }
      state.live.delete(id);
      return { ok: true, value: { kind: "delete" } };
    });
    return state;
  }

  function mountProbe() {
    const current = { api: null as UseUndoRedoResult | null };
    render(createElement(Probe, { captureId: "cap-1", onSnapshot: (api) => { current.api = api; } }));
    return current;
  }

  function recordPair(api: UseUndoRedoResult, kind: "create" | "delete", nodes: BundleLayerNode[]) {
    const token = api.beginInteraction("batch", "pair");
    for (const entry of nodes) {
      api[kind === "create" ? "recordCreate" : "recordDelete"]({ id: entry.id }, {
        node: entry, opKind: "batch", layerId: "pair", mergeMode: "append"
      });
    }
    api.endInteraction(token);
  }

  test.each(["undo-delete", "redo-create"] as const)("%s retries only the failed restore, then reaches earlier history", async (scenario) => {
    const a = node("a");
    const b = node("b");
    const older = node("older");
    const state = persistence(scenario === "redo-create" ? [a, b, older] : [older]);
    const current = mountProbe();
    act(() => {
      current.api!.recordCreate({ id: older.id }, { node: older });
      recordPair(current.api!, scenario === "redo-create" ? "create" : "delete", [a, b]);
    });
    if (scenario === "redo-create") await act(async () => { await current.api!.undo(); });
    state.calls.length = 0;
    state.failOnceAt = `upsert:${b.id}`;
    const direction = scenario === "redo-create" ? "redo" : "undo";
    await act(async () => { await current.api![direction](); });
    expect(new Set(state.live.keys())).toEqual(new Set([a.id, older.id]));
    await act(async () => { await current.api![direction](); });
    expect(new Set(state.live.keys())).toEqual(new Set([a.id, b.id, older.id]));
    expect(state.calls).toEqual([`upsert:${a.id}`, `upsert:${b.id}`, `upsert:${b.id}`]);
    expect(state.conflicts).toBe(0);
    expect(current.api!.canUndo).toBe(true);
    expect(current.api!.canRedo).toBe(direction === "undo");
    if (direction === "redo") await act(async () => { await current.api!.undo(); });
    await act(async () => { await current.api!.undo(); });
    expect(state.live.has(older.id)).toBe(false);
    expect(current.api!.canUndo).toBe(false);
  });

  test.each([
    { direction: "undo", failure: "restore" }, { direction: "redo", failure: "restore" },
    { direction: "undo", failure: "remove" }, { direction: "redo", failure: "remove" }
  ] as const)("replace $direction resumes after a failed second $failure without replaying successful writes", async ({ direction, failure }) => {
    const removed = [node("a"), node("b")];
    const added = [node("c"), node("d")];
    const state = persistence(added);
    const current = mountProbe();
    act(() => {
      current.api!.recordReplace({
        removed: removed.map((entry) => ({ row: { id: entry.id }, node: entry })),
        added: added.map((entry) => ({ row: { id: entry.id }, node: entry }))
      });
    });
    if (direction === "redo") await act(async () => { await current.api!.undo(); });
    state.calls.length = 0;
    const restore = direction === "undo" ? removed : added;
    const take = direction === "undo" ? added : removed;
    const steps = [...restore.map((entry) => `upsert:${entry.id}`), ...take.map((entry) => `delete:${entry.id}`)];
    const failureIndex = failure === "restore" ? 1 : 3;
    state.failOnceAt = steps[failureIndex]!;
    await act(async () => { await current.api![direction](); });
    expect(current.api!.canUndo).toBe(direction === "undo");
    expect(current.api!.canRedo).toBe(direction === "redo");
    await act(async () => { await current.api![direction](); });
    expect(state.calls).toEqual([...steps.slice(0, failureIndex + 1), ...steps.slice(failureIndex)]);
    expect(new Set(state.live.keys())).toEqual(new Set(restore.map((entry) => entry.id)));
    expect(state.conflicts).toBe(0);
    expect(current.api!.canUndo).toBe(direction === "redo");
    expect(current.api!.canRedo).toBe(direction === "undo");
    // Completion retires this direction's cursor: a reverse cycle and a
    // fresh replay of the same operation must execute every step again.
    await act(async () => { await current.api![direction === "undo" ? "redo" : "undo"](); });
    await act(async () => { await current.api![direction](); });
    expect(state.calls.slice(-4)).toEqual(steps);
    expect(new Set(state.live.keys())).toEqual(new Set(restore.map((entry) => entry.id)));
  });

  test("a later tagged push cannot coalesce into a partially restored entry or erase its retry progress", async () => {
    const a = node("a");
    const b = node("b");
    const c = node("c");
    const state = persistence([c]);
    const current = mountProbe();
    const tags = { opKind: "delete", layerId: "selection", mergeMode: "append" } as const;
    let token!: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = current.api!.beginInteraction(tags.opKind, tags.layerId);
      current.api!.recordDelete({ id: a.id }, { ...tags, node: a });
      current.api!.recordDelete({ id: b.id }, { ...tags, node: b });
    });
    state.failOnceAt = `upsert:${b.id}`;
    await act(async () => { await current.api!.undo(); });
    await act(async () => {
      await dispatchEditMock({ kind: "delete", id: c.id });
      current.api!.recordDelete({ id: c.id }, { ...tags, node: c });
      current.api!.endInteraction(token);
    });
    state.calls.length = 0;
    await act(async () => { await current.api!.undo(); });
    expect(state.calls).toEqual([`upsert:${c.id}`]);
    await act(async () => { await current.api!.undo(); });
    expect(state.calls).toEqual([`upsert:${c.id}`, `upsert:${b.id}`]);
    expect(new Set(state.live.keys())).toEqual(new Set([a.id, b.id, c.id]));
    expect(current.api!.canUndo).toBe(false);
    expect(state.conflicts).toBe(0);
  });

  test("an unacknowledged live-id conflict stays a failure on every retry", async () => {
    const a = node("a");
    const b = node("b");
    const state = persistence([a]);
    const current = mountProbe();
    act(() => { recordPair(current.api!, "delete", [a, b]); });
    await act(async () => { await current.api!.undo(); });
    await act(async () => { await current.api!.undo(); });
    expect(state.calls).toEqual([`upsert:${a.id}`, `upsert:${a.id}`]);
    expect(state.conflicts).toBe(2);
    expect(new Set(state.live.keys())).toEqual(new Set([a.id]));
    expect(current.api!.canUndo).toBe(true);
    expect(current.api!.canRedo).toBe(false);
  });
});
