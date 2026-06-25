import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { LayersPanel } from "../LayersPanel";
import type { LayersPanelApi } from "../../editor/Editor";

// useCaptureModel is mocked so the panel renders from a fixture tree
// without an IPC bus. The hoisted holder lets each test swap the model.
const h = vi.hoisted(() => ({ model: null as unknown }));
vi.mock("../../editor/useCaptureModel", () => ({
  useCaptureModel: () => h.model
}));

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

const ROOT = "ly_root";

function rootGroup(): BundleLayerNode {
  return { ...common(ROOT, 0, null), kind: "group", collapsed: false };
}
function raster(id = "ly_raster"): BundleLayerNode {
  return {
    ...common(id, 0, ROOT),
    kind: "raster",
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 100,
    natural_height_px: 100
  };
}
function arrow(id = "ly_arrow", z = 2000, visible = true): BundleLayerNode {
  return {
    ...common(id, z, ROOT),
    visible,
    kind: "vector",
    shape: {
      kind: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.4, y: 0.4 },
      color: "auto"
    }
  };
}
function crop(id = "ly_crop", z = 1000): BundleLayerNode {
  return {
    ...common(id, z, ROOT),
    kind: "vector",
    shape: { kind: "crop", rect: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } }
  };
}
// The no-op "inverse crop" the dispatcher leaves behind after a crop is
// undone — its rect expands (w/h > 1). The panel must hide it.
function cropExpandArtifact(id = "ly_crop_expand", z = 1500): BundleLayerNode {
  return {
    ...common(id, z, ROOT),
    kind: "vector",
    shape: { kind: "crop", rect: { x: -0.2, y: -0.2, w: 1.6, h: 1.6 } }
  };
}

function loadedModel(layers: BundleLayerNode[]): unknown {
  return {
    kind: "loaded",
    format: 2,
    captureId: "cap_1",
    record: { id: "cap_1", width_px: 100, height_px: 100 },
    layers,
    layersView: [],
    dispatchEdit: vi.fn()
  };
}

function makeApi() {
  return {
    selectLayers: vi.fn(),
    setLayerVisibility: vi.fn(async () => undefined),
    deleteLayer: vi.fn(async () => undefined),
    moveLayer: vi.fn(async () => undefined),
    uncrop: vi.fn(async () => undefined)
  };
}

async function renderPanel(
  layers: BundleLayerNode[],
  api: ReturnType<typeof makeApi> | null,
  selectedLayerIds: readonly string[] = []
): Promise<HTMLDivElement> {
  h.model = loadedModel(layers);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(LayersPanel, {
        captureId: "cap_1",
        selectedLayerIds,
        api: api as unknown as LayersPanelApi | null
      })
    );
  });
  return container;
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

