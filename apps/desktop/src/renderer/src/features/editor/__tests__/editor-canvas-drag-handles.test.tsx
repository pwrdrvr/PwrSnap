// Editor-level regression test: the transform handles must follow a
// CANVAS-DRIVEN drag, not just a drag that starts on TransformHandles'
// own body-hit rect.
//
// Two different code paths move a selected layer, and only one of them
// used to move the handles with it:
//
//   • Press in the MIDDLE of the text → TransformHandles' body-hit
//     rect catches the pointerdown, and the component tracks the drag
//     in its OWN `liveData`. The rotate handle follows, because it is
//     positioned off `bodyBox`, which is derived from that `liveData`.
//
//   • Press on the EDGE of the text — anywhere on the dashed selection
//     outline — and the body-hit rect never sees the event. The
//     outline is drawn `pad 0.006` OUTSIDE the glyph box while the
//     body rect IS the glyph box, so the visible dashed border is
//     always outside the body rect and inside the hit-test's `padN`.
//     The press falls through to the canvas, which arms `armMultiDrag`
//     and paints the move through `draftGeometry` instead.
//
// OverlaySvg, BlurOverlays and TextHtmlOverlays all take that override
// as `liveOverride` and paint the layer at the dragged position.
// TransformHandles took a RAW row straight off `overlays.find(...)` —
// so during a canvas drag the glyph and its dashed outline moved while
// the rotate handle stayed at the pre-drag position and only caught up
// when the commit's refetch landed. That is the "rotate ball gets left
// behind, then jumps" the bug report describes.
//
// This mounts the real Editor (with the capture model and the IPC
// bridge stubbed) because the defect is in the WIRING — every
// component involved behaves correctly in isolation. A test that
// re-implemented the prop derivation would have passed against the
// broken build.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode, CaptureRecord } from "@pwrsnap/shared";

const CANVAS_W = 1000;
const CANVAS_H = 1000;

// The editor's <img> src + every command dispatch go through this
// module. Nothing here needs to do real work: the test drives pointer
// events and reads back DOM geometry, and the drag's COMMIT is
// deliberately never exercised (we assert on the in-flight frame).
vi.mock("../../../lib/pwrsnap", () => ({
  // Every consumer of `settings:read` in this tree guards on
  // `result.ok` and falls back to its built-in defaults, so failing the
  // read is the smallest stub that keeps the editor on its default
  // tool styles instead of hauling a whole Settings fixture in here.
  dispatch: vi.fn(async (name: string) =>
    name === "settings:read" || name === "settings:secretStatus"
      ? { ok: false, error: { kind: "settings", code: "unavailable", message: "stub" } }
      : { ok: true, value: undefined }
  ),
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

const SOURCE_SHA = "a".repeat(64);

const record = {
  id: "cap_1",
  created_at: "2026-09-02T00:00:00Z",
  width_px: CANVAS_W,
  height_px: CANVAS_H,
  sha256: SOURCE_SHA,
  bundle_format_version: 2
} as unknown as CaptureRecord;

const commonLayerProps = {
  parent_id: "g_root",
  visible: true,
  locked: false,
  opacity: 1,
  blend_mode: "normal",
  transform: [1, 0, 0, 1, 0, 0],
  source: "user",
  ai_run_id: null,
  applied_at: "2026-09-02T00:00:00Z",
  rejected_at: null,
  superseded_by: null,
  created_at: "2026-09-02T00:00:00Z"
} as const;

// A v2 VectorLayer carries the v1 Overlay shape VERBATIM, so its
// coords are normalized [0,1] (it is the EFFECT layers that store
// canvas pixels and get divided down in the projection). With the
// 1000×1000 canvas below, one normalized unit is 1000 client px.
const TEXT_ANCHOR_N = { x: 0.3, y: 0.5 };

const layers: BundleLayerNode[] = [
  {
    ...commonLayerProps,
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
    ...commonLayerProps,
    id: "text_1",
    name: "Text",
    z_index: 1,
    kind: "vector",
    shape: {
      kind: "text",
      point: TEXT_ANCHOR_N,
      body: "Believe it or not",
      size: "medium",
      color: "auto"
    }
  }
] as unknown as BundleLayerNode[];

vi.mock("../useCaptureModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../useCaptureModel")>();
  return {
    ...actual,
    useCaptureModel: () => ({
      kind: "loaded",
      format: 2,
      captureId: "cap_1",
      record,
      layers,
      layersView: [],
      dispatchEdit: vi.fn(async () => ({ ok: true, value: { kind: "update" } }))
    })
  };
});

beforeAll(() => {
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
  // jsdom lays nothing out, so every rect is 0×0 and the editor's
  // client→normalized conversions bail. Pin one square viewport at the
  // origin so a client coordinate IS a canvas coordinate.
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, left: 0, top: 0,
      width: CANVAS_W, height: CANVAS_H,
      right: CANVAS_W, bottom: CANVAS_H,
      toJSON: () => ({})
    } as DOMRect;
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
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

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
    pointerId: 1,
    isPrimary: true
  });
}

