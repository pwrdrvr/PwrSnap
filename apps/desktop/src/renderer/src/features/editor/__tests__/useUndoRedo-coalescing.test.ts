// Coalescing tests for the editor's undo/redo hook — plan Alt 5
// (mouse-up boundary + 300ms grace window per (layer id, op kind)).
//
// Scenarios covered:
//   1. Continuous drag (5 intermediate writes within a single
//      beginInteraction/endInteraction pair) → 1 undo step.
//   2. 5 rapid color-burst clicks (no interaction tokens; same
//      layerId + opKind="setColor"; all within 200ms) → 1 undo step.
//   3. 5 clicks spaced 400ms apart → 5 separate undo steps (grace
//      window exceeded between each).
//   4. Drag followed by separate click 50ms after pointerup → 2
//      separate undo entries.
//   5. Drag against layer A then drag against layer B → 2 separate
//      undo entries.
//
// We control time via vi.spyOn(performance, "now") so the test
// doesn't have to actually sleep.

import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance
} from "vitest";
import type { OverlayRow } from "@pwrsnap/shared";

const dispatchMock = vi.fn();
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

import { useUndoRedo, type UseUndoRedoResult } from "../useUndoRedo";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let nowSpy: MockInstance<() => number>;
let virtualNow = 0;

