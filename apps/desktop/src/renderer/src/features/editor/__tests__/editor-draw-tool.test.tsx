// Editor-level tests for the Draw tool (key D): a pen drag commits one
// stroke layer, the eraser cuts the strokes it crosses into pieces and
// leaves every other kind of layer alone, and a press on an existing
// layer draws instead of selecting it.
//
// Mounts the real Editor with the capture model and the IPC bridge
// stubbed, like editor-canvas-drag-handles.test.tsx — the behavior under
// test is the wiring between the pointer handlers, the commit and the
// model's dispatcher, which no component test reaches.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from "vitest";
import { BundleLayerNode, strokeSegments } from "@pwrsnap/shared";
import type { CaptureRecord, Settings } from "@pwrsnap/shared";
import type { LayerEditOp } from "../useCaptureModel";
import type { LayersPanelApi } from "../Editor";
import { useEditMenuBridge } from "../../../lib/editMenuBridge";
import { baseSettings } from "../../settings/__tests__/settings-fixture";
import { historyPersistenceOracle } from "./history-persistence-oracle";

const CANVAS_W = 1000;
const CANVAS_H = 1000;

const hoisted = vi.hoisted(() => ({
  /** The settings `settings:read` answers with. A FAILED read would
   *  park every commit on the tool-state settle timeout. */
  settings: null as Settings | null,
  dispatchEdit: null as ((op: LayerEditOp) => Promise<unknown>) | null,
  /** The model's layers. `realisticDispatch` writes into it, and
   *  `rerender()` shows the editor what was written. */
  layers: [] as BundleLayerNode[]
}));

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: vi.fn(async (name: string) => {
    if (name === "settings:read") {
      return hoisted.settings === null
        ? { ok: false, error: { kind: "settings", code: "unavailable", message: "stub" } }
        : { ok: true, value: hoisted.settings };
    }
    if (name === "settings:secretStatus") {
      return hoisted.settings === null
        ? { ok: false, error: { kind: "settings", code: "unavailable", message: "stub" } }
        : { ok: true, value: {} };
    }
    return { ok: true, value: undefined };
  }),
  dispatchOrThrow: vi.fn(async () => undefined),
  subscribe: vi.fn(() => () => {}),
  captureSrcUrl: (id: string) => `pwrsnap-capture://${id}`,
  layerSourceUrl: (id: string, sha: string) => `pwrsnap-capture://${id}/${sha}`,
  cacheUrl: () => "pwrsnap-cache://x",
  perfMark: vi.fn(),
  startCaptureDrag: vi.fn(),
  startVideoDrag: vi.fn(),
  startCartZipDrag: vi.fn(),
  sizzleOutputUrl: () => "pwrsnap-cache://sizzle"
}));

const SOURCE_SHA = "b".repeat(64);

const record: CaptureRecord = {
  id: "cap_draw",
  kind: "image",
  captured_at: "2026-09-30T00:00:00Z",
  legacy_src_path: null,
  bundle_path: "/tmp/cap_draw.pwrsnap",
  flat_png_path: null,
  bundle_modified_at: null,
  bundle_format_version: 2,
  bundle_edits_version: 1,
  width_px: CANVAS_W,
  height_px: CANVAS_H,
  device_pixel_ratio: 1,
  byte_size: 1024,
  sha256: SOURCE_SHA,
  source_app_bundle_id: null,
  source_app_name: null,
  source_window_title: null,
  edits_version: 1,
  deleted_at: null,
  has_alpha: false
};

const common = {
  parent_id: "g_root",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal",
  transform: [1, 0, 0, 1, 0, 0],
  source: "user",
  ai_run_id: null,
  applied_at: "2026-09-30T00:00:00Z",
  rejected_at: null,
  superseded_by: null,
  created_at: "2026-09-30T00:00:00Z"
} as const;

