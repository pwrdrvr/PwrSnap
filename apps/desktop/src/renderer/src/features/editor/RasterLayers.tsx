// Editor LayerView for NON-base raster layers — pasted images today, the
// captured cursor in Phase 3. Each renders as an absolutely-positioned
// `<img>` inside `.editor-image-clip` (which is canvas-sized with
// overflow:hidden, so the layers are clipped to the canvas exactly like
// the baked composite). The base raster keeps its own `<img>` in
// Editor.tsx; this component draws everything stacked above it.
//
// Display-only for now: `pointer-events: none` so clicks fall through to
// the canvas. Selection / drag / resize for rasters is a later brick
// (extending hitTestOverlays + TransformHandles); until then these layers
// are visible and export-accurate but not yet interactive on-canvas.
//
// Positioning math lives in `computeRasterLayerStyle`, which mirrors the
// compositor (compose-tree.ts `compositeRasterOntoAccumulator`) so a
// layer sits in the same place in the editor as in the export.

import type { ReactElement } from "react";

import type { BundleLayerNode } from "@pwrsnap/shared";

import { layerSourceUrl } from "../../lib/pwrsnap";
import { computeRasterLayerStyle } from "./raster-layer-style";

type RasterLayer = Extract<BundleLayerNode, { kind: "raster" }>;

export function RasterLayers({
  layers,
  captureId,
  canvasWidthPx,
  canvasHeightPx
}: {
  /** Non-base raster layers, in paint order (caller filters out the
   *  base raster and any hidden / rejected layers). */
  layers: readonly RasterLayer[];
  captureId: string;
  canvasWidthPx: number;
  canvasHeightPx: number;
}): ReactElement | null {
  if (layers.length === 0) return null;
  return (
    <>
      {layers.map((layer) => (
        <img
          key={layer.id}
          src={layerSourceUrl(captureId, layer.source_ref.sha256)}
          alt=""
          draggable={false}
          className="editor-raster-layer"
          data-testid="editor-raster-layer"
          data-layer-id={layer.id}
          style={{
            ...computeRasterLayerStyle({
              transform: layer.transform,
              naturalWidthPx: layer.natural_width_px,
              naturalHeightPx: layer.natural_height_px,
              canvasWidthPx,
              canvasHeightPx,
              opacity: layer.opacity
            }),
            display: "block",
            // Clicks fall through to the canvas — these are display-only
            // until raster hit-testing lands.
            pointerEvents: "none"
          }}
        />
      ))}
    </>
  );
}
