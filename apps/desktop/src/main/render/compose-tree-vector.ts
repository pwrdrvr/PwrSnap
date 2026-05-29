// v2 vector-shape rasterizer. Mirrors v1's buildCompositeLayers
// (compose.ts) but with three key differences:
//
//   1. No `srcPath` parameter — v2 effect-layer blurs go through
//      compose-tree.ts's sample-below path (the EffectLayer kind).
//      A `kind: "blur"` shape inside a VectorLayer is treated as a
//      no-op here; the user should add an EffectLayer instead.
//
//   2. Coords interpreted against canvas W×H. v2 documents may have
//      multiple raster layers at different positions, but the vector
//      shape coords are always canvas-pixel-normalized (because the
//      Overlay schema defines all coords as [0,1]).
//
//   3. Scale-aware bake: callers pass RENDER dims (the accumulator's
//      current size — may be larger than the canvas for upscale
//      tiers like LOW=800 on a 361 source) alongside the UNSCALED
//      canvas dims. SVG-based renderers use render dims so strokes
//      scale up proportionally with the output resolution; the HTML
//      text bake uses both render dims (BrowserWindow size) and
//      canvas dims (for sizePx math anchored to the source raster's
//      short side per pwrdrvr/PwrSnap#110). The shared
//      `computeTextHtmlStyle` formula —
//        fontPx = (canvasCssHeight / canvasHeightPx) × sizePx
//      — produces text at `renderScale × sizePx` rendered pixels,
//      matching the editor's display behavior.
//
// SVG generation is reused via the *ForV2 exports from compose.ts so
// pixel-accuracy stays identical to v1 for the SVG-fallback path.

import type sharp from "sharp";

import type { OverlayRow } from "@pwrsnap/shared";

import {
  arrowSvgForV2,
  highlightBlendModeForV2,
  highlightSvgForV2,
  rasterizeSvgForV2,
  shapeSvgForV2,
  textSvgForV2
} from "./compose";
import { rasterizeTextHtmlForV2 } from "./text-html-bake";

export interface BuildCompositeLayersV2Args {
  /** The accumulator's CURRENT dimensions. SVG renderers + the HTML
   *  text bake produce output at these dims. For scale=1 bakes this
   *  equals canvasWidthPx × canvasHeightPx; for upscale tiers (LOW=
   *  800 on a 361 source) it's the larger render-scaled dims. */
  renderWidthPx: number;
  renderHeightPx: number;
  /** Original (unscaled) canvas dims from the capture record. Used
   *  by the HTML text bake's `computeTextHtmlStyle` to compute
   *  fontPx = (canvasCssHeight / canvasHeightPx) × sizePx — see the
   *  module-top doc-block for the rationale. */
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** SOURCE raster's natural dims — drives the bucket × shortSide
   *  fallback for text sizePx when the row doesn't carry an explicit
   *  storedSizePx (pwrdrvr/PwrSnap#110). Optional for synthetic test
   *  trees that have no raster source; falls back to canvas dims. */
  sourceWidthPx?: number | undefined;
  sourceHeightPx?: number | undefined;
}

export async function buildCompositeLayersForV2(
  row: OverlayRow,
  args: BuildCompositeLayersV2Args
): Promise<sharp.OverlayOptions[]> {
  const {
    renderWidthPx,
    renderHeightPx,
    canvasWidthPx,
    canvasHeightPx,
    sourceWidthPx,
    sourceHeightPx
  } = args;
  const data = row.data;
  switch (data.kind) {
    case "arrow":
      return [
        await rasterizeSvgForV2(
          arrowSvgForV2(data, renderWidthPx, renderHeightPx),
          renderWidthPx,
          renderHeightPx
        )
      ];
    case "shape":
      return [
        await rasterizeSvgForV2(
          shapeSvgForV2(data, renderWidthPx, renderHeightPx),
          renderWidthPx,
          renderHeightPx
        )
      ];
    case "highlight": {
      // Blend mode is applied at the sharp composite step (libvips
      // `blend: 'multiply' | 'screen' | 'overlay'`), not in the SVG —
      // resvg's mix-blend-mode handling is unreliable, and the SVG
      // background is transparent anyway so any in-SVG blend would
      // resolve against nothing. Mirrors v1 buildCompositeLayers.
      const layer = await rasterizeSvgForV2(
        highlightSvgForV2(data, renderWidthPx, renderHeightPx),
        renderWidthPx,
        renderHeightPx
      );
      return [{ ...layer, blend: highlightBlendModeForV2(data) }];
    }
    case "text": {
      const effectiveSourceW = sourceWidthPx ?? canvasWidthPx;
      const effectiveSourceH = sourceHeightPx ?? canvasHeightPx;
      // HTML text bake: renders the overlay via a hidden, transparent
      // Electron BrowserWindow → capturePage() → transparent PNG →
      // sharp.composite(). Same Chromium pipeline the editor uses
      // for display + edit; zero font-rendering drift between what
      // the user typed and what we export.
      //
      // Falls back to the SVG path automatically when Electron's
      // `app` module isn't ready yet (unit tests, headless CLI).
      // `rasterizeTextHtmlForV2` will throw a specific error when
      // BrowserWindow can't be constructed; the catch routes through
      // textSvgForV2 (librsvg-based, no Electron context required)
      // so existing test harnesses don't need an Electron mock.
      try {
        return [
          await rasterizeTextHtmlForV2(
            data,
            renderWidthPx,
            renderHeightPx,
            canvasWidthPx,
            canvasHeightPx,
            effectiveSourceW,
            effectiveSourceH
          )
        ];
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("app is not ready") ||
            err.message.includes("Cannot create BrowserWindow") ||
            err.message.includes("BrowserWindow is not a constructor"))
        ) {
          // SVG fallback (unit tests, headless CLI). textSvgForV2's
          // fontSize math is anchored to sourceShortSide (constant
          // regardless of imageWidthPx), so passing renderDims as
          // imageDims would produce text at SOURCE-PIXEL size in a
          // big render canvas — proportionally tiny. Instead, generate
          // the SVG at CANVAS dims (text proportionally correct
          // relative to canvas) and let rasterizeSvgForV2's sharp-
          // backed resize upscale the whole picture — text included,
          // via lanczos interpolation — to render dims.
          //
          // Trade-off: the upscale slightly blurs the text strokes.
          // The HTML bake (preferred production path) doesn't have
          // this issue because Chromium rasterizes text at render
          // resolution directly. This fallback exists for parity in
          // environments where Chromium can't run.
          return [
            await rasterizeSvgForV2(
              textSvgForV2(
                data,
                canvasWidthPx,
                canvasHeightPx,
                effectiveSourceW,
                effectiveSourceH
              ),
              renderWidthPx,
              renderHeightPx
            )
          ];
        }
        throw err;
      }
    }
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
