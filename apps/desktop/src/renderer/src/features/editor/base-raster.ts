import type { BundleLayerNode, RasterLayer } from "@pwrsnap/shared";

/**
 * Pick the raster the editor renders as its single `<img>`: the base
 * SOURCE the `pwrsnap-capture://` protocol serves — the embedded raster
 * whose sha256 matches the capture record.
 *
 * A capture can carry MORE than one raster (the compositor layers them in
 * the bake), so "first raster in tree order" isn't necessarily the one on
 * screen. Matching by sha keeps the editor's `<img>` dims / translate /
 * source-hidden flag describing the layer actually shown. Falls back to
 * the first eligible raster when nothing matches — defensive, and for the
 * common single-raster capture the first raster IS the sha-matched source,
 * so behavior is identical there.
 *
 * Only rasters parented under a group are eligible (`parent_id !== null`),
 * matching the editor's existing source-layer scan — a root-level raster
 * isn't a layer-tree source.
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
