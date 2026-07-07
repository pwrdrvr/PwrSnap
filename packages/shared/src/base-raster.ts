import type { BundleLayerNode, RasterLayer } from "./bundle-manifest-schema-v2";

/**
 * Pick the BASE SOURCE raster: the embedded raster whose sha256 matches
 * the capture record — the one the `pwrsnap-capture://` protocol serves
 * and every annotation paints over.
 *
 * A capture can carry MORE than one raster (pasted images, the captured
 * cursor), so "first raster in tree order" isn't necessarily the base.
 * Matching by sha keeps the editor's `<img>`, the crop projection, and
 * the compositor all describing the same layer. Falls back to the first
 * eligible raster when nothing matches — defensive, and for the common
 * single-raster capture the first raster IS the sha-matched source, so
 * behavior is identical there.
 *
 * Only rasters parented under a group are eligible (`parent_id !== null`),
 * matching the editor's source-layer scan — a root-level raster isn't a
 * layer-tree source.
 *
 * Lives in shared because BOTH sides need the same answer: the renderer
 * (editor `<img>` / Layers panel pinning / hit-test) and main (crop
 * projection inside resolveCropViewport, used by the compositor and the
 * paste placement). Two implementations would eventually disagree about
 * which raster is "the image".
 */
export function selectBaseRaster(
  layers: readonly BundleLayerNode[],
  sourceSha256: string
): RasterLayer | undefined {
  let firstRaster: RasterLayer | undefined;
  for (const layer of layers) {
    if (layer.kind === "raster" && layer.parent_id !== null) {
      firstRaster ??= layer;
      if (
        layer.source_ref.kind === "embedded" &&
        layer.source_ref.sha256 === sourceSha256
      ) {
        return layer;
      }
    }
  }
  return firstRaster;
}
