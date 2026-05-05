// Sharp-based render pipeline with overlay bake. Composes applied
// overlays onto the source image, then resizes + encodes at the
// target width/format, atomically writing the result to disk.
//
// Pipeline shape (per Phase 2 plan §"Render bake"):
//
//   sharp(srcPath)
//     .composite([overlaySvgs])     ← arrows, rects, text, blur, etc.
//     .resize(width)
//     .png() | .webp()
//
// Compositing happens at SOURCE resolution then resizes to the
// target. This preserves the overlays' relationship to the image
// (e.g. an arrow's stroke-by-image-short-side stays correct), and
// libvips fuses the demand-driven graph into a single pass —
// chaining .toBuffer() between hops would force materialization
// at each step.
//
// Cache key is the `render_inputs_hash` over (format, width,
// applied overlays canonical form), so the cache stays honest
// across overlay edits without manually invalidating files. The
// coordinator computes the same hash and looks up by it.

import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { OverlayRow } from "@pwrsnap/shared";
import { computeArrowGeometry } from "@pwrsnap/shared";
import { getCacheRoot } from "../persistence/db";
import { listLiveOverlays } from "../persistence/overlays-repo";
import { getMainLogger } from "../log";
import { computeRenderHash } from "./overlay-hash";

const log = getMainLogger("pwrsnap:render");

export type RenderRequest = {
  captureId: string;
  srcPath: string;
  /** Source image dimensions in pixels. Required to compute smart-
   *  arrow geometry + render SVG overlay buffers at source-pixel
   *  resolution. */
  imageWidthPx: number;
  imageHeightPx: number;
  /** Target width in pixels. Source-equal width = no resize. */
  width: number;
  format: "png" | "webp";
};

export type RenderResult = {
  cachePath: string;
  byteSize: number;
  fromCache: boolean;
  /** The render-inputs hash this result was keyed by. */
  renderHash: string;
  /** Number of overlays composited into this output. 0 = pure
   *  resize/encode of the source. */
  overlayCount: number;
};

/**
 * Compose-on-demand. Idempotent; concurrent calls for the same
 * (captureId, hash, format) coalesce via the RenderCoordinator
 * (see ./coordinator.ts).
 */
export async function compose(req: RenderRequest): Promise<RenderResult> {
  // Pull applied overlays in z-order. listLiveOverlays already
  // filters applied_at IS NOT NULL AND rejected_at IS NULL AND
  // superseded_by IS NULL.
  const overlays = listLiveOverlays(req.captureId);

  const renderHash = computeRenderHash({
    format: req.format,
    width: req.width,
    appliedOverlays: overlays
  });

  const cacheDir = join(getCacheRoot(), req.captureId);
  const fileName = `${renderHash}.${req.format}`;
  const cachePath = join(cacheDir, fileName);

  if (existsSync(cachePath)) {
    const stats = await stat(cachePath);
    return {
      cachePath,
      byteSize: stats.size,
      fromCache: true,
      renderHash,
      overlayCount: overlays.length
    };
  }

  await mkdir(cacheDir, { recursive: true });

  // Build composite layers. Each entry is an SVG buffer at SOURCE
  // pixel resolution; sharp paints them on top of the base image
  // before the resize. Overlay kinds the bake doesn't yet support
  // (rect/text/highlight/blur/step in this slice) drop out — they
  // arrive in Slice B.
  const compositeLayers: sharp.OverlayOptions[] = [];
  for (const row of overlays) {
    const layer = buildCompositeLayer(row, req.imageWidthPx, req.imageHeightPx);
    if (layer !== null) compositeLayers.push(layer);
  }

  let pipeline = sharp(req.srcPath);
  if (compositeLayers.length > 0) {
    pipeline = pipeline.composite(compositeLayers);
  }
  pipeline = pipeline.resize({ width: req.width, withoutEnlargement: true });

  const buf =
    req.format === "png"
      ? await pipeline.png({ compressionLevel: 6, effort: 4 }).toBuffer()
      : await pipeline.webp({ lossless: true, effort: 4 }).toBuffer();

  // Atomic write — tmp + rename so concurrent readers never see a
  // half-written file. PID in the tmp name lets two render workers
  // coexist on the same key (the coordinator already coalesces
  // in-process; this guards against a future multi-process world).
  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, buf);
  await rename(tmpPath, cachePath);

  log.info("rendered", {
    captureId: req.captureId,
    width: req.width,
    format: req.format,
    byteSize: buf.length,
    overlayCount: overlays.length,
    composited: compositeLayers.length,
    renderHash
  });

  return {
    cachePath,
    byteSize: buf.length,
    fromCache: false,
    renderHash,
    overlayCount: overlays.length
  };
}

/**
 * Convert a single overlay row to a sharp composite layer. Returns
 * null when the overlay kind isn't yet supported by the bake. Slice
 * A ships arrow only; rect/text/highlight/blur land in Slice B.
 */
function buildCompositeLayer(
  row: OverlayRow,
  imageWidthPx: number,
  imageHeightPx: number
): sharp.OverlayOptions | null {
  const data = row.data;
  switch (data.kind) {
    case "arrow":
      return arrowLayer(data, imageWidthPx, imageHeightPx);
    case "rect":
    case "text":
    case "highlight":
    case "blur":
    case "step":
    case "crop":
      return null;
    default:
      return null;
  }
}

function arrowLayer(
  data: Extract<OverlayRow["data"], { kind: "arrow" }>,
  imageWidthPx: number,
  imageHeightPx: number
): sharp.OverlayOptions {
  const geom = computeArrowGeometry({
    from: data.from,
    to: data.to,
    imageWidthPx,
    imageHeightPx
  });

  const fromPx = pxOf(geom.from, imageWidthPx, imageHeightPx);
  const baseCenterPx = pxOf(geom.baseCenter, imageWidthPx, imageHeightPx);
  const toPx = pxOf(geom.to, imageWidthPx, imageHeightPx);
  const baseLeftPx = pxOf(geom.baseLeft, imageWidthPx, imageHeightPx);
  const baseRightPx = pxOf(geom.baseRight, imageWidthPx, imageHeightPx);

  const fillColor = data.color === "auto" ? "#e8743a" : data.color;
  // White outline always drawn (per plan §"Smart arrow algorithm"):
  // legibility on busy images. The outline is a slightly thicker
  // pass underneath the accent.
  const outlineWidth = Math.max(1.5, geom.strokeWidthPx * 0.25);

  const headPolygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linecap="round" stroke-linejoin="round">
    <line x1="${fromPx.x}" y1="${fromPx.y}" x2="${baseCenterPx.x}" y2="${baseCenterPx.y}"
          stroke="white" stroke-width="${geom.strokeWidthPx + outlineWidth * 2}" fill="none" />
    <polygon points="${headPolygon}"
             fill="white" stroke="white" stroke-width="${outlineWidth * 2}" />
    <line x1="${fromPx.x}" y1="${fromPx.y}" x2="${baseCenterPx.x}" y2="${baseCenterPx.y}"
          stroke="${fillColor}" stroke-width="${geom.strokeWidthPx}" fill="none" />
    <polygon points="${headPolygon}" fill="${fillColor}" />
  </g>
</svg>`;

  return {
    input: Buffer.from(svg),
    top: 0,
    left: 0
  };
}

function pxOf(
  pt: { x: number; y: number },
  imageWidthPx: number,
  imageHeightPx: number
): { x: number; y: number } {
  return { x: pt.x * imageWidthPx, y: pt.y * imageHeightPx };
}
