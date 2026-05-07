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
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { OverlayRow } from "@pwrsnap/shared";
import { computeArrowGeometry } from "@pwrsnap/shared";
import { getCacheRoot } from "../persistence/paths";
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

  // Read the source's ACTUAL pixel dimensions via sharp.metadata
  // rather than trusting `req.imageWidthPx`/`imageHeightPx` from
  // the DB. These should match (source-store.ts populates the DB
  // from sharp.metadata at insert time), BUT a few things can
  // make them drift:
  //   • PNGs with `pHYs` density chunks can be re-read at scaled
  //     dimensions on certain sharp/libvips versions.
  //   • A migration that updated the row without re-probing the
  //     file could go stale.
  //   • A future re-encode would change the file without bumping
  //     the row.
  // Since the composite layers MUST match the base's dimensions
  // (sharp throws "Image to composite must have same dimensions or
  // smaller" otherwise), reading the truth from sharp at this
  // exact moment is the only safe input.
  const srcMeta = await sharp(req.srcPath).metadata();
  const srcWidthPx = srcMeta.width;
  const srcHeightPx = srcMeta.height;
  if (srcWidthPx === undefined || srcHeightPx === undefined) {
    throw new Error(`compose: sharp.metadata produced no dimensions for ${req.srcPath}`);
  }

  // Build composite layers. Each entry is either an SVG buffer at
  // source pixel resolution OR (for blur overlays) a pre-blurred
  // raster buffer extracted from the source. Sharp paints them on
  // top of the base image before the resize.
  //
  // Blur overlays use mask-style blur per region — we extract the
  // rect from the source, blur it, and composite back at the same
  // top/left. This is ~30× cheaper than full-source blur + mask
  // (per the plan §"Render bake") and produces the right behavior
  // when multiple non-overlapping blur regions are stacked.
  const compositeLayers: sharp.OverlayOptions[] = [];
  for (const row of overlays) {
    const layers = await buildCompositeLayers(row, req.srcPath, srcWidthPx, srcHeightPx);
    for (const layer of layers) {
      compositeLayers.push(layer);
    }
  }

  // CRITICAL: sharp's pipeline applies operations in a specific
  // ORDER, NOT in method-chain order. Per sharp docs, composite
  // happens AFTER resize/extract/etc. So writing
  //   sharp(src).composite(layers).resize(140)
  // actually executes:
  //   1. read source (3710×1892)
  //   2. resize to 140 wide → ~71×36
  //   3. composite 3710×1892 layers onto 71×36 → throws
  //      "Image to composite must have same dimensions or smaller"
  //
  // The fix is to materialize the composite at SOURCE resolution
  // first (one sharp pass), then resize the composited buffer in a
  // second sharp pass. The two-pass cost is ~5-10ms — acceptable;
  // the cache file is reused across all subsequent reads.
  //
  // The intermediate format is raw RGBA so we don't pay PNG/WEBP
  // encode/decode round-trip cost between passes.
  let bufForResize: Buffer;
  let intermediateRaw: sharp.CreateRaw | null = null;
  if (compositeLayers.length > 0) {
    bufForResize = await sharp(req.srcPath)
      .composite(compositeLayers)
      .ensureAlpha()
      .raw()
      .toBuffer();
    intermediateRaw = { width: srcWidthPx, height: srcHeightPx, channels: 4 };
  } else {
    // No overlays — skip the materialize step; sharp can resize
    // straight from disk in one pass.
    bufForResize = await readFile(req.srcPath);
  }

  const resizePipeline =
    intermediateRaw !== null
      ? sharp(bufForResize, { raw: intermediateRaw })
      : sharp(bufForResize);
  const sized = resizePipeline.resize({
    width: req.width,
    withoutEnlargement: true
  });

  const buf =
    req.format === "png"
      ? await sized.png({ compressionLevel: 6, effort: 4 }).toBuffer()
      : await sized.webp({ lossless: true, effort: 4 }).toBuffer();

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
 * Convert a single overlay row into one or more sharp composite
 * layers. Most overlay kinds produce exactly one SVG-buffer layer;
 * `blur` produces one raster-buffer layer (the pre-blurred extract).
 * Future kinds (step, crop) land in their own slices.
 *
 * IMPORTANT: SVG layers are pre-rasterized to exactly
 * `imageWidthPx × imageHeightPx` pixels. Without this, sharp's resvg
 * may render the SVG at a slightly different size due to its
 * default DPI multiplier (72 vs 96, depending on platform/version)
 * and `composite` rejects layers larger than the base image with
 * "Image to composite must have same dimensions or smaller". The
 * raster pre-step forces exact dimensions before composite.
 */
