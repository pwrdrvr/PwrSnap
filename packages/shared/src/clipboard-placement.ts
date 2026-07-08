// Cross-capture paste placement math — the single source of truth for
// how a copied layer block is dropped into a DIFFERENTLY-SIZED target
// capture so the image + its annotations land as a COHERENT UNIT.
//
// The clipboard fragment carries layer coords normalized against the
// SOURCE capture's canvas frame (the cropped image as the user saw it,
// because copy bakes the base raster's visible region — see
// clipboard-handlers.ts `copyLayerFragment`). Pasting those coords
// verbatim into a bigger/smaller canvas misplaces the raster (it's an
// absolute-pixel transform) while annotations (normalized [0,1]) drift
// relative to it. This module computes ONE placement rect — scale-to-fit
// the source frame into the target, preserving aspect, centered, never
// upscaling past native — and remaps every layer through it so the whole
// block stays internally consistent.
//
// Pure (no Node APIs): @pwrsnap/shared runs in the renderer too. Both the
// paste handler (main) and any future renderer-side preview can call it.
//
// IDENTITY GUARANTEE: when the source frame equals the target canvas
// (copy-within-capture, or A and B with identical dims), the placement is
// scale 1 / origin (0,0) and every remap is a no-op — same-size paste
// lands 1:1, exactly as before this module existed.

import type { BundleLayerNode } from "./bundle-manifest-schema-v2";
import { inverseCropRect, inverseTransformOverlayByCrop } from "./crop-viewport";

/** A canvas frame in pixels — either the copied block's source frame or
 *  the paste target's canvas. */
export interface PlacementFrame {
  widthPx: number;
  heightPx: number;
}

/** The resolved placement of a source frame inside a target canvas:
 *  a uniform scale plus the top-left origin of the placed rect, both in
 *  TARGET canvas pixels. */
export interface LayerPlacement {
  /** Uniform scale applied to the source frame. ≤ 1 (never upscales past
   *  native size). */
  scale: number;
  /** Top-left of the placed rect in target canvas pixels (the centering
   *  offset). */
  originXPx: number;
  originYPx: number;
  /** The placed rect's size in target canvas pixels (`source × scale`). */
  targetWidthPx: number;
  targetHeightPx: number;
}

/** Scale-to-fit `source` into `target`, preserving aspect ratio and
 *  centering. Caps scale at 1 so a smaller source lands at NATIVE size
 *  (centered) rather than being blown up to fill. A source larger than
 *  the target shrinks to fit. Degenerate (non-positive) dims fall back to
 *  the identity placement.
 *
 *  Same dims in/out → `{ scale: 1, origin (0,0) }` exactly (the identity
 *  case that keeps same-size paste 1:1). */
export function computePlacement(
  source: PlacementFrame,
  target: PlacementFrame
): LayerPlacement {
  const sw = source.widthPx;
  const sh = source.heightPx;
  const tw = target.widthPx;
  const th = target.heightPx;
  if (sw <= 0 || sh <= 0 || tw <= 0 || th <= 0) {
    return {
      scale: 1,
      originXPx: 0,
      originYPx: 0,
      targetWidthPx: tw,
      targetHeightPx: th
    };
  }
  const scale = Math.min(1, tw / sw, th / sh);
  const targetWidthPx = sw * scale;
  const targetHeightPx = sh * scale;
  return {
    scale,
    originXPx: (tw - targetWidthPx) / 2,
    originYPx: (th - targetHeightPx) / 2,
    targetWidthPx,
    targetHeightPx
  };
}

/** Remap ONE layer from the source frame's coordinate space into the
 *  target canvas, per `placement`. The block-level transform is the
 *  affine `p_target = origin + scale · p_source`:
 *
 *  • raster — fold `scale` into the affine matrix and offset the
 *    translate by the placement origin. `natural_*_px` is unchanged (it's
 *    the layer's own pixel size; the matrix carries the placement scale).
 *  • vector — coords are normalized [0,1] of the SOURCE frame; remap them
 *    into the placement rect within the TARGET's [0,1] space. Reuses the
 *    crop projection (`inverseTransformOverlayByCrop` of the inverse of
 *    the placement rect) so every shape kind maps exactly as the crop
 *    path does. The crop marker (returns null) is left untouched.
 *  • effect — `clip_rect` is in absolute canvas pixels; scale + offset it
 *    like the raster translate.
 *  • group — no spatial surface in v2.0; unchanged.
 *
 *  Identity placement (scale 1, origin 0, target === source frame) returns
 *  spatially-identical coords. */
export function placeLayerIntoTarget(
  layer: BundleLayerNode,
  placement: LayerPlacement,
  target: PlacementFrame
): BundleLayerNode {
  const { scale, originXPx, originYPx } = placement;
  switch (layer.kind) {
    case "raster": {
      const placedTransform: [number, number, number, number, number, number] = [
        layer.transform[0] * scale,
        layer.transform[1] * scale,
        layer.transform[2] * scale,
        layer.transform[3] * scale,
        originXPx + layer.transform[4] * scale,
        originYPx + layer.transform[5] * scale
      ];
      // A pasted raster's "home" (for the Layers-panel Reset) is where it
      // lands in THIS document — overwrite any source-doc home it carried.
      return { ...layer, transform: placedTransform, original_transform: placedTransform };
    }
    case "vector": {
      if (layer.shape.kind === "crop") return layer;
      // The placement rect expressed in the TARGET canvas's normalized
      // [0,1] space. Feeding its inverse to the crop projector maps a
      // source-normalized coord `n → origin_n + n·size_n`.
      if (target.widthPx <= 0 || target.heightPx <= 0) return layer;
      const placedRectNorm = {
        x: originXPx / target.widthPx,
        y: originYPx / target.heightPx,
        w: placement.targetWidthPx / target.widthPx,
        h: placement.targetHeightPx / target.heightPx
      };
      const inv = inverseCropRect(placedRectNorm);
      if (inv === null) return layer;
      const shape = inverseTransformOverlayByCrop(layer.shape, inv);
      return shape === null ? layer : { ...layer, shape };
    }
    case "effect": {
      if (layer.clip_rect === null) return layer;
      return {
        ...layer,
        clip_rect: {
          x: originXPx + layer.clip_rect.x * scale,
          y: originYPx + layer.clip_rect.y * scale,
          w: layer.clip_rect.w * scale,
          h: layer.clip_rect.h * scale
        }
      };
    }
    case "group":
      return layer;
  }
}
