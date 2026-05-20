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

import { useUndoRedo, type UseUndoRedoResult } from "../useUndoRedo";

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