/** Percentage-valued inline style (`left: "45.58%"`) → number. The
 *  handles and the glyph wrapper are both positioned in `%` of the
 *  canvas, so one normalized unit is 100 of these. */
function pct(el: HTMLElement, axis: "left" | "top"): number {
  const raw = el.style[axis];
  expect(raw.endsWith("%")).toBe(true);
  return Number(raw.slice(0, -1));
}

function query(testid: string): HTMLElement {
  const el = container?.querySelector(`[data-testid='${testid}']`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

/** The absolutely-positioned wrapper TextHtml puts the glyph inside —
 *  the thing that actually paints where the user sees the text. */
function glyphWrapper(): HTMLElement {
  return query("text-glyph").parentElement as HTMLElement;
}

describe("Editor — transform handles during a canvas-driven drag", () => {
  async function mount(): Promise<HTMLElement> {
    const { Editor } = await import("../Editor");
    await act(async () => {
      root?.render(createElement(Editor, { captureId: "cap_1" }));
    });
    return query("editor-canvas");
  }

  test("the rotate handle follows a drag the CANVAS armed", async () => {
    const canvas = await mount();

    // Press on the glyph. Nothing is selected yet, so TransformHandles
    // is not mounted and the canvas necessarily owns this press — the
    // `replace` → `armMultiDrag` arm. This is also the path a press on
    // the dashed outline of an ALREADY-selected layer takes, since the
    // outline is drawn outside the body-hit rect.
    await act(async () => {
      canvas.dispatchEvent(pointer("pointerdown", 310, 500));
    });

    const glyphBefore = pct(glyphWrapper(), "left");
    const rotateBefore = pct(query("transform-handle-rotate"), "left");
    const bodyBefore = pct(query("transform-handle-body"), "left");

    // Drag +200px on a 1000px canvas → +0.2 normalized → +20 points.
    await act(async () => {
      canvas.dispatchEvent(pointer("pointermove", 510, 500));
    });

    // Control: the glyph itself moved. TextHtmlOverlays paints through
    // `liveOverride`, so if this fails the gesture never armed and the
    // handle assertions below would pass for the wrong reason.
    expect(pct(glyphWrapper(), "left") - glyphBefore).toBeCloseTo(20, 5);

    // The bug: these two read the selected row, which used to come
    // straight off `overlays.find(...)` with no override applied — so
    // they sat at the pre-drag position for the whole gesture and only
    // caught up when the commit's refetch landed.
    expect(pct(query("transform-handle-rotate"), "left") - rotateBefore).toBeCloseTo(
      20,
      5
    );
    expect(pct(query("transform-handle-body"), "left") - bodyBefore).toBeCloseTo(20, 5);
  });

  test("the rotate handle still follows a drag the BODY RECT armed", async () => {
    const canvas = await mount();

    // Select without moving, so TransformHandles mounts.
    await act(async () => {
      canvas.dispatchEvent(pointer("pointerdown", 400, 500));
      canvas.dispatchEvent(pointer("pointerup", 400, 500));
    });

    const bodyRect = query("transform-handle-body");
    const glyphBefore = pct(glyphWrapper(), "left");
    const rotateBefore = pct(query("transform-handle-rotate"), "left");

    // Second gesture, this time landing on the body-hit rect — the
    // "press in the middle of the text" path, which TransformHandles
    // tracks in its own `liveData`. This one always worked; pin it so
    // the fix for the canvas path can't regress it.
    await act(async () => {
      bodyRect.dispatchEvent(pointer("pointerdown", 400, 500));
      bodyRect.dispatchEvent(pointer("pointermove", 600, 500));
    });

    expect(pct(glyphWrapper(), "left") - glyphBefore).toBeCloseTo(20, 5);
    expect(pct(query("transform-handle-rotate"), "left") - rotateBefore).toBeCloseTo(
      20,
      5
    );
  });
});