// A horizontal pen underline at y = 0.5 and an arrow running straight
// through the middle of it — the eraser below crosses both.
const layers: BundleLayerNode[] = [
  {
    ...common,
    id: "raster_base",
    name: "Source",
    z_index: 0,
    kind: "raster",
    source_ref: { kind: "embedded", sha256: SOURCE_SHA },
    natural_width_px: CANVAS_W,
    natural_height_px: CANVAS_H,
    original_transform: [1, 0, 0, 1, 0, 0]
  },
  {
    ...common,
    id: "stroke_1",
    name: "Pen",
    z_index: 1000,
    kind: "vector",
    shape: {
      kind: "stroke",
      tool: "pen",
      points: [
        { x: 0.2, y: 0.5 },
        { x: 0.8, y: 0.5 }
      ],
      color: "#2489ff",
      thickness: "small"
    }
  },
  {
    ...common,
    id: "arrow_1",
    name: "Arrow",
    z_index: 2000,
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.5, y: 0.2 },
      to: { x: 0.5, y: 0.8 },
      color: "auto"
    }
  }
] as BundleLayerNode[];
// The fixture ids are readable, not schema ids; only what the editor
// WRITES is held to the schema.

vi.mock("../useCaptureModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../useCaptureModel")>();
  return {
    ...actual,
    useCaptureModel: (captureId: string) => ({
      kind: "loaded",
      format: 2,
      captureId,
      record: { ...record, id: captureId },
      layers: hoisted.layers,
      layersView: [],
      dispatchEdit: (op: LayerEditOp) => hoisted.dispatchEdit!(op)
    })
  };
});

const ops: LayerEditOp[] = [];

function addPastedRaster(): void {
  const base = layers[0]!;
  if (base.kind !== "raster") throw new Error("expected raster");
  hoisted.layers = [...layers, {
    ...base, id: "pasted", z_index: 3000,
    source_ref: { kind: "embedded", sha256: "c".repeat(64) },
    natural_width_px: 100, natural_height_px: 100,
    transform: [1, 0, 0, 1, 100, 700], original_transform: [1, 0, 0, 1, 100, 700]
  }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function HistoryBridge({ children }: { children?: React.ReactNode }) {
  useEditMenuBridge();
  return children;
}

function editorElement(
  Editor: typeof import("../Editor").Editor,
  props: React.ComponentProps<typeof Editor>
) {
  return createElement(HistoryBridge, null, createElement(Editor, props));
}

/** Answers an upsert the way `layers:upsert` does: a node that fails the
 *  bundle schema is refused, so a malformed piece (a wrong-length id, a
 *  bad field) fails here as it would in the app instead of being
 *  accepted by a permissive stub. */
async function realisticDispatch(op: LayerEditOp): Promise<unknown> {
  ops.push(op);
  if (op.kind === "historyReplay" || op.kind === "historyAck") {
    const state = historyPersistenceOracle(hoisted.layers);
    const result = await state.dispatch(op);
    if (result.ok) hoisted.layers = [...state.live.values()];
    return result;
  }
  if (op.kind === "upsert") {
    const parsed = BundleLayerNode.safeParse(op.node);
    if (!parsed.success) {
      return {
        ok: false,
        error: { kind: "validation", code: "schema_mismatch", message: parsed.error.message }
      };
    }
    if (hoisted.layers.some((layer) => layer.id === op.node.id)) {
      return { ok: false, error: { kind: "persistence", code: "insert_failed", message: "live id" } };
    }
    const top = Math.max(...hoisted.layers.map((l) => l.z_index));
    const node = op.bumpZIndexToMax === true ? { ...op.node, z_index: top + 1000 } : op.node;
    hoisted.layers = [...hoisted.layers.filter((l) => l.id !== node.id), node];
    return { ok: true, value: { kind: "upsert", artifact: { format: 2, node } } };
  }
  if (op.kind === "updateGeometry") {
    const previousNode = hoisted.layers.find((node) => node.id === op.layerId)!;
    const node = op.geometry.kind === "transform"
      ? { ...previousNode, transform: op.geometry.transform }
      : previousNode.kind === "vector" && previousNode.shape.kind === "arrow" && op.geometry.kind === "arrow"
        ? { ...previousNode, shape: { ...previousNode.shape, ...op.geometry } }
        : previousNode;
    hoisted.layers = hoisted.layers.map((layer) => layer.id === node.id ? node : layer);
    return { ok: true, value: { kind: "update", artifact: { format: 2, node, previousNode } } };
  }
  if (op.kind === "delete") hoisted.layers = hoisted.layers.filter((l) => l.id !== op.id);
  return { ok: true, value: { kind: "delete" } };
}
let realGetBoundingClientRect: (() => DOMRect) | null = null;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const proto = globalThis.HTMLElement?.prototype;
  if (proto !== undefined) {
    proto.setPointerCapture ??= function () {};
    proto.releasePointerCapture ??= function () {};
  }
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  // jsdom lays nothing out; pin one square viewport at the origin so a
  // client coordinate IS a canvas pixel.
  realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, left: 0, top: 0,
      width: CANVAS_W, height: CANVAS_H,
      right: CANVAS_W, bottom: CANVAS_H,
      toJSON: () => ({})
    } as DOMRect;
  };
  await import("../Editor");
});

