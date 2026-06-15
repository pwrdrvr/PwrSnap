import type { RenderPreset, ExportStrategy } from "@pwrsnap/shared";
import type { CaptureRecord, BundleLayerNode } from "@pwrsnap/shared";
import { resolveExportRung } from "@pwrsnap/shared";
import { stat } from "node:fs/promises";
import { renderViaCoordinator } from "./coordinator";
import { listLayerTree } from "../persistence/layers-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";

/** Resolve a preset to its output pixel width under the active export
 *  strategy. Delegates to the shared ladder (the one place that owns the
 *  legacy 800/1440/source mapping AND the DPI-aware scale ladders) so the
 *  renderer's copy-card labels and this render path can never drift.
 *  `strategy` defaults to `legacy` for callers that haven't threaded the
 *  setting through yet. */
export function targetWidthForImagePreset(
  preset: RenderPreset,
  record: Pick<CaptureRecord, "width_px" | "height_px" | "device_pixel_ratio">,
  strategy: ExportStrategy = "legacy"
): number {
  const rung = resolveExportRung(
    {
      widthPx: record.width_px,
      heightPx: record.height_px,
      devicePixelRatio: record.device_pixel_ratio
    },
    strategy,
    preset
  );
  return rung?.widthPx ?? Math.max(1, record.width_px);
}

export type ImagePresetFile = {
  path: string;
  byteSize: number;
  fromCache: boolean;
  sourceReused: boolean;
};

export async function resolveImagePresetFile(
  record: CaptureRecord,
  preset: RenderPreset,
  strategy: ExportStrategy = "legacy"
): Promise<ImagePresetFile> {
  const targetWidth = targetWidthForImagePreset(preset, record, strategy);
  if (targetWidth === record.width_px && canReuseSourceImage(record)) {
    const path = await ensureEffectiveSrcPath(record);
    const stats = await stat(path);
    return {
      path,
      byteSize: stats.size,
      fromCache: true,
      sourceReused: true
    };
  }

  const result = await renderViaCoordinator({
    captureId: record.id,
    srcPath: await ensureEffectiveSrcPath(record),
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    width: targetWidth,
    format: "png"
  });
  return {
    path: result.cachePath,
    byteSize: result.byteSize,
    fromCache: result.fromCache,
    sourceReused: false
  };
}

function canReuseSourceImage(record: CaptureRecord): boolean {
  if (record.kind !== "image") return false;
  const layers = listLayerTree(record.id);
  const rasterLayers = layers.filter((layer) => layer.kind === "raster");
  if (rasterLayers.length !== 1) return false;
  const raster = rasterLayers[0];
  if (raster === undefined) return false;
  if (!isDefaultVisibleLayer(raster)) return false;
  if (raster.source_ref.kind !== "embedded" || raster.source_ref.sha256 !== record.sha256) {
    return false;
  }
  if (raster.natural_width_px !== record.width_px || raster.natural_height_px !== record.height_px) {
    return false;
  }

  return layers.every((layer) => {
    if (layer.kind === "raster") return layer.id === raster.id;
    if (layer.kind === "group") return isDefaultVisibleLayer(layer);
    return false;
  });
}

function isDefaultVisibleLayer(layer: BundleLayerNode): boolean {
  return (
    layer.visible &&
    layer.opacity === 1 &&
    layer.blend_mode === "normal" &&
    layer.transform[0] === 1 &&
    layer.transform[1] === 0 &&
    layer.transform[2] === 0 &&
    layer.transform[3] === 1 &&
    layer.transform[4] === 0 &&
    layer.transform[5] === 0
  );
}
