// v2 vector-shape rasterizer. Mirrors v1's buildCompositeLayers
// (compose.ts) but with two key differences:
//
//   1. No `srcPath` parameter — v2 effect-layer blurs go through
//      compose-tree.ts's sample-below path (the EffectLayer kind).
//      A `kind: "blur"` shape inside a VectorLayer is treated as a
//      no-op here; the user should add an EffectLayer instead.
//
//   2. Coords interpreted against canvas W×H (passed as imageWidthPx /
//      imageHeightPx). v2 documents may have multiple raster layers
//      at different positions, but the vector shape coords are
//      always canvas-pixel-normalized (because the Overlay schema
//      defines all coords as [0,1]).
//
// SVG generation is reused via the *ForV2 exports from compose.ts so
// pixel-accuracy stays identical to v1.

import type sharp from "sharp";

import type { OverlayRow } from "@pwrsnap/shared";

import {
  arrowSvgForV2,
  highlightSvgForV2,
  rasterizeSvgForV2,
  rectSvgForV2,
  textSvgForV2
} from "./compose";

export async function buildCompositeLayersForV2(
  row: OverlayRow,
  canvasWidthPx: number,
  canvasHeightPx: number
): Promise<sharp.OverlayOptions[]> {
  const data = row.data;
  switch (data.kind) {
    case "arrow":
      return [
        await rasterizeSvgForV2(
          arrowSvgForV2(data, canvasWidthPx, canvasHeightPx),
          canvasWidthPx,
          canvasHeightPx
        )
      ];
    case "rect":
      return [
        await rasterizeSvgForV2(
          rectSvgForV2(data, canvasWidthPx, canvasHeightPx),
          canvasWidthPx,
          canvasHeightPx
        )
      ];
    case "highlight":
      return [
        await rasterizeSvgForV2(
          highlightSvgForV2(data, canvasWidthPx, canvasHeightPx),
          canvasWidthPx,
          canvasHeightPx
        )
      ];
    case "text":
      return [
        await rasterizeSvgForV2(
          textSvgForV2(data, canvasWidthPx, canvasHeightPx),
          canvasWidthPx,
          canvasHeightPx
        )
      ];
    case "blur":
      // v2's blur path is the EffectLayer kind (sample-below from the
      // running accumulator). A `kind: "blur"` vector shape doesn't
      // have access to the accumulator at this layer, so it's a no-op
      // here. The editor should add an EffectLayer for blur instead.
      return [];
    case "step":
    case "crop":
      // Step + crop don't ship as standalone SVG layers in v1 either
      // (step is renderer chrome; crop is consumed at compose time
      // via .extract). v2 inherits that.
      return [];
    default:
      return [];
  }
}
