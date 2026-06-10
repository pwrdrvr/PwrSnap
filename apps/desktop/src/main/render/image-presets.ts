import type { RenderPreset } from "@pwrsnap/shared";
import type { CaptureRecord, BundleLayerNode } from "@pwrsnap/shared";
import { stat } from "node:fs/promises";
import { renderViaCoordinator } from "./coordinator";
import { listLayerTree } from "../persistence/layers-repo";
import { ensureEffectiveSrcPath } from "../persistence/source-store";

export const IMAGE_PRESET_WIDTHS = {
  low: 800,
  med: 1440,
  high: 0
} as const satisfies Record<RenderPreset, number>;

export function targetWidthForImagePreset(
  preset: RenderPreset,
  sourceWidthPx: number
): number {
  const sourceWidth = Math.max(1, sourceWidthPx);
  const presetWidth = IMAGE_PRESET_WIDTHS[preset];
  if (presetWidth === 0) return sourceWidth;
  return Math.min(sourceWidth, presetWidth);
}

export type ImagePresetFile = {
  path: string;
  byteSize: number;
  fromCache: boolean;
  sourceReused: boolean;
};

export async function resolveImagePresetFile(
  record: CaptureRecord,
  preset: RenderPreset
): Promise<ImagePresetFile> {
  const targetWidth = targetWidthForImagePreset(preset, record.width_px);
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
