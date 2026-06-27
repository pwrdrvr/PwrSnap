// Layer-tree role classification — the single source of truth for which
// layers are reorderable annotations vs pinned "base" layers. Shared by
// the editor's reorder dispatch (Editor.tsx `moveLayerToIndex`) and the
// Library Layers panel (pinning + drag/keyboard gating) so the two can
// never drift: a move the panel offers must be a move the editor honors.

import type { BundleLayerNode } from "@pwrsnap/shared";

/** A crop layer — a VectorLayer carrying the `crop` shape (a no-op
 *  composite; the canvas-dim shrink is what actually clips). */
export function isCropLayer(node: BundleLayerNode): boolean {
  return node.kind === "vector" && node.shape.kind === "crop";
}

/** "Base" layers — the Source raster and the Crop viewport — have no
 *  meaningful stacking position: the raster always composites FIRST
 *  (every annotation paints on top of it) and crop is a no-op viewport.
 *  They're pinned at the bottom of the Layers panel and aren't
 *  reorderable; an annotation can never move "below" them (it would
 *  change the list order but not the actual render — a no-op). */
export function isBaseLayer(node: BundleLayerNode): boolean {
  return node.kind === "raster" || isCropLayer(node);
}

/** A reorderable annotation — anything that isn't a base layer or the
 *  synthesized root group: vector annotations (except crop) and effect
 *  layers (blur / highlight). The complement of `isBaseLayer` over the
 *  user-facing layers, defined here so the editor's reorder basis and
 *  the panel's pinning stay in lockstep. */
export function isReorderableLayer(node: BundleLayerNode): boolean {
  return node.kind !== "group" && !isBaseLayer(node);
}
