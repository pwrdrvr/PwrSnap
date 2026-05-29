// Unit tests for the editor's session-memory undo/redo hook. The hook
// hands layer ops to a `dispatchEdit` callback (wired from the resolved
// CaptureModel); tests stub that callback so we can assert the op shape
// without spinning up the main process.

import { act, createElement, useEffect, useRef } from "react";
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
import type { BundleLayerNode, OverlayRow } from "@pwrsnap/shared";

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
        value: { kind: "update", artifact: { format: 2, node: makeNode(`fresh-${n}`) } }
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
};

function Probe(props: ProbeProps): null {
  const internal = useRef(false);
  const api = useUndoRedo({
    captureId: props.captureId,
    applyingRef: props.applyingRef ?? internal,
    dispatchEdit: dispatchEditMock
  });
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
    expect((upsertCalls[0]?.[0] as { node: { id: string } }).node.id).toBe(
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
            artifact: { format: 2, node: makeNode(`fresh-${Math.random()}`) }
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
            artifact: { format: 2, node: makeNode(`replay-${idCounter}`) }
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
            artifact: { format: 2, node: makeNode("fresh") }
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
        previousPatch: { kind: "rect", color: "auto" },
        nextPatch: { kind: "rect", color: "#ff0000" }
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
});
