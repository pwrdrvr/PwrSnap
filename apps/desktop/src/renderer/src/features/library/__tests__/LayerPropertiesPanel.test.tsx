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
      color: "#28c840"
    }
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

  test("identifies a selected non-arrow without offering arrow controls", async () => {
    const { el } = await renderPanel([text()], ["ly_text"]);
    const panel = byId(el, "layer-properties-panel");
    expect(panel.textContent).toContain("Text");
    expect(panel.textContent).toContain("not available for this layer yet");
    expect(panel.querySelector('[data-testid="color-row"]')).toBeNull();
  });
});
