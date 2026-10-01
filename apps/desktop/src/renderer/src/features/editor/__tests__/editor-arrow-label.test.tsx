// Editor-level test for "Add label" on an arrow: Return on a selected
// arrow opens a label draft beyond its tail — the arrow's color, the
// matching text size, a dimmed placeholder, the caret already in it —
// and typing then Return writes an ordinary text layer whose LEFT edge
// is computed from the drafted (end-aligned) anchor and the measured
// width. Escape and an empty body write nothing.
//
// Mounts the real Editor with the capture model and IPC stubbed (the
// same harness as editor-canvas-drag-handles.test.tsx): the behavior is
// in the wiring between the keyboard handler, the draft and commitText.

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
import type { BundleLayerNode, CaptureRecord } from "@pwrsnap/shared";

const CANVAS_W = 1000;
const CANVAS_H = 1000;

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

// Fully shaped, so a change to CaptureRecord breaks this test loudly
// rather than leaving it green against a stale fixture.
const record: CaptureRecord = {
  id: "cap_1",
  kind: "image",
  captured_at: "2026-09-02T00:00:00Z",
  legacy_src_path: null,
  bundle_path: "/tmp/cap_1.pwrsnap",
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

// Pointing right from (600, 500) to (800, 500): the label goes LEFT of
// the tail, end-aligned. Border "black" keeps commit off the auto
// sampler (which needs a decoded image jsdom cannot provide).
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
    id: "arrow_1",
    name: "Arrow",
    z_index: 1,
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.6, y: 0.5 },
      to: { x: 0.8, y: 0.5 },
      color: "#ff5f57",
      thickness: "large",
      outline: "black"
    }
  }
] as BundleLayerNode[];

const dispatchEdit = vi.fn(async (op: { kind: string; node?: { id: string } }) => ({
  ok: true,
  value: {
    kind: op.kind,
    artifact: {
      node: {
        ...commonLayerProps,
        id: "label_1",
        z_index: 2
      }
    }
  }
}));

// Dynamic import in mount() — see the TDZ note in
// editor-canvas-drag-handles.test.tsx.
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
      dispatchEdit
    })
  };
});

let realGetBoundingClientRect: (() => DOMRect) | null = null;

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
  realGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0, y: 0, left: 0, top: 0,
      width: CANVAS_W, height: CANVAS_H,
      right: CANVAS_W, bottom: CANVAS_H,
      toJSON: () => ({})
    } as DOMRect;
  };
});

afterAll(() => {
  if (realGetBoundingClientRect !== null) {
    Element.prototype.getBoundingClientRect = realGetBoundingClientRect;
    realGetBoundingClientRect = null;
  }
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  dispatchEdit.mockClear();
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

function key(target: EventTarget, k: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** Type into a React-controlled textarea. */
function typeInto(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function labelInput(): HTMLTextAreaElement | null {
  return container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arrow label"]') ?? null;
}

async function mountWithArrowSelected(): Promise<void> {
  const { Editor } = await import("../Editor");
  await act(async () => {
    root?.render(createElement(Editor, { captureId: "cap_1" }));
  });
  const canvas = container?.querySelector<HTMLElement>("[data-testid='editor-canvas']");
  expect(canvas).not.toBeNull();
  await act(async () => {
    canvas!.dispatchEvent(pointer("pointerdown", 700, 500));
    canvas!.dispatchEvent(pointer("pointerup", 700, 500));
  });
}

describe("Editor — Add label on an arrow", () => {
  test("Return opens a dimmed label draft at the tail, in the arrow's style, caret in it", async () => {
    await mountWithArrowSelected();
    expect(labelInput()).toBeNull();

    let event: KeyboardEvent | null = null;
    await act(async () => {
      event = key(document.body, "Enter");
    });
    expect(event!.defaultPrevented).toBe(true);

    const input = labelInput();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    const wrapper = container!.querySelector<HTMLElement>('[data-testid="text-draft"]')!;
    expect(wrapper.getAttribute("data-label-align")).toBe("end");
    // End-aligned just left of the tail (x = 0.6), on its line.
    const left = Number(wrapper.style.left.slice(0, -1));
    expect(left).toBeLessThan(60);
    expect(left).toBeGreaterThan(55);
    expect(Number(wrapper.style.top.slice(0, -1))).toBeCloseTo(50, 5);
    const placeholder = wrapper.querySelector<HTMLElement>("[data-placeholder]");
    expect(placeholder?.textContent).toBe("Label");
    expect(placeholder?.style.color).toBe("rgb(255, 95, 87)");
  });

  test("typing then Return writes a text layer, left edge from the measured width", async () => {
    await mountWithArrowSelected();
    await act(async () => {
      key(document.body, "Enter");
    });
    const input = labelInput()!;
    const wrapper = container!.querySelector<HTMLElement>('[data-testid="text-draft"]')!;
    const anchorX = Number(wrapper.style.left.slice(0, -1)) / 100;
    await act(async () => {
      typeInto(input, "Login button");
    });
    // jsdom does no layout: a 120px label on the 1000px canvas.
    const canvasBox = document.createElement("div");
    Object.defineProperty(canvasBox, "clientWidth", { value: 1000 });
    Object.defineProperty(wrapper, "offsetWidth", { value: 120 });
    Object.defineProperty(wrapper, "offsetParent", { value: canvasBox });
    await act(async () => {
      key(input, "Enter");
    });

    expect(dispatchEdit).toHaveBeenCalledTimes(1);
    const op = dispatchEdit.mock.calls[0]![0] as unknown as {
      kind: string;
      node: { kind: string; shape: Record<string, unknown> };
    };
    expect(op.kind).toBe("upsert");
    expect(op.node.kind).toBe("vector");
    expect(op.node.shape).toMatchObject({
      kind: "text",
      body: "Login button",
      color: "#ff5f57",
      size: "large",
      weight: "bold",
      outline: "black"
    });
    const point = op.node.shape["point"] as { x: number; y: number };
    expect(point.x).toBeCloseTo(anchorX - 0.12, 6);
    expect(point.y).toBeCloseTo(0.5, 6);
    expect(labelInput()).toBeNull();
  });

  test("Escape, or Return on an empty label, writes nothing", async () => {
    await mountWithArrowSelected();
    await act(async () => {
      key(document.body, "Enter");
    });
    await act(async () => {
      typeInto(labelInput()!, "never mind");
    });
    await act(async () => {
      key(labelInput()!, "Escape");
    });
    expect(labelInput()).toBeNull();

    await act(async () => {
      key(document.body, "Enter");
    });
    expect(labelInput()).not.toBeNull();
    await act(async () => {
      key(labelInput()!, "Enter");
    });
    expect(labelInput()).toBeNull();
    expect(dispatchEdit).not.toHaveBeenCalled();
  });

  test("Return on a focused button is the button's, not a label", async () => {
    await mountWithArrowSelected();
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    await act(async () => {
      key(button, "Enter");
    });
    expect(labelInput()).toBeNull();
    button.remove();
  });
});
