// Layer-tree role classification — the single source of truth for which
// layers are reorderable annotations vs pinned "base" layers. Shared by
// the editor's reorder dispatch (Editor.tsx `moveLayerToIndex`) and the
// Library Layers panel (pinning + drag/keyboard gating) so the two can
// never drift: a move the panel offers must be a move the editor honors.
//
// Multi-raster note: a v2 capture starts with one "Source" raster, but
// the editor can hold MORE rasters — pasted images and the captured
// cursor. Only the Source is a pinned base layer; every other raster is
// a normal annotation (reorderable, hideable, deletable). So the base /
// reorderable predicates are parameterized by the Source raster's id,
// resolved once per render via `selectBaseRaster` (base-raster.ts) —
// the single sha-matched "which raster is on screen" helper.

import type { BundleLayerNode } from "@pwrsnap/shared";

/** A crop layer — a VectorLayer carrying the `crop` shape (a no-op
 *  composite; the canvas-dim shrink is what actually clips). */
export function isCropLayer(node: BundleLayerNode): boolean {
  return node.kind === "vector" && node.shape.kind === "crop";
}

/** True only for the base Source raster — pass the id resolved by
 *  `selectBaseRaster(layers, record.sha256)?.id`.
 *  Non-source rasters return false — they're ordinary annotations. */
export function isSourceRaster(
  node: BundleLayerNode,
  sourceRasterId: string | null
): boolean {
  return node.kind === "raster" && node.id === sourceRasterId;
}

/** "Base" layers — the Source raster and the Crop viewport — have no
 *  meaningful stacking position: the Source always composites FIRST
 *  (every annotation paints on top of it) and crop is a no-op viewport.
 *  They're pinned at the bottom of the Layers panel and aren't
 *  reorderable; an annotation can never move "below" them (it would
 *  change the list order but not the actual render — a no-op). A pasted
 *  image or the captured cursor is NOT base, even though it's a raster. */
export function isBaseLayer(
  node: BundleLayerNode,
  sourceRasterId: string | null
): boolean {
  return isSourceRaster(node, sourceRasterId) || isCropLayer(node);
}

/** A reorderable annotation — anything that isn't a base layer or the
 *  synthesized root group: vector annotations (except crop), effect
 *  layers (blur / highlight), and non-source rasters (pasted images,
 *  the captured cursor). The complement of `isBaseLayer` over the
 *  user-facing layers, defined here so the editor's reorder basis and
 *  the panel's pinning stay in lockstep. */
export function isReorderableLayer(
  node: BundleLayerNode,
  sourceRasterId: string | null
): boolean {
  return node.kind !== "group" && !isBaseLayer(node, sourceRasterId);
}
