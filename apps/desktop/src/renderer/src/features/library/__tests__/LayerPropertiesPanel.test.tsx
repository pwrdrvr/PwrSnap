import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { LayerPropertiesPanel } from "../LayerPropertiesPanel";
import type { LayersPanelApi } from "../../editor/Editor";

const h = vi.hoisted(() => ({ model: null as unknown }));
vi.mock("../../editor/useCaptureModel", () => ({
  useCaptureModel: () => h.model
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const ROOT = "ly_root";

function common(
  id: string,
  zIndex: number,
  parentId: string | null
): Omit<Extract<BundleLayerNode, { kind: "group" }>, "kind" | "collapsed"> {
  return {
    id,
    parent_id: parentId,
    name: "",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: zIndex,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-06-17T12:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-06-17T12:00:00.000Z"
  };
}

function arrow(id = "ly_arrow"): BundleLayerNode {
  return {
    ...common(id, 2000, ROOT),
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.4, y: 0.4 },
      color: "#28c840",
      thickness: "medium",
      endStyle: "dot"
    }
  };
}

function text(id = "ly_text"): BundleLayerNode {
  return {
    ...common(id, 1000, ROOT),
    kind: "vector",
    shape: {
      kind: "text",
      point: { x: 0.1, y: 0.1 },
      body: "Note",
      size: "medium",
      color: "#28c840",
      weight: "regular"
    }
  };
}

function shape(id = "ly_shape"): BundleLayerNode {
  return {
    ...common(id, 900, ROOT),
    kind: "vector",
    shape: {
      kind: "shape",
      shape: "circle",
      rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      color: "#1f7cff",
      thickness: "large",
      filled: true
    }
  };
}

function blur(id = "ly_blur"): BundleLayerNode {
  return {
    ...common(id, 800, ROOT),
    kind: "effect",
    effect: { type: "blur", style: "pixelate", radius_px: 18 },
    clip_rect: { x: 10, y: 10, w: 40, h: 40 }
  };
}

function autoBlur(id = "ly_blur_auto"): BundleLayerNode {
  return {
    ...common(id, 800, ROOT),
    kind: "effect",
    // `loadedModel` is 100 × 100, whose canonical Auto radius is 8px.
    effect: { type: "blur", style: "pixelate", radius_px: 8 },
    clip_rect: { x: 10, y: 10, w: 40, h: 40 }
  };
}

function highlight(id = "ly_highlight"): BundleLayerNode {
  return {
    ...common(id, 700, ROOT),
    kind: "effect",
    effect: { type: "highlight", tint_hex: "#28c840", opacity: 0.6, blend: "screen" },
    clip_rect: { x: 10, y: 10, w: 40, h: 40 }
  };
}

function step(id = "ly_step"): BundleLayerNode {
  return {
    ...common(id, 600, ROOT),
    kind: "vector",
    shape: { kind: "step", point: { x: 0.2, y: 0.2 }, index: 1 }
  };
}

function loadedModel(layers: BundleLayerNode[]): unknown {
  return {
    kind: "loaded",
    format: 2,
    captureId: "cap_1",
    record: { id: "cap_1", width_px: 100, height_px: 100, sha256: "a".repeat(64) },
    layers,
    layersView: [],
    dispatchEdit: vi.fn()
  };
}

function makeApi(): LayersPanelApi {
  return {
    selectLayers: vi.fn(),
    setLayerVisibility: vi.fn(async () => undefined),
    deleteLayer: vi.fn(async () => undefined),
    moveLayerToIndex: vi.fn(async () => undefined),
    uncrop: vi.fn(async () => undefined),
    resetRasterTransform: vi.fn(async () => undefined),
    updateLayerStyle: vi.fn()
  };
}

async function renderPanel(
  layers: BundleLayerNode[],
  selectedLayerIds: readonly string[],
  api: LayersPanelApi = makeApi()
): Promise<{ el: HTMLDivElement; api: LayersPanelApi }> {
  h.model = loadedModel(layers);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(LayerPropertiesPanel, {
        captureId: "cap_1",
        selectedLayerIds,
        api
      })
    );
  });
  return { el: container, api };
}

