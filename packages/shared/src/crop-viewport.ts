// Crop viewport math — the single source of truth for how a v2 crop maps
// between the cropped canvas's coordinate space and the full source image.
//
// A crop in PwrSnap is a NON-DESTRUCTIVE viewport, not a pixel-destroying
// op: cropping shrinks `canvas_dimensions`, translates the raster layer so
// the kept region aligns to the canvas origin, and re-normalizes every
// overlay into the smaller canvas's [0,1] space. Overlays in the cropped-
// away region keep real (out-of-[0,1]) coords and are clipped only at
// paint time — so the full image is always reconstructable from saved
// state.
//
// `resolveCropViewport` turns that reconstructability into a render-time
// toggle: when the lone crop layer is HIDDEN (its `visible` flag is false),
// it derives the full-image canvas dims and a layer tree projected back
// into source space — WITHOUT mutating stored coords. Because it's a pure
// function of the stored layers, toggling the crop's visibility on/off is
// bit-stable: nothing is ever re-persisted, so annotations never "walk".
//
// Both the renderer (live editor canvas) and main (bake compositor) import
// from here so the cropped ⇄ full mapping can never drift between what you
// see while editing and what gets baked/exported.

import type { Overlay } from "./overlay-schemas";
import type { BundleLayerNode } from "./bundle-manifest-schema-v2";

