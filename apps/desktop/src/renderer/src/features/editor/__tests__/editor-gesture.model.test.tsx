import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import fc from "fast-check";
import { BundleLayerNode, type CaptureRecord } from "@pwrsnap/shared";
import { baseSettings } from "../../settings/__tests__/settings-fixture";
import type { LayerEditOp } from "../useCaptureModel";

const state = vi.hoisted(() => ({ layers: [] as BundleLayerNode[], invalid: [] as string[] }));
// jsdom cannot load the capture pixels used by automatic outline sampling.
// This model varies pointer ownership, with the explicit no-outline style.
const settings = {
  ...baseSettings,
  editor: { ...baseSettings.editor, toolStyles: {
    ...baseSettings.editor.toolStyles,
    arrow: { ...baseSettings.editor.toolStyles.arrow, outline: "none" },
    shape: { ...baseSettings.editor.toolStyles.shape, outline: "none" }
  } }
};
vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: vi.fn(async (name: string) => ({ ok: true, value: name === "settings:read" ? settings : {} })),
  dispatchOrThrow: vi.fn(async () => undefined), subscribe: vi.fn(() => () => {}),
  captureSrcUrl: () => "pwrsnap-capture://model", layerSourceUrl: () => "pwrsnap-capture://model/layer",
  cacheUrl: () => "pwrsnap-cache://model", sizzleOutputUrl: () => "pwrsnap-cache://model",
  perfMark: vi.fn(), startCaptureDrag: vi.fn(), startVideoDrag: vi.fn(), startCartZipDrag: vi.fn()
}));

const record: CaptureRecord = {
  id: "gesture-model", kind: "image", captured_at: "2026-11-04T00:00:00Z",
  legacy_src_path: null, bundle_path: "/tmp/gesture-model.pwrsnap", flat_png_path: null,
  bundle_modified_at: null, bundle_format_version: 2, bundle_edits_version: 1,
  width_px: 1000, height_px: 1000, device_pixel_ratio: 1, byte_size: 1024,
  sha256: "b".repeat(64), source_app_bundle_id: null, source_app_name: null,
  source_window_title: null, edits_version: 1, deleted_at: null, has_alpha: false
};

async function persist(op: LayerEditOp) {
  if (op.kind !== "upsert") throw new Error("gesture model unexpectedly dispatched a non-create");
  const node = BundleLayerNode.parse(op.node);
  if (state.layers.some((layer) => layer.id === node.id)) {
    state.invalid.push(node.id);
    return { ok: false, error: { kind: "persistence", code: "insert_failed", message: "live id" } };
  }
  state.layers.push(node);
  return { ok: true, value: { kind: "upsert", artifact: { format: 2, node } } };
}
vi.mock("../useCaptureModel", async (importOriginal) => ({
  ...await importOriginal<typeof import("../useCaptureModel")>(),
  useCaptureModel: () => ({
    kind: "loaded", format: 2, captureId: record.id, record,
    layers: state.layers, layersView: [], dispatchEdit: persist
  })
}));

let originalBounds: typeof Element.prototype.getBoundingClientRect;
let originalResizeObserver: typeof ResizeObserver;
beforeAll(async () => {
  originalBounds = Element.prototype.getBoundingClientRect;
  originalResizeObserver = globalThis.ResizeObserver;
  Element.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 1000,
    width: 1000, height: 1000, toJSON: () => ({})
  });
  globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  await import("../Editor");
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = originalBounds;
  globalThis.ResizeObserver = originalResizeObserver;
});

function pointer(kind: string, pointerId: number, x: number, y: number) {
  return new PointerEvent(kind, {
    bubbles: true, cancelable: true, pointerId, isPrimary: pointerId === 1,
    button: 0, buttons: kind === "pointerup" ? 0 : 1, clientX: x, clientY: y
  });
}