describe("LayersPanel", () => {
  test("annotations on top (z_index DESC); Source + Crop pinned at the bottom", async () => {
    // Arrow's z_index (100) is BELOW the crop's (1000) — by raw z-order it
    // would sit under the crop. But Source + Crop are pinned base layers,
    // so the annotation must appear ABOVE them, with Crop above Source.
    const el = await renderPanel(
      [rootGroup(), raster(), arrow("ly_arrow", 100), crop()],
      makeApi()
    );
    const rows = Array.from(
      el.querySelectorAll<HTMLElement>('[data-testid^="layer-row-"]')
    );
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      "layer-row-ly_arrow",
      "layer-row-ly_crop",
      "layer-row-ly_raster"
    ]);
  });

  test("reorder arrows are disabled on base layers and at the annotation walls", async () => {
    // Two annotations + base. Top annotation: up disabled. Bottom
    // annotation: down disabled. Base layers (crop, raster): both
    // disabled — an annotation can never move below them.
    const el = await renderPanel(
      [rootGroup(), raster(), arrow("ly_top", 2000), arrow("ly_bottom", 1000), crop()],
      makeApi()
    );
    const dis = (testid: string): boolean =>
      (byId(el, testid) as HTMLButtonElement).disabled;
    expect(dis("layer-forward-ly_top")).toBe(true); // top annotation, can't go up
    expect(dis("layer-backward-ly_top")).toBe(false);
    expect(dis("layer-forward-ly_bottom")).toBe(false);
    expect(dis("layer-backward-ly_bottom")).toBe(true); // bottom annotation, can't cross base
    for (const id of ["ly_crop", "ly_raster"]) {
      expect(dis(`layer-forward-${id}`)).toBe(true);
      expect(dis(`layer-backward-${id}`)).toBe(true);
    }
  });

  test("hides no-op expand-crop artifacts (left behind by crop undo) but keeps real crops", async () => {
    const el = await renderPanel(
      [rootGroup(), raster(), arrow(), crop(), cropExpandArtifact()],
      makeApi()
    );
    const rows = Array.from(
      el.querySelectorAll<HTMLElement>('[data-testid^="layer-row-"]')
    ).map((r) => r.dataset.testid);
    expect(rows).toContain("layer-row-ly_crop");
    expect(rows).not.toContain("layer-row-ly_crop_expand");
  });

  test("base raster trash is disabled; arrow + crop are not", async () => {
    const el = await renderPanel([rootGroup(), raster(), arrow(), crop()], makeApi());
    expect((byId(el, "layer-delete-ly_raster") as HTMLButtonElement).disabled).toBe(true);
    expect((byId(el, "layer-delete-ly_arrow") as HTMLButtonElement).disabled).toBe(false);
    expect((byId(el, "layer-delete-ly_crop") as HTMLButtonElement).disabled).toBe(false);
  });

  test("crop trash routes to uncrop; non-crop trash routes to deleteLayer", async () => {
    const api = makeApi();
    const el = await renderPanel([rootGroup(), raster(), arrow(), crop()], api);
    await act(async () => {
      byId(el, "layer-delete-ly_crop").click();
      byId(el, "layer-delete-ly_arrow").click();
    });
    expect(api.uncrop).toHaveBeenCalledWith("ly_crop");
    expect(api.deleteLayer).toHaveBeenCalledWith("ly_arrow");
    expect(api.deleteLayer).not.toHaveBeenCalledWith("ly_crop");
  });

  test("eye toggles visibility to the opposite of the current value", async () => {
    const api = makeApi();
    const el = await renderPanel([rootGroup(), raster(), arrow("ly_arrow", 2000, true)], api);
    await act(async () => {
      byId(el, "layer-visibility-ly_arrow").click();
    });
    expect(api.setLayerVisibility).toHaveBeenCalledWith("ly_arrow", false);
  });

  test("forward / backward buttons call moveLayer with the direction", async () => {
    // Two annotations so the boundary arrows aren't disabled: click the
    // bottom one's "forward" (enabled) and the top one's "backward".
    const api = makeApi();
    const el = await renderPanel(
      [rootGroup(), raster(), arrow("ly_top", 2000), arrow("ly_bottom", 1000)],
      api
    );
    await act(async () => {
      byId(el, "layer-forward-ly_bottom").click();
      byId(el, "layer-backward-ly_top").click();
    });
    expect(api.moveLayer).toHaveBeenNthCalledWith(1, "ly_bottom", "forward");
    expect(api.moveLayer).toHaveBeenNthCalledWith(2, "ly_top", "backward");
  });

  test("row click selects (plain = replace, meta = additive); raster row doesn't select", async () => {
    const api = makeApi();
    const el = await renderPanel([rootGroup(), raster(), arrow()], api);
    await act(async () => {
      byId(el, "layer-row-ly_arrow").click();
    });
    expect(api.selectLayers).toHaveBeenLastCalledWith("ly_arrow", false);
    await act(async () => {
      byId(el, "layer-row-ly_arrow").dispatchEvent(
        new MouseEvent("click", { bubbles: true, metaKey: true })
      );
    });
    expect(api.selectLayers).toHaveBeenLastCalledWith("ly_arrow", true);
    // The base raster isn't canvas-selectable — clicking its row is a no-op.
    api.selectLayers.mockClear();
    await act(async () => {
      byId(el, "layer-row-ly_raster").click();
    });
    expect(api.selectLayers).not.toHaveBeenCalled();
  });

  test("aria-selected tracks selectedLayerIds", async () => {
    const el = await renderPanel(
      [rootGroup(), raster(), arrow()],
      makeApi(),
      ["ly_arrow"]
    );
    expect(byId(el, "layer-row-ly_arrow").getAttribute("aria-selected")).toBe("true");
    expect(byId(el, "layer-row-ly_raster").getAttribute("aria-selected")).toBe("false");
  });
});