/** A rectangle in normalized [0,1] coordinates (origin + size). */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Re-normalize an Overlay's coords by the INVERSE of a crop rect.
 *
 *  Overlay coords are normalized [0,1] to the canvas. When the canvas
 *  is cropped, the canvas dims shrink BUT the absolute-pixel position
 *  the user sees the overlay at should NOT move — overlays in the
 *  kept region stay put visually; overlays in the cropped-away region
 *  end up with normalized coords outside [0,1] and get clipped by
 *  the canvas at render time.
 *
 *  Without this transform a text overlay at point.x = 0.95 on an
 *  800-px canvas (absolute pixel 760) would still render at 0.95 of
 *  the NEW 480-px canvas (absolute pixel 456) after a crop to 60%
 *  width — i.e. the text would visually SLIDE LEFT into the kept
 *  region instead of being clipped at the right edge.
 *
 *  Formula (per axis): `new = (old - rect.origin) / rect.size`.
 *  For width / height (no offset, just scale): `new_w = old_w / rect.w`.
 *  The current v2 crop dispatcher collapses rect.x/y to 0, but the
 *  formula handles non-(0,0) crops too in case the off-origin path
 *  ever ships.
 *
 *  Crop is a VIEWPORT change, not a destructive op (the user's mental
 *  model on pwrdrvr/PwrSnap#110 review). Overlays at absolute source
 *  pixels outside the cropped viewport must persist as DATA (coords > 1
 *  or < 0 in the new canvas's [0,1] space) so that undoing the crop
 *  restores them to their original positions. NormalizedScalar was
 *  widened from `.min(0).max(1)` to `.finite()` to accept out-of-canvas
 *  coords; renderer + bake clip at the canvas boundary at paint time
 *  (SVG overflow + sharp composite).
 *
 *  Returns null for CropOverlay (the crop layer itself is in the
 *  pre-crop space and is replaced wholesale by the dispatcher, so
 *  re-normalizing it would scramble the rect meaninglessly). */
export function inverseTransformOverlayByCrop(
  overlay: Overlay,
  cropRect: CropRect
): Overlay | null {
  const { x: cx, y: cy, w: cw, h: ch } = cropRect;
  if (cw <= 0 || ch <= 0) return null;
  const tx = (n: number): number => (n - cx) / cw;
  const ty = (n: number): number => (n - cy) / ch;
  const sx = (n: number): number => n / cw;
  const sy = (n: number): number => n / ch;
  switch (overlay.kind) {
    case "arrow":
      return {
        ...overlay,
        from: { x: tx(overlay.from.x), y: ty(overlay.from.y) },
        to: { x: tx(overlay.to.x), y: ty(overlay.to.y) }
      };
    case "shape":
    case "highlight":
    case "blur":
      return {
        ...overlay,
        rect: {
          x: tx(overlay.rect.x),
          y: ty(overlay.rect.y),
          w: sx(overlay.rect.w),
          h: sy(overlay.rect.h)
        }
      } as Overlay;
    case "text":
    case "step":
      return {
        ...overlay,
        point: { x: tx(overlay.point.x), y: ty(overlay.point.y) }
      };
    case "crop":
      return null;
  }
}

/** Compute the rect that, fed back into the crop dispatcher, REVERSES a
 *  forward crop of `rect` — i.e. uncrops. The forward crop maps a
 *  normalized coord `n → (n - x) / w`; the inverse is `n → n*w + x`,
 *  which the SAME dispatcher reproduces from the rect:
 *    x' = -x/w,  y' = -y/h,  w' = 1/w,  h' = 1/h
 *  So `dispatchEdit({ kind: "crop", rect: inverseCropRect(forward) })`
 *  re-normalizes every overlay back to its pre-crop position, restores
 *  off-origin raster/effect transforms, and grows the canvas back to
 *  the pre-crop dims — round-tripping exactly. Returns null for a
 *  degenerate rect. */
export function inverseCropRect(rect: CropRect): CropRect | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  return {
    x: -rect.x / rect.w,
    y: -rect.y / rect.h,
    w: 1 / rect.w,
    h: 1 / rect.h
  };
}

/** The CUMULATIVE crop rect — the region of the natural source raster
 *  that the current canvas shows — in the source's normalized [0,1]
 *  space. Derived from the canvas dims + the raster layer's translation,
 *  NOT from any single crop layer's rect (crops collapse to one layer
 *  that only records the LAST step, so its rect can't express a stack of
 *  crops). Feeding this through `inverseCropRect` and dispatching the
 *  result FULLY uncrops to the original image in one op, regardless of
 *  how many crops were applied. Returns null for a degenerate source;
 *  the identity rect {0,0,1,1} when the canvas already shows the whole
 *  source (not cropped). */
export function cropRectFromCanvas(args: {
  canvasWidthPx: number;
  canvasHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
}): CropRect | null {
  const {
    canvasWidthPx,
    canvasHeightPx,
    sourceWidthPx,
    sourceHeightPx,
    rasterTranslateXPx,
    rasterTranslateYPx
  } = args;
  if (sourceWidthPx <= 0 || sourceHeightPx <= 0) return null;
  return {
    // The canvas origin shows source pixel (-translate); normalize it.
    // `+ 0` collapses a signed -0 (from `-0 / w`) to +0 so callers and
    // equality checks never trip on negative zero.
    x: -rasterTranslateXPx / sourceWidthPx + 0,
    y: -rasterTranslateYPx / sourceHeightPx + 0,
    w: canvasWidthPx / sourceWidthPx,
    h: canvasHeightPx / sourceHeightPx
  };
}

/** Is this layer the lone crop marker (a vector layer carrying the
 *  `crop` shape)? Kept local to the shared module so main + renderer
 *  agree without importing the renderer-side `layer-roles` helper. */
function isCropVectorLayer(layer: BundleLayerNode): boolean {
  return layer.kind === "vector" && layer.shape.kind === "crop";
}

/** Project ONE layer from the cropped canvas's coordinate space back
 *  into the full source image's space. `rect` is the source window the
 *  cropped canvas currently shows (`cropRectFromCanvas`); `naturalW/H`
 *  are the source raster's natural dims (the full-image canvas size).
 *
 *  • raster — reset the crop translate to 0 so the full source paints
 *    from the origin (scale components preserved).
 *  • vector — map normalized shape coords `n → n*rect.w + rect.x` via
 *    `inverseTransformOverlayByCrop(shape, inverseCropRect(rect))`. The
 *    crop marker itself is left untouched (it's hidden, paints nothing).
 *  • effect — `clip_rect` is in CANVAS pixels (1:1 with source pixels;
 *    crop only windows, never scales), so add back the crop origin in
 *    px (`rect.x * naturalW`). Sizes are unchanged.
 *  • group — no spatial surface in v2.0. */
function projectLayerToSource(
  layer: BundleLayerNode,
  rect: CropRect,
  naturalW: number,
  naturalH: number,
  inv: CropRect
): BundleLayerNode {
  switch (layer.kind) {
    case "raster":
      return {
        ...layer,
        transform: [
          layer.transform[0],
          layer.transform[1],
          layer.transform[2],
          layer.transform[3],
          0,
          0
        ]
      };
    case "vector": {
      if (layer.shape.kind === "crop") return layer;
      const shape = inverseTransformOverlayByCrop(layer.shape, inv);
      return shape === null ? layer : { ...layer, shape };
    }
    case "effect": {
      if (layer.clip_rect === null) return layer;
      return {
        ...layer,
        clip_rect: {
          x: layer.clip_rect.x + rect.x * naturalW,
          y: layer.clip_rect.y + rect.y * naturalH,
          w: layer.clip_rect.w,
          h: layer.clip_rect.h
        }
      };
    }
    case "group":
      return layer;
  }
}

/** Map a normalized point from the FULL-SOURCE (displayed) space back
 *  into STORED (cropped-canvas) space: `n → (n - rect.origin) / rect.size`.
 *  The inverse of the display projection — use it to persist an overlay
 *  the user drew on the uncropped view so it lands at the right stored
 *  coords (and clips correctly when the crop is shown again). */
export function forwardCropPoint(
  p: { x: number; y: number },
  rect: CropRect
): { x: number; y: number } {
  return { x: (p.x - rect.x) / rect.w, y: (p.y - rect.y) / rect.h };
}

/** Map a normalized rect from FULL-SOURCE space back into STORED space.
 *  Origin shifts + scales by the crop window; size scales only. */
export function forwardCropRect(
  r: { x: number; y: number; w: number; h: number },
  rect: CropRect
): { x: number; y: number; w: number; h: number } {
  return {
    x: (r.x - rect.x) / rect.w,
    y: (r.y - rect.y) / rect.h,
    w: r.w / rect.w,
    h: r.h / rect.h
  };
}

/** Inverse of `projectLayerToSource`: map ONE layer from the displayed
 *  (full-source) space back into STORED (cropped-canvas) space, for
 *  committing an edit made on the uncropped view. `naturalW/H` are the
 *  source raster's natural dims. The raster is returned unchanged (a draw
 *  never creates one); the crop marker is left untouched. */
export function forwardLayerToStored(
  layer: BundleLayerNode,
  rect: CropRect,
  naturalW: number,
  naturalH: number
): BundleLayerNode {
  switch (layer.kind) {
    case "vector": {
      if (layer.shape.kind === "crop") return layer;
      const shape = inverseTransformOverlayByCrop(layer.shape, rect);
      return shape === null ? layer : { ...layer, shape };
    }
    case "effect": {
      if (layer.clip_rect === null) return layer;
      return {
        ...layer,
        clip_rect: {
          x: layer.clip_rect.x - rect.x * naturalW,
          y: layer.clip_rect.y - rect.y * naturalH,
          w: layer.clip_rect.w,
          h: layer.clip_rect.h
        }
      };
    }
    case "raster":
    case "group":
      return layer;
  }
}

/** The effective render state of a capture's layer tree once crop
 *  visibility is taken into account. */
export interface CropViewport {
  /** True when a single crop layer exists AND is hidden — render the
   *  full source image instead of the cropped viewport. */
  uncropped: boolean;
  /** Canvas dims to render at: the source's natural dims when
   *  `uncropped`, else the passed-in (cropped) canvas dims. */
  widthPx: number;
  heightPx: number;
  /** The source window the cropped canvas shows, in source-normalized
   *  [0,1]. Non-null only when `uncropped`. Use it to map freshly drawn
   *  overlays from the displayed (full-image) space back into stored
   *  (cropped) space: `inverseTransformOverlayByCrop(overlay, rect)`. */
  rect: CropRect | null;
  /** The layer tree to render. Identity (same refs) when not
   *  `uncropped`; otherwise every layer projected into source space. */
  layers: BundleLayerNode[];
}

/** Resolve how a layer tree should render given the crop's visibility.
 *
 *  When the lone crop layer is visible (or absent), this is the identity:
 *  render at the stored canvas dims with the stored layers — byte-for-byte
 *  the existing behavior, so every already-cropped capture is unaffected.
 *
 *  When the crop layer is HIDDEN, it returns the full-source canvas dims
 *  and a layer tree re-projected into source space (overlays inverse-
 *  cropped, raster un-translated) — the "show the whole image" view. The
 *  projection is pure and reads only stored coords, so flipping the crop's
 *  `visible` flag back and forth is perfectly stable; nothing is ever
 *  re-normalized into storage, so annotations never drift. */
export function resolveCropViewport(args: {
  layers: readonly BundleLayerNode[];
  canvasWidthPx: number;
  canvasHeightPx: number;
}): CropViewport {
  const { layers, canvasWidthPx, canvasHeightPx } = args;
  const identity: CropViewport = {
    uncropped: false,
    widthPx: canvasWidthPx,
    heightPx: canvasHeightPx,
    rect: null,
    layers: layers.slice()
  };

  const cropLayer = layers.find(isCropVectorLayer);
  // Crop absent, or present-and-visible → nothing to reveal.
  if (cropLayer === undefined || cropLayer.visible !== false) return identity;

  const raster = layers.find(
    (l): l is Extract<BundleLayerNode, { kind: "raster" }> => l.kind === "raster"
  );
  if (raster === undefined) return identity;

  const naturalW = raster.natural_width_px;
  const naturalH = raster.natural_height_px;
  const rect = cropRectFromCanvas({
    canvasWidthPx,
    canvasHeightPx,
    sourceWidthPx: naturalW,
    sourceHeightPx: naturalH,
    rasterTranslateXPx: raster.transform[4],
    rasterTranslateYPx: raster.transform[5]
  });
  if (rect === null || rect.w <= 0 || rect.h <= 0) return identity;
  const inv = inverseCropRect(rect);
  if (inv === null) return identity;

  return {
    uncropped: true,
    widthPx: naturalW,
    heightPx: naturalH,
    rect,
    layers: layers.map((l) => projectLayerToSource(l, rect, naturalW, naturalH, inv))
  };
}