async function buildCompositeLayers(
  row: OverlayRow,
  srcPath: string,
  imageWidthPx: number,
  imageHeightPx: number
): Promise<sharp.OverlayOptions[]> {
  const data = row.data;
  switch (data.kind) {
    case "arrow":
      return [await rasterize(arrowSvg(data, imageWidthPx, imageHeightPx), imageWidthPx, imageHeightPx)];
    case "rect":
      return [await rasterize(rectSvg(data, imageWidthPx, imageHeightPx), imageWidthPx, imageHeightPx)];
    case "highlight":
      return [
        await rasterize(highlightSvg(data, imageWidthPx, imageHeightPx), imageWidthPx, imageHeightPx)
      ];
    case "text":
      return [await rasterize(textSvg(data, imageWidthPx, imageHeightPx), imageWidthPx, imageHeightPx)];
    case "blur": {
      const layer = await blurLayer(data, srcPath, imageWidthPx, imageHeightPx);
      return layer === null ? [] : [layer];
    }
    case "step":
    case "crop":
      return [];
    default:
      return [];
  }
}

/**
 * Render an SVG string to a RAW RGBA buffer of exactly
 * `width × height` pixels, returned as a sharp composite layer with
 * explicit dimensions.
 *
 * Why raw RGBA + explicit `raw: { width, height, channels: 4 }`:
 * sharp's PNG re-encode path can introduce dimension ambiguity (the
 * PNG metadata + resvg DPI multiplier interaction). Raw buffers
 * carry no metadata — sharp uses ONLY the dimensions we tell it.
 * That's the only way to guarantee the composite layer is byte-for-
 * byte the exact size of the base image, eliminating the
 * "Image to composite must have same dimensions or smaller" error
 * once and for all.
 *
 * `density: 72` on the SVG read forces resvg to interpret the SVG's
 * `width="N"` as N pixels (1 user unit = 1 pixel) — matches our
 * SVG generation which uses pixel-space coords. Without this, resvg
 * may apply a default 96 DPI multiplier and emit a 1.33× bigger
 * raster.
 */
async function rasterize(svg: string, width: number, height: number): Promise<sharp.OverlayOptions> {
  const raw = await sharp(Buffer.from(svg), { density: 72 })
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return {
    input: raw,
    raw: { width, height, channels: 4 },
    top: 0,
    left: 0
  };
}

function arrowSvg(
  data: Extract<OverlayRow["data"], { kind: "arrow" }>,
  imageWidthPx: number,
  imageHeightPx: number
): string {
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
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
}

function pxOf(
  pt: { x: number; y: number },
  imageWidthPx: number,
  imageHeightPx: number
): { x: number; y: number } {
  return { x: pt.x * imageWidthPx, y: pt.y * imageHeightPx };
}

/* ----------------------------- Rect ----------------------------- */

