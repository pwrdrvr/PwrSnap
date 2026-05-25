// Unit tests for the editor's session-memory undo/redo hook. The hook
// dispatches `overlays:upsert` / `overlays:delete` via the renderer's
// `dispatch` shim; tests stub the shim so we can assert IPC shape
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
import type { OverlayRow } from "@pwrsnap/shared";

// Stub the dispatch surface BEFORE importing the hook so the import
// resolves the mocked module. Each test resets the mock's call log.
const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

import {
  useUndoRedo,
  type UndoRedoDispatchEdit,
  type UseUndoRedoResult
} from "../useUndoRedo";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  dispatchMock.mockReset();
  // Default: every dispatch resolves to an ok-Result with a synthetic
  // OverlayRow whose id is derived from the call count so tests can
  // distinguish round-trips.
  let n = 0;
  dispatchMock.mockImplementation(async (name: string, _req: unknown) => {
    n += 1;
    if (name === "overlays:upsert") {
      return { ok: true, value: makeRow(`fresh-${n}`) };
    }
    if (name === "overlays:delete") {
      return { ok: true, value: undefined };
    }
    return { ok: false, error: { kind: "validation", code: "unknown", message: name } };
  });
});

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
    applyingRef: props.applyingRef ?? internal
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
  test("recordCreate then undo → dispatches overlays:delete with the row id", async () => {
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
      api!.recordCreate(row);
    });
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);

    await act(async () => {
      await api!.undo();
    });

    expect(dispatchMock).toHaveBeenCalledWith("overlays:delete", { id: "row-A" });
    expect(api!.canUndo).toBe(false);
    expect(api!.canRedo).toBe(true);
  });

  test("recordDelete then undo → dispatches overlays:upsert with the row's data", async () => {
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
    act(() => {
      api!.recordDelete(row);
    });
    await act(async () => {
      await api!.undo();
    });

    expect(dispatchMock).toHaveBeenCalledWith("overlays:upsert", {
      captureId: "cap-1",
      overlay: row.data
    });
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
    act(() => {
      api!.recordCreate(row);
    });
    await act(async () => {
      await api!.undo();
    });
    dispatchMock.mockClear();

    await act(async () => {
      await api!.redo();
    });

    // Redoing a `create` re-dispatches the upsert with the row's data.
    expect(dispatchMock).toHaveBeenCalledWith("overlays:upsert", {
      captureId: "cap-1",
      overlay: row.data
    });
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

    // The hook MUST go through dispatchEdit — NOT touch the bus
    // directly with overlays:* (which would be refused on v2).
    expect(dispatchMock).not.toHaveBeenCalled();
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

  test("recordGeometry + undo dispatches updateGeometry with previousGeometry", async () => {
    let api: UseUndoRedoResult | null = null;
    const dispatchEdit = vi.fn<UndoRedoDispatchEdit>(async (op) => {
      if (op.kind === "updateGeometry") {
        return {
          ok: true,
          value: {
            kind: "update",
            artifact: { format: 1, row: makeRow(`fresh-${Math.random()}`) }
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
            artifact: { format: 1, row: makeRow(`replay-${idCounter}`) }
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
            artifact: { format: 1, row: makeRow("fresh") }
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