afterAll(() => {
  if (realGetBoundingClientRect !== null) {
    Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    realGetBoundingClientRect = null;
  }
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latestSelection: readonly string[] = [];
let panelApi: LayersPanelApi | null = null;
const observeSelection = (ids: readonly string[]) => { latestSelection = ids; };
const observePanel = (api: LayersPanelApi | null) => { panelApi = api; };

beforeEach(() => {
  ops.length = 0;
  hoisted.settings = {
    ...baseSettings,
    editor: {
      ...baseSettings.editor,
      toolStyles: {
        ...baseSettings.editor.toolStyles,
        arrow: { ...baseSettings.editor.toolStyles.arrow, outline: "none" },
        shape: { ...baseSettings.editor.toolStyles.shape, outline: "none" }
      }
    }
  };
  latestSelection = [];
  panelApi = null;
  hoisted.dispatchEdit = realisticDispatch;
  hoisted.layers = [...layers];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function pointer(type: string, clientX: number, clientY: number, pointerId = 1): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX,
    clientY,
    pointerId,
    isPrimary: pointerId === 1
  });
}

async function mountWithDrawTool(): Promise<HTMLElement> {
  const { Editor } = await import("../Editor");
  await act(async () => {
    root?.render(editorElement(Editor, {
      captureId: "cap_draw", onSelectionChange: observeSelection, onLayersApi: observePanel
    }));
  });
  // Let the settings read settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
  });
  const canvas = container!.querySelector<HTMLElement>("[data-testid='editor-canvas']");
  expect(canvas).not.toBeNull();
  expect(canvas!.getAttribute("data-tool")).toBe("draw");
  return canvas!;
}

/** Render again, so the editor reads the layers written so far. */
async function rerender(captureId = "cap_draw"): Promise<void> {
  const { Editor } = await import("../Editor");
  await act(async () => {
    root?.render(editorElement(Editor, { captureId, onSelectionChange: observeSelection, onLayersApi: observePanel }));
  });
}

