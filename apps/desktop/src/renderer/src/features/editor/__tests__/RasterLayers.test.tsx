// Component tests for the non-base raster LayerView. Verifies the
// structural contract (one <img> per layer, the per-source protocol URL,
// the layer id, display-only pointer-events) and that the positioning
// helper is wired through to inline styles. Visual WYSIWYG parity with
// the compositor is covered by raster-layer-style.test.ts + manual QA.
//
// Uses React's createRoot + act (no @testing-library/react dep — the
// renderer test suite drives components this way; see CropTool.test.tsx).

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import type { BundleLayerNode } from "@pwrsnap/shared";

import { RasterLayers } from "../RasterLayers";

type RasterLayer = Extract<BundleLayerNode, { kind: "raster" }>;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeRaster(overrides: Partial<RasterLayer> = {}): RasterLayer {
  return {
    id: "layer-1",
    parent_id: "root",
    kind: "raster",
    name: "Pasted Image",
    visible: true,
    locked: false,
    opacity: 1,
    blend_mode: "normal",
    transform: [1, 0, 0, 1, 0, 0],
    z_index: 1,
    source: "user",
    ai_run_id: null,
    applied_at: "2026-01-01T00:00:00.000Z",
    rejected_at: null,
    superseded_by: null,
    created_at: "2026-01-01T00:00:00.000Z",
    source_ref: { kind: "embedded", sha256: "a".repeat(64) },
    natural_width_px: 100,
    natural_height_px: 50,
    ...overrides
  };
}

async function renderLayers(props: {
  layers: readonly RasterLayer[];
  captureId: string;
  canvasWidthPx: number;
  canvasHeightPx: number;
  selectedLayerIds?: readonly string[];
}): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(RasterLayers, { selectedLayerIds: [], ...props })
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

describe("RasterLayers", () => {
  test("renders nothing when there are no layers", async () => {
    await renderLayers({ layers: [], captureId: "cap1", canvasWidthPx: 200, canvasHeightPx: 100 });
    expect(container!.querySelectorAll("img")).toHaveLength(0);
  });

  test("renders one <img> per layer with the per-source URL + layer id", async () => {
    const sha = "b".repeat(64);
    await renderLayers({
      layers: [makeRaster({ id: "L1", source_ref: { kind: "embedded", sha256: sha } })],
      captureId: "cap1",
      canvasWidthPx: 200,
      canvasHeightPx: 100
    });
    const imgs = container!.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    const img = imgs[0]!;
    expect(img.getAttribute("src")).toBe(`pwrsnap-capture://s/cap1/${sha}`);
    expect(img.getAttribute("data-layer-id")).toBe("L1");
    // Display-only until raster hit-testing lands.
    expect(img.style.pointerEvents).toBe("none");
  });

  test("positions a layer by its transform (left/top/width %)", async () => {
    await renderLayers({
      layers: [
        makeRaster({ transform: [1, 0, 0, 1, 40, 20], natural_width_px: 100, natural_height_px: 50 })
      ],
      captureId: "c",
      canvasWidthPx: 200,
      canvasHeightPx: 100
    });
    const img = container!.querySelector("img")!;
    expect(img.style.left).toBe("20%"); // 40 / 200
    expect(img.style.top).toBe("20%"); // 20 / 100
    expect(img.style.width).toBe("50%"); // 100 / 200
    expect(img.style.position).toBe("absolute");
  });

  test("renders multiple layers in paint order", async () => {
    await renderLayers({
      layers: [makeRaster({ id: "A" }), makeRaster({ id: "B" }), makeRaster({ id: "C" })],
      captureId: "c",
      canvasWidthPx: 200,
      canvasHeightPx: 100
    });
    const ids = Array.from(container!.querySelectorAll("img")).map((el) =>
      el.getAttribute("data-layer-id")
    );
    expect(ids).toEqual(["A", "B", "C"]);
  });

  test("a selected layer gets the is-selected class", async () => {
    await renderLayers({
      layers: [makeRaster({ id: "L1" }), makeRaster({ id: "L2" })],
      captureId: "c",
      canvasWidthPx: 200,
      canvasHeightPx: 100,
      selectedLayerIds: ["L1"]
    });
    const sel = container!.querySelector('[data-layer-id="L1"]')!;
    const unsel = container!.querySelector('[data-layer-id="L2"]')!;
    expect(sel.classList.contains("is-selected")).toBe(true);
    expect(sel.getAttribute("data-selected")).toBe("true");
    expect(unsel.classList.contains("is-selected")).toBe(false);
  });
});