function rectSvg(
  data: Extract<OverlayRow["data"], { kind: "rect" }>,
  imageWidthPx: number,
  imageHeightPx: number
): string {
  const xPx = data.rect.x * imageWidthPx;
  const yPx = data.rect.y * imageHeightPx;
  const wPx = data.rect.w * imageWidthPx;
  const hPx = data.rect.h * imageHeightPx;
  const shortSidePx = Math.min(imageWidthPx, imageHeightPx);
  const strokeWidthPx = clamp(shortSidePx / 220, 4, 14);
  const outlinePx = Math.max(1.5, strokeWidthPx * 0.25);
  const fillColor = data.color === "auto" ? "#e8743a" : data.color;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round">
    <rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}"
          fill="none" stroke="white" stroke-width="${strokeWidthPx + outlinePx * 2}" />
    <rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}"
          fill="none" stroke="${fillColor}" stroke-width="${strokeWidthPx}" />
  </g>
</svg>`;
}

/* --------------------------- Highlight -------------------------- */

function highlightSvg(
  data: Extract<OverlayRow["data"], { kind: "highlight" }>,
  imageWidthPx: number,
  imageHeightPx: number
): string {
  const xPx = data.rect.x * imageWidthPx;
  const yPx = data.rect.y * imageHeightPx;
  const wPx = data.rect.w * imageWidthPx;
  const hPx = data.rect.h * imageHeightPx;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}" fill="rgba(255, 220, 80, 0.32)" />
</svg>`;
}

/* ----------------------------- Text ----------------------------- */

function textSvg(
  data: Extract<OverlayRow["data"], { kind: "text" }>,
  imageWidthPx: number,
  imageHeightPx: number
): string {
  const xPx = data.point.x * imageWidthPx;
  const yPx = data.point.y * imageHeightPx;
  const shortSidePx = Math.min(imageWidthPx, imageHeightPx);
  // Two sizes per the schema: small ≈ 1.7%, large ≈ 3.3% of short-side.
  const fontSizePx = data.size === "large" ? shortSidePx / 30 : shortSidePx / 60;
  const accent = data.color === "auto" ? "#e8743a" : data.color;
  // Black halo via paint-order. xml-escape the body so user input
  // can't break out of the SVG.
  const escaped = escapeXml(data.body);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <text x="${xPx}" y="${yPx}"
        font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSizePx}"
        font-weight="600"
        fill="${accent}"
        stroke="rgba(0,0,0,0.7)"
        stroke-width="${fontSizePx * 0.08}"
        paint-order="stroke"
        dominant-baseline="hanging">${escaped}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ----------------------------- Blur ----------------------------- */

async function blurLayer(
  data: Extract<OverlayRow["data"], { kind: "blur" }>,
  srcPath: string,
  imageWidthPx: number,
  imageHeightPx: number
): Promise<sharp.OverlayOptions | null> {
  // Mask-style blur: extract the rect from the source, blur it,
  // composite back at the same coords. Cheaper than blurring the
  // full source + masking because the blur kernel's cost is
  // O(width × height).
  const left = Math.round(data.rect.x * imageWidthPx);
  const top = Math.round(data.rect.y * imageHeightPx);
  const width = Math.round(data.rect.w * imageWidthPx);
  const height = Math.round(data.rect.h * imageHeightPx);
  if (width <= 0 || height <= 0) return null;

  // Clamp to the image bounds in case the rect crept past the edge
  // (renderer should clamp too, but defense in depth).
  const clamped = {
    left: Math.max(0, Math.min(imageWidthPx - 1, left)),
    top: Math.max(0, Math.min(imageHeightPx - 1, top)),
    width: Math.max(1, Math.min(imageWidthPx - left, width)),
    height: Math.max(1, Math.min(imageHeightPx - top, height))
  };

  // Sigma proportional to the rect's short side so the blur amount
  // looks similar regardless of the rect's size — a small blur on
  // a small region matches a large blur on a large region visually.
  // Cap at 60 to keep the kernel cost bounded.
  const rectShortSidePx = Math.min(clamped.width, clamped.height);
  const sigma = Math.min(60, Math.max(8, rectShortSidePx / 8));

  const buf = await sharp(srcPath).extract(clamped).blur(sigma).png().toBuffer();

  return {
    input: buf,
    top: clamped.top,
    left: clamped.left
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
