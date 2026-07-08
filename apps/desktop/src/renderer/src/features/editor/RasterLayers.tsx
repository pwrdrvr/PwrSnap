// Editor LayerView for NON-base raster layers — pasted images today, the
// captured cursor in Phase 3. Each renders as an absolutely-positioned
// `<img>` inside `.editor-image-clip` (which is canvas-sized with
// overflow:hidden, so the layers are clipped to the canvas exactly like
// the baked composite). The base raster keeps its own `<img>` in
// Editor.tsx; this component draws everything stacked above it.
//
// Selection: a selected raster gets the `is-selected` class (an accent
// outline in editor.css). Hit-testing lives in `raster-hit-test.ts` and
// is wired into Editor.tsx's pointerdown; the <img> itself stays
// `pointer-events: none` so the canvas owns the gesture. Drag-to-move is
// wired: Editor.tsx's raster gesture (solo drag) and the group multi-drag
// both pass live transforms via `draftTransforms` during the drag, then
// commit through dispatchEdit's `transform` geometry (undo-integrated).
// Resize is wired too: `RasterResizeHandles` draws 8 corner/edge handles on
// a single-selected raster and drives the same `draftTransforms` preview +
// transform-geometry commit via `resizeRasterTransform`.
//
// Positioning math lives in `computeRasterLayerStyle`, which mirrors the
// compositor (compose-tree.ts `compositeRasterOntoAccumulator`) so a
// layer sits in the same place in the editor as in the export.

import type { ReactElement } from "react";

import type { AffineTransform, BundleLayerNode } from "@pwrsnap/shared";

import { layerSourceUrl } from "../../lib/pwrsnap";
import { computeRasterLayerStyle } from "./raster-layer-style";

type RasterLayer = Extract<BundleLayerNode, { kind: "raster" }>;

export function RasterLayers({
  layers,
  captureId,
  canvasWidthPx,
  canvasHeightPx,
  selectedLayerIds,
  draftTransforms = null
}: {
  /** Non-base raster layers, in paint order (caller filters out the
   *  base raster and any hidden / rejected layers). */
  layers: readonly RasterLayer[];
  captureId: string;
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Canvas selection (owned by the editor) — drives the accent outline. */
  selectedLayerIds: readonly string[];
  /** Live drag-preview overrides, id → in-progress transform: while the
   *  user drags raster(s) on the canvas — solo gesture or a mixed group
   *  drag — the editor passes each raster's in-flight transform here so
   *  the `<img>`s follow the cursor without a model round-trip. Cleared
   *  when the drag commits (the refetched model carries the result). */
  draftTransforms?: ReadonlyMap<string, AffineTransform> | null;
}): ReactElement | null {
  if (layers.length === 0) return null;
  return (
    <>
      {layers.map((layer) => {
        const selected = selectedLayerIds.includes(layer.id);
        const draft = draftTransforms?.get(layer.id);
        const dragging = draft !== undefined;
        return (
          <img
            key={layer.id}
            src={layerSourceUrl(captureId, layer.source_ref.sha256)}
            alt=""
            draggable={false}
            className={
              "editor-raster-layer" +
              (selected ? " is-selected" : "") +
              (dragging ? " is-dragging" : "")
            }
            data-testid="editor-raster-layer"
            data-layer-id={layer.id}
            data-selected={selected ? "true" : undefined}
            style={{
              ...computeRasterLayerStyle({
                transform: draft ?? layer.transform,
                naturalWidthPx: layer.natural_width_px,
                naturalHeightPx: layer.natural_height_px,
                canvasWidthPx,
                canvasHeightPx,
                opacity: layer.opacity
              }),
              display: "block",
              // Clicks fall through to the canvas; the canvas pointerdown
              // owns hit-testing + selection (raster-hit-test.ts).
              pointerEvents: "none"
            }}
          />
        );
      })}
    </>
  );
}