// Product oracle: one pointer owns a gesture until release/cancellation.
// Only its moves contribute geometry; cancellation persists nothing and
// release persists exactly once, including captured delivery outside the canvas.
async function assertGestureScenario(
  tool: "arrow" | "draw", terminal: "release" | "cancel" | "lost" | "blur",
  foreignKind: string, foreignId: number, oneRender: boolean, outside: boolean,
  points: [number, number][]
) {
  const { Editor } = await import("../Editor");
  state.layers = [];
  state.invalid = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(createElement(Editor, { captureId: record.id })); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: tool === "draw" ? "d" : "a", bubbles: true }));
    });
    const canvas = host.querySelector<HTMLElement>("[data-testid='editor-canvas']")!;
    expect(canvas.getAttribute("data-tool")).toBe(tool);
    const last = points[points.length - 1]!;
    const terminalPoint: [number, number] = outside ? [1200, -200] : last;
    const events = [
      () => canvas.dispatchEvent(pointer("pointerdown", 1, 100, 100)),
      () => canvas.dispatchEvent(pointer("pointermove", 1, 300, 200)),
      () => canvas.dispatchEvent(pointer(foreignKind, foreignId, 900, 900)),
      ...points.map(([x, y]) => () => canvas.dispatchEvent(pointer("pointermove", 1, x, y))),
      // Native pointer capture retargets the owner's terminal to the canvas
      // even with coordinates beyond its bounds. jsdom cannot retarget, so
      // model captured-owner delivery explicitly; this is not an OS capture test.
      () => terminal === "blur" ? window.dispatchEvent(new Event("blur")) :
        canvas.dispatchEvent(pointer(
          terminal === "release" ? "pointerup" : terminal === "cancel" ? "pointercancel" : "lostpointercapture", 1, ...terminalPoint
        ))
    ];
    if (oneRender) await act(async () => { for (const emit of events) emit(); });
    else for (const emit of events) await act(async () => { emit(); });
    expect(state.invalid).toEqual([]);
    expect(state.layers).toHaveLength(terminal === "release" ? 1 : 0);
    // Settle and check the FIRST owner terminal before any duplicate can
    // accidentally act as the real release and hide a dropped event.
    const afterFirstTerminal = state.layers.map((node) => node.id);
    if (terminal === "release") {
      const written = state.layers[0]!;
      if (written.kind !== "vector") throw new Error("gesture did not write a vector");
      const start = { x: 0.1, y: 0.1 };
      const end = { x: last[0] / 1000, y: last[1] / 1000 };
      if (written.shape.kind === "arrow") expect(written.shape).toMatchObject({ from: start, to: end });
      else if (written.shape.kind === "stroke") {
        expect(written.shape.points[0]).toMatchObject(start);
        expect(written.shape.points.at(-1)).toMatchObject(end);
        expect(written.shape.points).not.toContainEqual(expect.objectContaining({ x: 0.9, y: 0.9 }));
      } else throw new Error("unexpected gesture shape");
    }
    await act(async () => { canvas.dispatchEvent(pointer("pointerup", 1, ...terminalPoint)); });
    expect(state.invalid).toEqual([]);
    expect(state.layers.map((node) => node.id)).toEqual(afterFirstTerminal);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
  }
}

test.each(["arrow", "draw"] as const)("%s settles its first captured outside release before a duplicate", async (tool) => {
  await assertGestureScenario(tool, "release", "pointermove", 2, false, true, [[500, 200]]);
});

test("generated owner, terminal-event and render orderings match the gesture oracle", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("arrow", "draw"), fc.constantFrom("release", "cancel", "lost", "blur"),
    fc.constantFrom("pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"),
    fc.integer({ min: 2, max: 10 }), fc.boolean(), fc.boolean(),
    fc.array(fc.tuple(fc.integer({ min: 500, max: 900 }), fc.integer({ min: 200, max: 600 })), { minLength: 1, maxLength: 5 }),
    assertGestureScenario
  ), { numRuns: 100 });
});
