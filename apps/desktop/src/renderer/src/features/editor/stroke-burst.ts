// Draw bursts: a stroke drawn right after the last one, in the same
// style, joins that stroke's layer as another segment. Writing a word is
// a dozen strokes; it should be one layer in the Layers panel, not a
// dozen. Each stroke is still its own undo step (the editor writes the
// join as a `replace`), and every segment still paints on its own, so a
// burst looks exactly like the separate strokes it is made of.

import { MAX_STROKE_POINTS, type OverlayRow, type StrokeOverlay } from "@pwrsnap/shared";

/** How long after one stroke ends the next may start and still join it.
 *  Long enough for the gaps inside handwriting; a pause to think starts
 *  a new layer. */
export const STROKE_BURST_GAP_MS = 1500;

/**
 * The stroke a new one may join as another segment: `lastId`, the layer
 * the previous stroke landed in, if it is still the TOP layer and a
 * stroke drawn with the same tool, color and weight (and no opacity
 * override), with room for the new points. Anything drawn, pasted or
 * restacked on top since breaks the burst — the new stroke would
 * otherwise land beneath it. Naming the layer, not just "the top
 * stroke", keeps a stroke drawn right after an ⌘Z from joining an older
 * stroke that the undo left on top.
 */
export function burstTarget(
  rows: readonly OverlayRow[],
  rasters: readonly { readonly z_index: number }[],
  stroke: StrokeOverlay,
  lastId: string
): { id: string; data: StrokeOverlay } | null {
  let top: OverlayRow | null = null;
  for (const row of rows) {
    if (top === null || row.z_index > top.z_index) top = row;
  }
  if (top === null || top.id !== lastId) return null;
  // A pasted image is a layer too, outside the overlay rows.
  if (rasters.some((raster) => raster.z_index > top.z_index)) return null;
  const data = top.data;
  if (
    data.kind !== "stroke" ||
    data.tool !== stroke.tool ||
    data.color !== stroke.color ||
    (data.thickness ?? "auto") !== (stroke.thickness ?? "auto") ||
    data.opacity !== undefined ||
    data.points.length + stroke.points.length > MAX_STROKE_POINTS
  ) {
    return null;
  }
  return { id: top.id, data };
}