function byId(el: HTMLElement, testid: string): HTMLElement {
  const node = el.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (node === null) throw new Error(`missing ${testid}`);
  return node;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

describe("LayerPropertiesPanel", () => {
  test("shows the selected arrow's stored style and routes writes to that layer", async () => {
    const api = makeApi();
    const { el } = await renderPanel([arrow()], ["ly_arrow"], api);
    const panel = byId(el, "layer-properties-panel");

    expect(panel.textContent).toContain("Properties");
    expect(panel.textContent).toContain("Arrow");
    expect(byId(panel, "swatch-green").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      byId(panel, "swatch-blue").click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_arrow", "color", "blue");
  });

  test("asks for exactly one selected layer", async () => {
    const { el } = await renderPanel([arrow(), text()], []);
    expect(el.textContent).toContain("Select one layer to inspect its properties.");
  });

  test("shows the selected text's stored style and routes direct edits", async () => {
    const api = makeApi();
    const { el } = await renderPanel([text()], ["ly_text"], api);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Text");
    expect(byId(panel, "swatch-green").getAttribute("aria-checked")).toBe("true");
    expect(byId(panel, "text-font-size")).not.toBeNull();
    expect(byId(panel, "text-weight")).not.toBeNull();
    await act(async () => {
      (byId(panel, "text-font-size").querySelector(
        'button[aria-label="L"]'
      ) as HTMLButtonElement).click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_text", "fontSize", "large");
  });

  test("shows the selected shape's stored style and routes direct edits", async () => {
    const api = makeApi();
    const { el } = await renderPanel([shape()], ["ly_shape"], api);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Circle");
    expect(byId(panel, "swatch-blue").getAttribute("aria-checked")).toBe("true");
    expect(byId(panel, "shape-kind-circle").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      byId(panel, "shape-kind-rect").click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_shape", "shape", "rect");
  });

  test("shows the selected blur's stored style and routes direct edits", async () => {
    const api = makeApi();
    const { el } = await renderPanel([blur()], ["ly_blur"], api);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Blur");
    expect(byId(panel, "blur-mode-pixelate").getAttribute("aria-checked")).toBe("true");
    expect((byId(panel, "blur-radius-custom-input") as HTMLInputElement).value).toBe("18");
    await act(async () => {
      byId(panel, "blur-mode-redact").click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_blur", "mode", "redact");
  });

  test("restores Auto when an effect blur stores the canonical canvas radius", async () => {
    const api = makeApi();
    const { el } = await renderPanel([autoBlur()], ["ly_blur_auto"], api);
    const panel = byId(el, "layer-properties-panel");
    const radius = byId(panel, "blur-radius");
    const auto = Array.from(radius.querySelectorAll<HTMLButtonElement>('button[role="radio"]')).find(
      (button) => button.textContent === "Auto"
    );

    expect(auto?.getAttribute("aria-checked")).toBe("true");
    expect(radius.querySelector('[data-testid="blur-radius-custom-input"]')).toBeNull();
    await act(async () => {
      auto?.click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_blur_auto", "radius", {
      mode: "auto"
    });
  });

  test("shows the selected highlight's stored style and routes direct edits", async () => {
    const api = makeApi();
    const { el } = await renderPanel([highlight()], ["ly_highlight"], api);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Highlight");
    expect(byId(panel, "swatch-green").getAttribute("aria-checked")).toBe("true");
    expect((byId(panel, "highlight-opacity-input") as HTMLInputElement).value).toBe("0.6");
    await act(async () => {
      byId(panel, "swatch-blue").click();
    });
    expect(api.updateLayerStyle).toHaveBeenCalledWith("ly_highlight", "color", "blue");
  });

  test("identifies a selected non-style layer without offering controls", async () => {
    const { el } = await renderPanel([step()], ["ly_step"]);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Step");
    expect(panel.textContent).toContain("not available for this layer yet");
    expect(panel.querySelector('[data-testid="color-row"]')).toBeNull();
  });
});