async function drag(canvas: HTMLElement, path: ReadonlyArray<readonly [number, number]>): Promise<void> {
  const [first, ...rest] = path;
  await act(async () => {
    canvas.dispatchEvent(pointer("pointerdown", first![0], first![1]));
  });
  for (const [x, y] of rest) {
    await act(async () => {
      canvas.dispatchEvent(pointer("pointermove", x, y));
    });
  }
  const last = path[path.length - 1]!;
  await act(async () => {
    canvas.dispatchEvent(pointer("pointerup", last[0], last[1]));
  });
  // The commit awaits the settled tool styles before it writes.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Editor — canvas gestures and Draw tool", () => {
  test("an applying history replay excludes a new canvas gesture", async () => {
    const canvas = await mountWithDrawTool();
    await drag(canvas, [[100, 100], [300, 150]]);
    await rerender();
    const gate = deferred<void>();
    hoisted.dispatchEdit = async (op) => {
      if (op.kind === "historyReplay") await gate.promise;
      return realisticDispatch(op);
    };
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    await drag(canvas, [[700, 100], [900, 150]]);
    expect(ops.map((op) => op.kind)).toEqual(["upsert"]);
    await act(async () => { gate.resolve(); });
    expect(ops.map((op) => op.kind)).toEqual(["upsert", "historyReplay"]);
    expect(hoisted.layers).toEqual(layers);
  });

  test("a gesture started while history waits for persistence supersedes that history request", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    const gate = deferred<void>();
    hoisted.dispatchEdit = async (op) => {
      if (op.kind === "upsert") await gate.promise;
      return realisticDispatch(op);
    };
    await drag(canvas, [[100, 100], [300, 150]]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 700, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 900, 150)); });
    await act(async () => { gate.resolve(); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 900, 150)); });
    expect(ops.map((op) => op.kind)).toEqual(["upsert", "upsert"]);
  });

  test.each([false, true])("history (redo=%s) cancels the first open stroke even with an empty stack", async (shiftKey) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 100, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 300, 150)); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, shiftKey, bubbles: true }));
    });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 300, 150)); });
    expect(ops).toEqual([]);
  });

  test.each(["cancel", "outside"])("a raster drag handles %s without pointermove IPC", async (terminal) => {
    addPastedRaster();
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" })); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 150, 750)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 1100, 750)); });
    expect(ops).toEqual([]);
    const raster = container!.querySelector<HTMLElement>("[data-layer-id='pasted']")!;
    expect(raster.classList.contains("is-dragging")).toBe(true);
    await act(async () => { canvas.dispatchEvent(pointer(terminal === "cancel" ? "pointercancel" : "pointerup", 1100, 750)); });
    if (terminal === "cancel") {
      await act(async () => { canvas.dispatchEvent(pointer("pointerup", 1100, 750)); });
      expect(ops).toEqual([]);
    } else {
      expect(ops).toEqual([{
        kind: "updateGeometry", layerId: "pasted",
        geometry: { kind: "transform", transform: [1, 0, 0, 1, 1050, 700] }
      }]);
    }
    expect(raster.classList.contains("is-dragging")).toBe(false);
  });

  test.each(["drag", "press", "selection"])("a failed older raster commit cleans only its own preview after a new %s", async (nextAction) => {
    addPastedRaster();
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" })); });
    const gate = deferred<unknown>();
    hoisted.dispatchEdit = () => gate.promise;
    await drag(canvas, [[150, 750], [250, 750]]);
    if (nextAction !== "selection") {
      await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 250, 750)); });
      if (nextAction === "drag") await act(async () => { canvas.dispatchEvent(pointer("pointermove", 400, 750)); });
    } else {
      await act(async () => { panelApi!.selectLayers("stroke_1", false); });
    }
    const raster = container!.querySelector<HTMLElement>("[data-layer-id='pasted']")!;
    const preview = raster.style.transform;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        gate.resolve({ ok: false, error: { kind: "validation", code: "refused", message: "fixture" } });
      });
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
    expect(raster.classList.contains("is-dragging")).toBe(nextAction !== "selection");
    if (nextAction !== "selection") expect(raster.style.transform).toBe(preview);
    expect(latestSelection).toEqual([nextAction !== "selection" ? "pasted" : "stroke_1"]);
    // The next gesture still owns its cancellation/release pair.
    await act(async () => { canvas.dispatchEvent(pointer("pointercancel", 400, 750)); });
    expect(raster.classList.contains("is-dragging")).toBe(false);
  });

  test.each(["cancel", "outside"])("a selection drag handles %s without pointermove IPC", async (terminal) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "v" })); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 500, 300)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 1100, 300)); });
    expect(ops).toEqual([]);
    await act(async () => { canvas.dispatchEvent(pointer(terminal === "cancel" ? "pointercancel" : "pointerup", 1100, 300)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 1100, 300)); });
    if (terminal === "cancel") expect(ops).toEqual([]);
    else expect(ops).toEqual([{
      kind: "updateGeometry", layerId: "arrow_1",
      geometry: { kind: "arrow", from: { x: 1.1, y: 0.2 }, to: { x: 1.1, y: 0.8 } }
    }]);
  });

  test("undo waits for a released gesture to persist, then undoes that gesture", async () => {
    const canvas = await mountWithDrawTool();
    await drag(canvas, [[100, 100], [200, 100]]);
    const olderId = ops[0]!.kind === "upsert" ? ops[0]!.node.id : "";
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    const gate = deferred<void>();
    const admitted: LayerEditOp[] = [];
    hoisted.dispatchEdit = async (op) => {
      admitted.push(op);
      if (op.kind === "upsert") await gate.promise;
      return realisticDispatch(op);
    };
    await drag(canvas, [[700, 100], [900, 150]]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true }));
    });
    const before = admitted.map((op) => op.kind);
    await act(async () => { gate.resolve(); });
    expect(before).toEqual(["upsert"]);
    expect(admitted.map((op) => op.kind)).toEqual(["upsert", "historyReplay"]);
    const releasedId = admitted[0]!.kind === "upsert" ? admitted[0]!.node.id : "";
    expect(admitted[1]).toMatchObject({ kind: "historyReplay", restore: [], removeIds: [releasedId] });
    expect(hoisted.layers.some((layer) => layer.id === releasedId)).toBe(false);
    expect(hoisted.layers.some((layer) => layer.id === olderId)).toBe(true);
  });

  test.each(["a", "s", "h", "b"])("%s: press, final move and release can finish before React paints", async (key) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
    await act(async () => {
      canvas.dispatchEvent(pointer("pointerdown", 100, 100));
      canvas.dispatchEvent(pointer("pointermove", 300, 150));
      canvas.dispatchEvent(pointer("pointerup", 300, 150));
    });
    expect(ops.filter((op) => op.kind === "upsert")).toHaveLength(1);
  });

  test("a pending placement cannot select over a newer gesture or clear its draft", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    const gate = deferred<void>();
    const dispatch = vi.fn(async (op: LayerEditOp) => {
      await gate.promise;
      return realisticDispatch(op);
    });
    hoisted.dispatchEdit = dispatch;
    await drag(canvas, [[100, 100], [300, 150]]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 700, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 900, 150)); });
    await act(async () => { gate.resolve(); });
    expect(latestSelection).toEqual([]);
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 900, 150)); });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(ops[1]).toMatchObject({
      kind: "upsert", node: { shape: { kind: "arrow", from: { x: 0.7, y: 0.1 }, to: { x: 0.9, y: 0.15 } } }
    });
  });

  test("a pending placement cannot select over a newer Layers-panel selection", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    const gate = deferred<void>();
    hoisted.dispatchEdit = async (op) => { await gate.promise; return realisticDispatch(op); };
    await drag(canvas, [[100, 100], [300, 150]]);
    await act(async () => { panelApi!.selectLayers("stroke_1", false); });
    await act(async () => { gate.resolve(); });
    expect(latestSelection).toEqual(["stroke_1"]);
  });

  test("selection survives a stale refetch, then is pruned after the layer lands and is removed", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    let saved: BundleLayerNode[] = [];
    hoisted.dispatchEdit = async (op) => {
      const result = await realisticDispatch(op);
      saved = hoisted.layers;
      // Persistence has completed; the broadcast/refetch has not.
      hoisted.layers = [...layers];
      return result;
    };
    await drag(canvas, [[100, 100], [300, 150]]);
    const selected = latestSelection;
    expect(selected).toHaveLength(1);
    hoisted.layers = [...layers];
    await rerender();
    expect(latestSelection).toEqual(selected);
    hoisted.layers = saved;
    await rerender();
    hoisted.layers = [...layers];
    await rerender();
    expect(latestSelection).toEqual([]);
  });

  test.each(["switch", "unmount"])("%s during a commit detaches its completion from the next editor session", async (action) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); });
    const gate = deferred<void>();
    hoisted.dispatchEdit = async (op) => { await gate.promise; return realisticDispatch(op); };
    await drag(canvas, [[100, 100], [300, 150]]);
    if (action === "switch") await rerender("cap_other");
    else await act(async () => { root?.render(null); });
    await act(async () => { gate.resolve(); });
    if (action === "unmount") await rerender("cap_other");
    expect(latestSelection).toEqual([]);
    ops.length = 0;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true }));
    });
    expect(ops).toEqual([]);
  });

  test("undo during an open stroke cancels it without replaying an older edit", async () => {
    const canvas = await mountWithDrawTool();
    await drag(canvas, [[100, 100], [200, 100]]);
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 700, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 900, 100)); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true, bubbles: true }));
    });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 900, 100)); });
    expect(ops.map((op) => op.kind)).toEqual(["upsert"]);
  });

  test.each(["a", "s", "h", "b", "d"])("%s: pointercancel discards the gesture, and a later release cannot commit it", async (key) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key })); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 100, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 300, 150)); });
    expect(ops).toEqual([]); // pointermove stays local
    await act(async () => { canvas.dispatchEvent(pointer("pointercancel", 300, 150)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 300, 150)); });
    expect(ops).toEqual([]);
    await drag(canvas, [[100, 100], [300, 150]]);
    expect(ops.filter((op) => op.kind === "upsert")).toHaveLength(1);
  });

  test.each(["lostpointercapture", "blur"])("%s abandons a stroke and releases admission for the next gesture", async (terminal) => {
    const canvas = await mountWithDrawTool();
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 100, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 300, 150)); });
    await act(async () => {
      if (terminal === "blur") window.dispatchEvent(new Event("blur"));
      else canvas.dispatchEvent(pointer(terminal, 300, 150));
    });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 300, 150)); });
    expect(ops).toEqual([]);
    await drag(canvas, [[100, 100], [300, 150]]);
    expect(ops.filter((op) => op.kind === "upsert")).toHaveLength(1);
  });

  test("a second pointer press cannot replace the active arrow's origin", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 100, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 300, 200)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 900, 900, 2)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 500, 200)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 500, 200)); });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "upsert", node: {
      kind: "vector", shape: { kind: "arrow", from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.2 } }
    } });
  });

  test("a second pointer cannot replace, move, cancel or finish the active stroke", async () => {
    const canvas = await mountWithDrawTool();
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", 100, 100)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", 200, 100)); });
    for (const type of ["pointerdown", "pointermove", "pointercancel", "pointerup"]) {
      await act(async () => { canvas.dispatchEvent(pointer(type, 900, 900, 2)); });
    }
    expect(ops).toEqual([]);
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 200, 100)); });
    const upserts = ops.filter((op) => op.kind === "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.node).toMatchObject({
      kind: "vector", shape: { kind: "stroke", points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] }
    });
  });

  test.each(["group", "raster"])("a %s drag completing after a newer selection preserves that selection", async (kind) => {
    if (kind === "raster") addPastedRaster();
    const { Editor } = await import("../Editor");
    let panel: LayersPanelApi | null = null;
    let selection: readonly string[] = [];
    await act(async () => {
      root?.render(editorElement(Editor, {
        captureId: "cap_draw", onLayersApi: (api) => { panel = api; },
        onSelectionChange: (ids) => { selection = ids; }
      }));
    });
    const canvas = container!.querySelector<HTMLElement>("[data-testid='editor-canvas']")!;
    const gate = deferred<Awaited<ReturnType<typeof realisticDispatch>>>();
    hoisted.dispatchEdit = (op) => {
      ops.push(op);
      return gate.promise;
    };
    const [x, y] = kind === "raster" ? [150, 750] : [500, 300];
    await act(async () => { canvas.dispatchEvent(pointer("pointerdown", x!, y!)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointermove", x! + 100, y!)); });
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", x! + 100, y!)); });
    expect(ops).toHaveLength(1);
    const id = kind === "raster" ? "pasted" : "arrow_1";
    expect(ops[0]).toMatchObject({ kind: "updateGeometry", layerId: id });
    await act(async () => { panel!.selectLayers("stroke_1", false); });
    expect(selection).toEqual(["stroke_1"]);
    await act(async () => {
      gate.resolve({ ok: true, value: { kind: "update", artifact: { format: 2, node: hoisted.layers.find((node) => node.id === id) } } });
    });
    expect(selection).toEqual(["stroke_1"]);
  });

  test("a pen drag commits ONE stroke layer along the path, on top, and leaves nothing selected", async () => {
    const canvas = await mountWithDrawTool();
    await drag(canvas, [
      [100, 100],
      [150, 140],
      [200, 120],
      [260, 180]
    ]);
    const upserts = ops.filter((op) => op.kind === "upsert");
    expect(upserts).toHaveLength(1);
    const op = upserts[0]!;
    if (op.kind !== "upsert" || op.node.kind !== "vector") throw new Error("expected a vector upsert");
    expect(op.bumpZIndexToMax).toBe(true);
    const shape = op.node.shape;
    if (shape.kind !== "stroke") throw new Error(`expected a stroke, got ${shape.kind}`);
    expect(shape.tool).toBe("pen");
    expect(shape.points[0]).toEqual({ x: 0.1, y: 0.1 });
    expect(shape.points[shape.points.length - 1]).toEqual({ x: 0.26, y: 0.18 });
    // Strokes come in runs; the editor does not select each one.
    expect(container!.querySelector("[data-testid='transform-handles']")).toBeNull();
  });

  test("pressing D with a layer selected lets go of it, so the bar shows the pen", async () => {
    const { Editor } = await import("../Editor");
    const selections: (readonly string[])[] = [];
    await act(async () => {
      root?.render(
        createElement(Editor, { captureId: "cap_draw", onSelectionChange: (ids) => selections.push(ids) })
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const canvas = container!.querySelector<HTMLElement>("[data-testid='editor-canvas']")!;
    expect(canvas.getAttribute("data-tool")).toBe("pointer");
    // Select the arrow with the pointer.
    await drag(canvas, [[500, 400]]);
    expect(selections.at(-1)).toEqual(["arrow_1"]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    });
    expect(canvas.getAttribute("data-tool")).toBe("draw");
    expect(selections.at(-1)).toEqual([]);
  });

  test("a press that lands on an existing layer draws over it instead of selecting it", async () => {
    const canvas = await mountWithDrawTool();
    // Start right on the arrow's stem.
    await drag(canvas, [
      [500, 400],
      [560, 420]
    ]);
    expect(ops.filter((op) => op.kind === "upsert")).toHaveLength(1);
    expect(container!.querySelector("[data-testid='transform-handles']")).toBeNull();
  });

  test("the eraser cuts the pen stroke it crosses in two — ONE layer with two segments, at its z_index — and never touches the arrow", async () => {
    hoisted.settings = {
      ...baseSettings,
      editor: {
        ...baseSettings.editor,
        toolStyles: {
          ...baseSettings.editor.toolStyles,
          draw: { mode: "eraser", color: "accent", thickness: "small" }
        }
      }
    };
    const canvas = await mountWithDrawTool();
    // A vertical swipe down the middle — across the stroke AND the arrow.
    await drag(canvas, [
      [500, 300],
      [500, 500],
      [500, 700]
    ]);
    const upserts = ops.filter(
      (op): op is Extract<LayerEditOp, { kind: "upsert" }> => op.kind === "upsert"
    );
    const deletes = ops.filter(
      (op): op is Extract<LayerEditOp, { kind: "delete" }> => op.kind === "delete"
    );
    expect(deletes.map((op) => op.id)).toEqual(["stroke_1"]);
    // One replacement row, not one per piece.
    expect(upserts).toHaveLength(1);
    const [op] = upserts;
    expect(op!.node.z_index).toBe(1000);
    expect(op!.bumpZIndexToMax).toBeUndefined();
    if (op!.node.kind !== "vector" || op!.node.shape.kind !== "stroke") {
      throw new Error("expected a stroke");
    }
    const shape = op!.node.shape;
    expect(shape.color).toBe("#2489ff");
    const [left, right] = strokeSegments(shape);
    expect(strokeSegments(shape)).toHaveLength(2);
    // One segment ends left of the cut, the other starts right of it.
    expect(Math.max(...left!.map((p) => p.x))).toBeLessThan(0.5);
    expect(Math.min(...right!.map((p) => p.x))).toBeGreaterThan(0.5);
  });

  test("a replacement that fails to write keeps the original stroke: nothing is deleted", async () => {
    hoisted.settings = {
      ...baseSettings,
      editor: {
        ...baseSettings.editor,
        toolStyles: {
          ...baseSettings.editor.toolStyles,
          draw: { mode: "eraser", color: "accent", thickness: "small" }
        }
      }
    };
    hoisted.dispatchEdit = async (op) => {
      if (op.kind === "upsert") {
        ops.push(op);
        return { ok: false, error: { kind: "validation", code: "schema_mismatch", message: "stub" } };
      }
      return realisticDispatch(op);
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const canvas = await mountWithDrawTool();
      await drag(canvas, [
        [500, 300],
        [500, 500],
        [500, 700]
      ]);
    } finally {
      errors.mockRestore();
    }
    expect(ops.some((op) => op.kind === "upsert")).toBe(true);
    expect(ops.filter((op) => op.kind === "delete")).toEqual([]);
  });

  describe("a burst of strokes is one layer", () => {
    /** Moves the clock the editor reads, without stopping it. */
    function clock(): { advance(ms: number): void; restore(): void } {
      const real = performance.now.bind(performance);
      let offset = 0;
      const spy = vi.spyOn(performance, "now").mockImplementation(() => real() + offset);
      return { advance: (ms) => (offset += ms), restore: () => spy.mockRestore() };
    }
    const upsertsOf = () =>
      ops.filter((op): op is Extract<LayerEditOp, { kind: "upsert" }> => op.kind === "upsert");
    const strokeOf = (op: Extract<LayerEditOp, { kind: "upsert" }>) => {
      if (op.node.kind !== "vector" || op.node.shape.kind !== "stroke") throw new Error("expected a stroke");
      return op.node.shape;
    };

    test("a stroke started right after the last one joins its layer as another segment", async () => {
      const canvas = await mountWithDrawTool();
      await drag(canvas, [[100, 100], [150, 140], [200, 120]]);
      await rerender();
      await drag(canvas, [[300, 300], [350, 340], [400, 320]]);
      const [first, second] = upsertsOf();
      expect(upsertsOf()).toHaveLength(2);
      // The second write replaces the first stroke: same layer, now two
      // segments, and the first row is deleted — not a second layer.
      const joined = strokeOf(second!);
      expect(strokeSegments(joined)).toHaveLength(2);
      expect(strokeSegments(joined)[0]).toEqual(strokeOf(first!).points);
      // Still on top: above the fixture's arrow (z 2000), where the first
      // stroke landed.
      expect(second!.node.z_index).toBeGreaterThan(2000);
      expect(second!.bumpZIndexToMax).toBeUndefined();
      expect(ops.filter((op) => op.kind === "delete").map((op) => (op as { id: string }).id)).toEqual([
        first!.node.id
      ]);
      expect(hoisted.layers.filter((l) => l.kind === "vector" && l.shape.kind === "stroke")).toHaveLength(2);
    });

    test("a third stroke joins the row the second one wrote", async () => {
      // A join writes the stroke under a new id; the next stroke must
      // follow it there, not look for the layer the burst started in.
      const canvas = await mountWithDrawTool();
      await drag(canvas, [[100, 100], [150, 140], [200, 120]]);
      await rerender();
      await drag(canvas, [[300, 300], [350, 340], [400, 320]]);
      await rerender();
      await drag(canvas, [[500, 500], [550, 540], [600, 520]]);
      const [, second, third] = upsertsOf();
      expect(upsertsOf()).toHaveLength(3);
      expect(strokeSegments(strokeOf(third!))).toHaveLength(3);
      expect(ops.filter((op) => op.kind === "delete").map((op) => (op as { id: string }).id).at(-1)).toBe(
        second!.node.id
      );
    });

    test("a pause longer than the burst gap starts a new layer", async () => {
      const time = clock();
      try {
        const canvas = await mountWithDrawTool();
        await drag(canvas, [[100, 100], [150, 140], [200, 120]]);
        await rerender();
        time.advance(5000);
        await drag(canvas, [[300, 300], [350, 340], [400, 320]]);
      } finally {
        time.restore();
      }
      expect(upsertsOf().map((op) => strokeOf(op).breaks)).toEqual([undefined, undefined]);
      expect(ops.some((op) => op.kind === "delete")).toBe(false);
    });
  });
});