beforeEach(() => {
  dispatchMock.mockReset();
  virtualNow = 0;
  // Stable virtual clock so the tests can step time deterministically.
  // The hook reads `performance.now()` for grace-window comparisons;
  // jsdom provides it but its readings drift, which would make
  // timing-sensitive coalescing tests flaky.
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => virtualNow);
  let n = 0;
  dispatchMock.mockImplementation(async (name: string) => {
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

afterEach(() => {
  nowSpy.mockRestore();
});

function advanceTime(ms: number): void {
  virtualNow += ms;
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

type ProbeProps = {
  readonly captureId: string;
  readonly onSnapshot: (api: UseUndoRedoResult) => void;
  /** Optional bridge for content-check tests that need to observe
   *  the format-aware dispatcher's calls. The geometry / style
   *  branches of applyInverse early-return when this is null, so a
   *  test that wants to verify "one dispatch per item" on a
   *  multi-drag undo MUST provide this. The bus-level dispatchMock
   *  only covers the v1 fallback path used by create/delete. */
  readonly dispatchEdit?: (
    op: Parameters<NonNullable<Parameters<typeof useUndoRedo>[0]["dispatchEdit"]>>[0]
  ) => ReturnType<NonNullable<Parameters<typeof useUndoRedo>[0]["dispatchEdit"]>>;
};

function Probe(props: ProbeProps): null {
  const internal = useRef(false);
  const api = useUndoRedo({
    captureId: props.captureId,
    applyingRef: internal,
    ...(props.dispatchEdit !== undefined ? { dispatchEdit: props.dispatchEdit } : {})
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

describe("useUndoRedo coalescing (plan Alt 5)", () => {
  test("continuous drag → 5 intermediate writes collapse into 1 undo step", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Pointerdown → bracket opens.
    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("drag", "layer-A");
    });
    // 5 intermediate writes during the drag (each pointermove that
    // commits an intermediate state).
    act(() => {
      for (let i = 0; i < 5; i++) {
        api!.recordCreate(makeRow(`drag-step-${i}`), {
          opKind: "drag",
          layerId: "layer-A"
        });
        advanceTime(10); // 10ms between intermediate writes
      }
    });
    // Pointerup → bracket closes.
    act(() => {
      api!.endInteraction(token);
    });

    // Despite 5 recordCreate calls, only ONE undo step exists.
    expect(api!.canUndo).toBe(true);
    expect(api!.canRedo).toBe(false);

    // Verify by undoing once and confirming canUndo flips false
    // (no remaining entries from the drag).
    await act(async () => {
      await api!.undo();
    });
    expect(api!.canUndo).toBe(false);
  });

  test("5 rapid color-burst clicks within grace window → 1 undo step", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // No interaction bracket — just 5 successive setColor writes
    // each 40ms apart (200ms total span; under the 300ms window).
    act(() => {
      for (let i = 0; i < 5; i++) {
        api!.recordCreate(makeRow(`color-click-${i}`), {
          opKind: "setColor",
          layerId: "layer-B"
        });
        advanceTime(40);
      }
    });

    expect(api!.canUndo).toBe(true);
    await act(async () => {
      await api!.undo();
    });
    expect(api!.canUndo).toBe(false);
  });

  test("5 clicks spaced 400ms apart → 5 separate undo steps", async () => {
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
      for (let i = 0; i < 5; i++) {
        api!.recordCreate(makeRow(`slow-click-${i}`), {
          opKind: "setColor",
          layerId: "layer-C"
        });
        // 400ms > 300ms grace window → fresh entry each time.
        advanceTime(400);
      }
    });

    // 5 separate undos required to drain the past stack.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(5);
  });

  test("drag followed by separate click 50ms after pointerup → 2 entries", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Drag a layer.
    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("drag", "layer-D");
    });
    act(() => {
      api!.recordCreate(makeRow("drag-step-0"), {
        opKind: "drag",
        layerId: "layer-D"
      });
      advanceTime(10);
      api!.recordCreate(makeRow("drag-step-1"), {
        opKind: "drag",
        layerId: "layer-D"
      });
    });
    act(() => {
      api!.endInteraction(token);
    });
    // 50ms after pointerup, a separate click — even within the grace
    // window, endInteraction is a hard boundary that resets the
    // coalescing tracker.
    advanceTime(50);
    act(() => {
      api!.recordCreate(makeRow("solo-click"), {
        opKind: "setColor",
        layerId: "layer-D"
      });
    });

    // 2 separate undos.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(2);
  });

  test("drag layer A then drag layer B → 2 separate undo entries", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Drag layer A.
    let tokenA: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      tokenA = api!.beginInteraction("drag", "layer-A");
    });
    act(() => {
      api!.recordCreate(makeRow("A-step-0"), {
        opKind: "drag",
        layerId: "layer-A"
      });
      advanceTime(10);
      api!.recordCreate(makeRow("A-step-1"), {
        opKind: "drag",
        layerId: "layer-A"
      });
    });
    act(() => {
      api!.endInteraction(tokenA);
    });

    // Immediately drag layer B (no time advance — but the layerId
    // mismatch alone should prevent coalescing).
    let tokenB: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      tokenB = api!.beginInteraction("drag", "layer-B");
    });
    act(() => {
      api!.recordCreate(makeRow("B-step-0"), {
        opKind: "drag",
        layerId: "layer-B"
      });
      advanceTime(10);
      api!.recordCreate(makeRow("B-step-1"), {
        opKind: "drag",
        layerId: "layer-B"
      });
    });
    act(() => {
      api!.endInteraction(tokenB);
    });

    // 2 separate undos.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(2);
  });

  test("untagged recordCreate (no opts) → never coalesces", async () => {
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Legacy behavior: 3 untagged calls → 3 entries (no key, no
    // coalescing). This preserves the existing recordCreate /
    // recordDelete callers that haven't been retrofitted with the
    // new options shape.
    act(() => {
      api!.recordCreate(makeRow("u-0"));
      api!.recordCreate(makeRow("u-1"));
      api!.recordCreate(makeRow("u-2"));
    });

    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(3);
  });

  test("different opKind same layerId → does NOT coalesce", async () => {
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
      api!.recordCreate(makeRow("c-1"), {
        opKind: "setColor",
        layerId: "layer-X"
      });
      advanceTime(10);
      // Same layer, different op kind (e.g. user clicked a color
      // then immediately resized) — keep as separate undo entries.
      api!.recordCreate(makeRow("c-2"), {
        opKind: "resize",
        layerId: "layer-X"
      });
    });

    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(2);
  });

  test("multi-delete inside a bracket with shared opKind/layerId → 1 undo step", async () => {
    // Regression for user report: "I Command-selected a Blur and then
    // a Rect, hit Delete — both deleted. Cmd+Z only restored the Blur;
    // a second Cmd+Z restored the Rect. These were supposed to be a
    // grouped undo entry."
    //
    // The keyboard handler's multi-delete loop opens a bracket with
    // ("delete", "kbd-multi-delete") and now calls recordDelete with
    // the SAME tag for each row, so push()'s insideInteraction check
    // fires and the N pushes coalesce into 1 entry. Without the tag
    // (pre-fix), each push hit the untagged branch and produced its
    // own entry — N undo presses needed to restore N deleted layers.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    // Open the bracket like Editor.tsx does for multi-delete.
    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("delete", "kbd-multi-delete");
    });
    // Two recordDelete calls in the bracket — different ROW ids
    // (each delete targets a distinct layer), same logical group key.
    act(() => {
      api!.recordDelete(makeRow("blur-row"), {
        opKind: "delete",
        layerId: "kbd-multi-delete"
      });
      advanceTime(5);
      api!.recordDelete(makeRow("rect-row"), {
        opKind: "delete",
        layerId: "kbd-multi-delete"
      });
    });
    act(() => {
      api!.endInteraction(token);
    });

    // Exactly ONE undo step covering both deletes.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(1);
  });

  test("multi-delete undo dispatches the inverse for EACH deleted row (not just the last)", async () => {
    // User repro: "I selected two text items with command. Hit
    // delete. It deleted both. Hit Command+Z... it restored 1 and
    // the 2nd CANNOT BE RECOVERED." Pre-fix push()'s coalesce path
    // for delete REPLACED `row` with the latest op's row, dropping
    // the earlier deletes' row data on the floor. The undo entry
    // then only knew about the LAST deleted row — the others'
    // soft-deleted DB records sat unreferenced and unrecoverable.
    //
    // The prior "→ 1 undo step" test was too weak — it only
    // asserted that the stack collapsed, not that the one entry
    // actually restored all the things it was supposed to. Content
    // checks live here: record every dispatch fired during undo
    // and assert that BOTH rows' inverses go out.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    const rowA = makeRow("blur-row");
    const rowB = makeRow("rect-row");

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("delete", "kbd-multi-delete");
    });
    act(() => {
      api!.recordDelete(rowA, {
        opKind: "delete",
        layerId: "kbd-multi-delete",
        // "append" mirrors what Editor.tsx's multi-delete handler
        // passes — every delete in the burst accumulates into the
        // entry's items[]. Pre-fix this defaulted to the implicit
        // "replace" shape (which existed as the ONLY shape), and
        // the test below pins THAT failure mode independently.
        mergeMode: "append"
      });
      advanceTime(5);
      api!.recordDelete(rowB, {
        opKind: "delete",
        layerId: "kbd-multi-delete",
        mergeMode: "append"
      });
    });
    act(() => {
      api!.endInteraction(token);
    });

    // Reset the dispatch mock so we count ONLY the undo-fired calls.
    // The fallback path in applyInverse (when dispatchEditRef is
    // null — which it is in this harness) dispatches
    // `overlays:upsert` directly through the bus mock.
    dispatchMock.mockReset();
    const upsertOverlays: unknown[] = [];
    dispatchMock.mockImplementation(
      async (name: string, args: { overlay?: unknown }) => {
        if (name === "overlays:upsert") {
          upsertOverlays.push(args.overlay);
          return { ok: true, value: makeRow("restored") };
        }
        return {
          ok: false,
          error: { kind: "validation", code: "unknown", message: name }
        };
      }
    );

    // Single Cmd+Z — must dispatch one upsert per deleted row.
    await act(async () => {
      await api!.undo();
    });

    expect(upsertOverlays).toHaveLength(2);
    // Order: the bracket's deletes were recorded A then B, so the
    // inverse should restore in the SAME order (or any deterministic
    // order — both rows present is what we care about).
    const restoredIds = new Set(
      upsertOverlays.map((o) => (o as { kind: string }).kind)
    );
    // Both rows were arrow-kind by makeRow's default — verify the
    // ARRAY length above; data shape is identical so an id-based
    // check would be redundant. The key assertion is the COUNT.
    expect(restoredIds.size).toBe(1);
    expect(restoredIds.has("arrow")).toBe(true);
    // Stack is now empty.
    expect(api!.canUndo).toBe(false);
  });

  test("multi-delete WITHOUT mergeMode: append → only LAST row restored (lock the default shape)", async () => {
    // Pins the default ("replace") behavior so callers that forget
    // to pass `mergeMode: "append"` for a different-layer burst
    // get caught by CI — the user-facing symptom is "one of N
    // deleted layers cannot be recovered." Same setup as the
    // "→ each deleted row" test above but without the flag.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("delete", "kbd-multi-delete");
    });
    act(() => {
      api!.recordDelete(makeRow("blur-row"), {
        opKind: "delete",
        layerId: "kbd-multi-delete"
        // mergeMode intentionally OMITTED → defaults to "replace"
      });
      advanceTime(5);
      api!.recordDelete(makeRow("rect-row"), {
        opKind: "delete",
        layerId: "kbd-multi-delete"
      });
    });
    act(() => {
      api!.endInteraction(token);
    });

    dispatchMock.mockReset();
    const upsertOverlays: unknown[] = [];
    dispatchMock.mockImplementation(
      async (name: string, args: { overlay?: unknown }) => {
        if (name === "overlays:upsert") {
          upsertOverlays.push(args.overlay);
          return { ok: true, value: makeRow("restored") };
        }
        return {
          ok: false,
          error: { kind: "validation", code: "unknown", message: name }
        };
      }
    );

    await act(async () => {
      await api!.undo();
    });

    // Default replace mode → only the LAST recorded delete makes it
    // into the entry's items[]. This is the bug class the flag
    // exists to opt out of for different-layer bursts.
    expect(upsertOverlays).toHaveLength(1);
  });

  test("multi-DRAG geometry burst inside a bracket with shared opKind/layerId → 1 undo step", async () => {
    // Mirror of the multi-delete coalescing test for the geometry
    // op kind. The new `commitMultiDragRef` pathway in Editor.tsx
    // opens a `("multi-drag", "pointer-multi-drag")` bracket and
    // calls `undo.recordGeometry(..., { opKind, layerId })` for
    // each selected layer's translation. Locks two things at once:
    //   (a) `recordGeometry` actually forwards the new optional
    //       `RecordOptions` arg to push() (the signature change is
    //       what unlocks this coalescing path);
    //   (b) push()'s `insideInteraction` check matches the bracket's
    //       keys for the geometry op kind — same mechanism as the
    //       delete coalescing path, different op kind.
    //
    // Without this test, a future refactor that drops the opts on
    // either side would silently break "drag a multi-selection →
    // one undo entry restores all of them" but the unit tests would
    // still pass.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("multi-drag", "pointer-multi-drag");
    });
    // Two recordGeometry calls in the bracket — distinct layer ids
    // (different rows), same logical group key. Same shape the
    // EditorLoaded's `commitMultiDragRef` closure emits per layer
    // during a multi-drag commit.
    act(() => {
      api!.recordGeometry(
        {
          currentIdRef: { current: "arrow-1-post" },
          previousGeometry: {
            kind: "arrow",
            from: { x: 0, y: 0 },
            to: { x: 1, y: 1 }
          },
          nextGeometry: {
            kind: "arrow",
            from: { x: 0.1, y: 0.1 },
            to: { x: 1.1, y: 1.1 }
          }
        },
        {
          opKind: "multi-drag",
          layerId: "pointer-multi-drag",
          mergeMode: "append"
        }
      );
      advanceTime(5);
      api!.recordGeometry(
        {
          currentIdRef: { current: "rect-1-post" },
          previousGeometry: {
            kind: "rect",
            rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }
          },
          nextGeometry: {
            kind: "rect",
            rect: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }
          }
        },
        {
          opKind: "multi-drag",
          layerId: "pointer-multi-drag",
          mergeMode: "append"
        }
      );
    });
    act(() => {
      api!.endInteraction(token);
    });

    // Exactly ONE undo step covering both layer translations.
    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(1);
  });

  test("multi-DRAG undo dispatches updateGeometry for EACH dragged layer", async () => {
    // Content-check companion to the "→ 1 undo step" test above.
    // Same data-loss bug class as multi-delete: pre-fix the
    // coalesce path stored ONE geometry per EditOp, so undo of a
    // multi-drag only restored the FIRST layer's pre-drag position
    // and the rest stayed at their dragged position (silently
    // wrong, no error surfaced). This test asserts the actual
    // dispatch count — strict regression coverage.
    //
    // applyInverse's geometry branch routes through dispatchEdit
    // (no bus-level fallback path the way create/delete have),
    // so we install a dispatchEdit bridge via the Probe to observe
    // every call.
    const dispatchEditCalls: Array<{ kind: string; layerId?: string }> = [];
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        },
        dispatchEdit: async (op) => {
          if (op.kind === "updateGeometry") {
            dispatchEditCalls.push({ kind: op.kind, layerId: op.layerId });
          } else {
            dispatchEditCalls.push({ kind: op.kind });
          }
          // Return a synthetic update artifact so applyInverse's
          // chain-id walk can extract the new id.
          return {
            ok: true,
            value: {
              kind: "update",
              artifact: {
                format: 1,
                row: makeRow(`post-${dispatchEditCalls.length}`)
              }
            }
          };
        }
      })
    );

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("multi-drag", "pointer-multi-drag");
    });
    act(() => {
      api!.recordGeometry(
        {
          currentIdRef: { current: "arrow-1-post" },
          previousGeometry: {
            kind: "arrow",
            from: { x: 0, y: 0 },
            to: { x: 1, y: 1 }
          },
          nextGeometry: {
            kind: "arrow",
            from: { x: 0.1, y: 0.1 },
            to: { x: 1.1, y: 1.1 }
          }
        },
        {
          opKind: "multi-drag",
          layerId: "pointer-multi-drag",
          mergeMode: "append"
        }
      );
      api!.recordGeometry(
        {
          currentIdRef: { current: "rect-1-post" },
          previousGeometry: {
            kind: "rect",
            rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }
          },
          nextGeometry: {
            kind: "rect",
            rect: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }
          }
        },
        {
          opKind: "multi-drag",
          layerId: "pointer-multi-drag",
          mergeMode: "append"
        }
      );
    });
    act(() => {
      api!.endInteraction(token);
    });

    // Single Cmd+Z should fire one updateGeometry per recorded
    // layer (2 total here).
    await act(async () => {
      await api!.undo();
    });

    const geomCalls = dispatchEditCalls.filter(
      (c) => c.kind === "updateGeometry"
    );
    expect(geomCalls).toHaveLength(2);
    // Both layer ids should have been targeted.
    const targetedIds = new Set(geomCalls.map((c) => c.layerId));
    expect(targetedIds.has("arrow-1-post")).toBe(true);
    expect(targetedIds.has("rect-1-post")).toBe(true);
  });

  test("multi-DRAG geometry burst WITHOUT shared layerId tag → N undo steps (pre-fix shape)", async () => {
    // Lock the pre-fix behavior so a future refactor that drops the
    // tag on the multi-drag side is caught — the symmetric guard to
    // the multi-delete pre-fix test below.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("multi-drag", "pointer-multi-drag");
    });
    act(() => {
      // Untagged recordGeometry calls (opts omitted) — push() falls
      // through the untagged branch even though a bracket is open.
      api!.recordGeometry({
        currentIdRef: { current: "arrow-1-post" },
        previousGeometry: {
          kind: "arrow",
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 }
        },
        nextGeometry: {
          kind: "arrow",
          from: { x: 0.1, y: 0.1 },
          to: { x: 1.1, y: 1.1 }
        }
      });
      api!.recordGeometry({
        currentIdRef: { current: "rect-1-post" },
        previousGeometry: {
          kind: "rect",
          rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }
        },
        nextGeometry: {
          kind: "rect",
          rect: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 }
        }
      });
    });
    act(() => {
      api!.endInteraction(token);
    });

    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(2);
  });

  test("multi-delete WITHOUT shared layerId tag → N undo steps (pre-fix behavior, regression test)", async () => {
    // Confirms the pre-fix behavior so a future refactor that drops
    // the tag from the multi-delete handler doesn't silently regress
    // the user-facing UX. Same bracket, but recordDelete called
    // without opts — push() falls through the untagged branch and
    // each entry stays standalone.
    let api: UseUndoRedoResult | null = null;
    render(
      createElement(Probe, {
        captureId: "cap-1",
        onSnapshot: (a) => {
          api = a;
        }
      })
    );

    let token: ReturnType<UseUndoRedoResult["beginInteraction"]>;
    act(() => {
      token = api!.beginInteraction("delete", "kbd-multi-delete");
    });
    act(() => {
      api!.recordDelete(makeRow("blur-row"));
      api!.recordDelete(makeRow("rect-row"));
    });
    act(() => {
      api!.endInteraction(token);
    });

    let undoCount = 0;
    while (api!.canUndo && undoCount < 10) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await api!.undo();
      });
      undoCount += 1;
    }
    expect(undoCount).toBe(2);
  });
});
