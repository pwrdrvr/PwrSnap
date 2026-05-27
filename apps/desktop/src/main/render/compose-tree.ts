// Tree-walking compositor for v2 bundles. Walks the layer tree
// (built from layers-repo.listLayerTree) and produces a flattened
// composite at canvas dimensions, then resizes + encodes once at the
// end. Mirrors v1 compose.ts's two-pass discipline (raw RGBA
// throughout; single PNG/WEBP encode at root) but extends it to:
//
//   • Multiple raster sources via RasterLayer.source_ref.sha256
//     — bytes extracted from the bundle's sources/<sha>.png with
//     sha256 content-integrity verify.
//   • Vector shapes (arrow / rect / text / highlight / step / crop)
//     reusing v1's SVG-rasterize discipline via Overlay schemas.
//   • Effect layers (blur / highlight) that sample-below from the
//     running accumulator — moving a layer beneath a blur causes the
//     blur to follow at composite time.
//   • Hierarchical groups via depth-first z-order traversal.
//
// Bounded memory + recursion: MAX_TREE_DEPTH from layers-repo guards
// against pathological trees. Raw-RGBA discipline keeps per-layer
// allocations to one buffer per node (no PNG encode/decode round
// trips between levels).

import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";

import type { BundleLayerNode, Overlay, OverlayRow } from "@pwrsnap/shared";

import { listLayerTree } from "../persistence/layers-repo";
import { readSourceFromBundle } from "../persistence/bundle-store";
import { getCacheRoot } from "../persistence/paths";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:compose-tree");

export type ComposeTreeRequest = {
  captureId: string;
  bundlePath: string;
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Target output width. Source-width = canvas-width = no resize. */
  width: number;
  format: "png" | "webp";
};

export type ComposeTreeResult = {
  cachePath: string;
  byteSize: number;
  fromCache: boolean;
  renderHash: string;
  layerCount: number;
};

/**
 * Top-level entry point. Reads the live layer tree for the capture,
 * walks it bottom-up (z-order) building a raw RGBA accumulator at
 * canvas dimensions, then resizes + encodes once at the end.
 * Cache file shape mirrors v1 compose.ts so existing pwrsnap-cache://
 * URLs work across both formats.
 */
export async function composeV2(req: ComposeTreeRequest): Promise<ComposeTreeResult> {
  const layers = listLayerTree(req.captureId);

  // Cache key incorporates the tree's content hash. Children-below
  // hash is naturally included because we hash the entire flattened
  // z-order — when a layer above changes z_index or transform, every
  // subsequent layer's rendered position shifts and the hash flips.
  // For contextual effects, hashing the FULL flattened order (not
  // just the effect's own params) means "move a layer beneath the
  // blur" correctly invalidates the cached blurred output.
  const renderHash = computeTreeRenderHash({
    layers,
    canvasWidthPx: req.canvasWidthPx,
    canvasHeightPx: req.canvasHeightPx,
    width: req.width,
    format: req.format
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
      layerCount: layers.length
    };
  }
  await mkdir(cacheDir, { recursive: true });

  // Render scale: when the requested output width is LARGER than the
  // canvas width (LOW / MED tiers on small captures), we upscale the
  // whole composite so every layer rasterizes at the output
  // resolution — crisp glyphs, visible halos, no blurry source-pixel-
  // then-lanczos-upscale chain. When the requested width is the same
  // or smaller (HIGH on small captures, or any tier on large
  // captures), scale stays at 1 and the final resize handles the
  // downscale at the end (same behavior as before).
  //
  // This is the load-bearing change for editor=baked-PNG WYSIWYG:
  // pre-fix, text glyphs at a 361×187 source rendered at 6.23 source
  // pixels tall regardless of LOW/MED tier — too small to show a
  // visible text-stroke halo, palette-quantized in the output. Post-
  // fix, LOW (req.width=800) renders the entire composite at scale
  // 800/361 ≈ 2.21× so glyphs are ~14 px tall in the PNG with full
  // RGBA antialiasing on the halo.
  const renderScale =
    req.width > req.canvasWidthPx ? req.width / req.canvasWidthPx : 1;
  const renderWidthPx = Math.max(1, Math.round(req.canvasWidthPx * renderScale));
  const renderHeightPx = Math.max(1, Math.round(req.canvasHeightPx * renderScale));

  const canvasInfo = {
    width: renderWidthPx,
    height: renderHeightPx,
    channels: 4 as const
  };

  // Start with a transparent canvas. sharp's `create` produces a raw
  // RGBA buffer when fed back through `.raw().toBuffer()`.
  let accumulator = await sharp({
    create: {
      width: renderWidthPx,
      height: renderHeightPx,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .ensureAlpha()
    .raw()
    .toBuffer();

  // Flatten the tree into z-order. Groups expand in-place at their
  // sibling position; v2.0 doesn't apply group-level transforms /
  // opacity (deferred — needs a separate accumulator per group).
  const flattened = flattenTreeInZOrder(layers);

  // SOURCE raster dims — captured once up-front so text vector layers
  // can derive fontSize from the source's shortSide rather than the
  // (cropped) canvas's. Matches the editor's commit `881cff0` behavior
  // for the bake. Picks the FIRST raster child of the root group; v2.0
  // ships with a single raster per capture, so this is unambiguous.
  // (Phase 5 paste-image flow with multiple rasters would revisit;
  // until then we treat the root raster as canonical.)
  let sourceWidthPx: number | undefined;
  let sourceHeightPx: number | undefined;
  for (const node of flattened) {
    if (node.kind === "raster") {
      sourceWidthPx = node.natural_width_px;
      sourceHeightPx = node.natural_height_px;
      break;
    }
  }

  for (const node of flattened) {
    accumulator = await renderNode(
      node,
      accumulator,
      canvasInfo,
      req,
      sourceWidthPx,
      sourceHeightPx,
      renderScale
    );
  }

  // Final pass: resize + encode. Single PNG encode at the very end,
  // not per-layer — preserves v1's two-pass discipline.
  //
  // Resize-kernel selection mirrors v1 compose.ts: when ANY blur
  // effect layer in the tree uses `style: "pixelate"`, the source-
  // resolution composite has crisp mosaic blocks baked in via
  // `kernel: "nearest"`. A subsequent lanczos3 downscale to library-
  // thumbnail width smooths those blocks back out (pixelate ends up
  // looking like a gaussian blur in the grid). Detect pixelate and
  // downgrade the downscale kernel to `nearest` so the blocks
  // survive intact.
  const hasPixelate = layers.some(
    (node) =>
      node.kind === "effect" &&
      node.effect.type === "blur" &&
      (node.effect.style ?? "gaussian") === "pixelate"
  );
  // Downscaling = accumulator is BIGGER than the requested output.
  // Post-scale-fix the accumulator dims = renderWidthPx × renderHeightPx,
  // so downscaling happens when req.width < renderWidthPx — which is
  // the case for large captures (renderScale=1, accumulator at canvas
  // dims, target smaller). For upscale tiers (scale > 1) the
  // accumulator already matches target → this resize is a no-op
  // (sharp short-circuits same-size resizes).
  //
  // withoutEnlargement was dropped because the upscale now happens
  // UPSTREAM (in the per-layer rasterization), not here. Leaving it
  // would prevent any rounding-correction at the very end.
  const downscaling = req.width < renderWidthPx;
  const sized = sharp(accumulator, { raw: canvasInfo }).resize({
    width: req.width,
    ...(hasPixelate && downscaling ? { kernel: "nearest" as const } : {})
  });
  // PNG: force palette: false so the encoder writes full RGBA (32-bit
  // truecolor + alpha) instead of an 8-bit colormap. Palette mode is
  // sharp's default for "simple" images and silently quantizes the
  // text-stroke halo's subpixel antialiasing — the halo turns
  // banded/lost. Editor renders at full RGBA; export should too.
  const outputBuf =
    req.format === "png"
      ? await sized
          .png({ compressionLevel: 6, effort: 4, palette: false })
          .toBuffer()
      : await sized.webp({ lossless: true, effort: 4 }).toBuffer();

  const tmpPath = `${cachePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, outputBuf);
  await rename(tmpPath, cachePath);

  log.info("rendered v2", {
    captureId: req.captureId,
    width: req.width,
    format: req.format,
    byteSize: outputBuf.length,
    layerCount: layers.length,
    renderHash
  });

  return {
    cachePath,
    byteSize: outputBuf.length,
    fromCache: false,
    renderHash,
    layerCount: layers.length
  };
}

/**
 * Render a single layer node onto the accumulator. Returns the new
 * raw RGBA accumulator. All ops operate on raw RGBA buffers — no
 * PNG encode/decode between layers.
 */
async function renderNode(
  node: BundleLayerNode,
  accumulator: Buffer,
  canvasInfo: { width: number; height: number; channels: 4 },
  req: ComposeTreeRequest,
  /** Source raster's natural dims — captured upstream by `composeV2`.
   *  Threaded only as far as `compositeVectorOntoAccumulator` cares
   *  (TEXT shapes use it). Raster + effect layers compute their own
   *  sizing from `canvasInfo` + node fields. */
  sourceWidthPx: number | undefined,
  sourceHeightPx: number | undefined,
  /** Ratio renderDims / canvasDims. Equals 1 for HIGH or any tier where
   *  req.width ≤ canvasWidth (the accumulator is at canvas dims and no
   *  per-layer upscale is needed). Greater than 1 for LOW/MED on small
   *  captures (accumulator at render dims; raster + effect layers must
   *  scale their CANVAS-coord positions/dims by this factor or they end
   *  up in the wrong place). */
  renderScale: number
): Promise<Buffer> {
  if (!node.visible) return accumulator;

  switch (node.kind) {
    case "group":
      // Children handled by the flatten pass; group-level transform /
      // opacity / blend deferred to v2.x (needs nested accumulator).
      return accumulator;

    case "raster":
      return compositeRasterOntoAccumulator(
        node,
        accumulator,
        canvasInfo,
        req,
        renderScale
      );

    case "vector":
      return compositeVectorOntoAccumulator(
        node,
        accumulator,
        canvasInfo,
        // UNSCALED canvas dims from the request — distinct from
        // canvasInfo.width/height which are the post-scale RENDER
        // dims. The HTML text bake needs the unscaled dims for
        // sizePx math anchored to the source raster's short side.
        req.canvasWidthPx,
        req.canvasHeightPx,
        sourceWidthPx,
        sourceHeightPx
      );

    case "effect":
      return applyEffectOntoAccumulator(node, accumulator, canvasInfo, renderScale);
  }
}

/**
 * Composite a raster layer onto the accumulator. Reads source bytes
 * from the bundle (with sha256 verify), applies the layer's
 * translation (transform tx/ty), composites at that position with
 * the layer's opacity.
 *
 * v2.0 limitation: handles translation only. Rotation + scale
 * (transform[0..3]) deferred until the editor exposes those handles.
 * `natural_width_px` / `natural_height_px` are honored as the source
 * dimensions; if the user has scaled down via the matrix, the source
 * is resized first.
 */
async function compositeRasterOntoAccumulator(
  node: Extract<BundleLayerNode, { kind: "raster" }>,
  accumulator: Buffer,
  canvasInfo: { width: number; height: number; channels: 4 },
  req: ComposeTreeRequest,
  /** Render-vs-canvas dim ratio. For scale > 1 (LOW/MED on small
   *  captures) the accumulator is at render dims but the raster's
   *  transform[4]/[5] (tx, ty) and natural_*_px are in CANVAS coords.
   *  Scale both so the raster lands at the correct position AND fills
   *  the same proportional region of the (larger) accumulator. Without
   *  this, the raster ends up in the upper-left at unscaled dims and
   *  vector overlays — which DO scale to render dims via SVG width=
   *  renderWidthPx — spread across the rest of the canvas. */
  renderScale: number
): Promise<Buffer> {
  const sourceBytes = await readSourceFromBundle(req.bundlePath, node.source_ref.sha256);
  // CANVAS-coord position. Scaled below into render coords for placement
  // on the accumulator.
  const tx = Math.round(node.transform[4] * renderScale);
  const ty = Math.round(node.transform[5] * renderScale);

  // Decode source → raw RGBA at natural dims, scaled to render dims.
  // The raster's `natural_*_px` is in CANVAS pixels (matches what the
  // editor saved — for an unmodified capture, natural dims = source
  // PNG dims = canvas dims). At renderScale > 1 we need to upscale the
  // raster to render dims so it covers the same proportional region of
  // the accumulator that it covers in the canvas.
  let layerInput: Buffer = sourceBytes;
  let layerInputInfo: sharp.OverlayOptions["raw"] | undefined = undefined;

  // Effective target dims = natural × transform-scale × renderScale.
  // transform[0]/[3] are the affine scale (1 for identity); renderScale
  // is the bake-pipeline scale (1 for HIGH or any scale-down tier).
  const scaleX = node.transform[0];
  const scaleY = node.transform[3];
  const effectiveScaleX = scaleX * renderScale;
  const effectiveScaleY = scaleY * renderScale;
  if (effectiveScaleX !== 1 || effectiveScaleY !== 1) {
    const targetW = Math.max(1, Math.round(node.natural_width_px * effectiveScaleX));
    const targetH = Math.max(1, Math.round(node.natural_height_px * effectiveScaleY));
    const rawScaled = await sharp(sourceBytes)
      .resize(targetW, targetH, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();
    layerInput = rawScaled;
    layerInputInfo = { width: targetW, height: targetH, channels: 4 };
  }

  // Clip the source raster to the canvas bounds before compositing.
  // sharp.composite refuses inputs larger than the destination ("Image
  // to composite must have same dimensions or smaller"). When the
  // canvas was cropped (Phase 3.5 v2-crop op shrinks canvas_dimensions
  // without modifying the raster source), the raster IS larger than
  // the canvas. Real user hit this on 8nnmKLuUpBI4K8fl. Fix: extract
  // just the in-canvas region of the raster + reset its placement to
  // the corresponding corner of the canvas.
  const sourceW = layerInputInfo?.width ?? node.natural_width_px;
  const sourceH = layerInputInfo?.height ?? node.natural_height_px;
  const visibleLeft = Math.max(0, -tx);
  const visibleTop = Math.max(0, -ty);
  const visibleRight = Math.min(sourceW, canvasInfo.width - tx);
  const visibleBottom = Math.min(sourceH, canvasInfo.height - ty);
  const visibleW = visibleRight - visibleLeft;
  const visibleH = visibleBottom - visibleTop;
  if (visibleW <= 0 || visibleH <= 0) {
    // Layer is entirely off-canvas after the crop — nothing to paint.
    return accumulator;
  }

  // Only run extract when the source actually exceeds the canvas (the
  // common identity-transform case stays a single sharp pipeline).
  const needsExtract =
    visibleLeft > 0 ||
    visibleTop > 0 ||
    visibleW < sourceW ||
    visibleH < sourceH;

  let extractedInput: Buffer = layerInput;
  let extractedRaw: sharp.OverlayOptions["raw"] | undefined = layerInputInfo;
  if (needsExtract) {
    const extractPipeline =
      layerInputInfo !== undefined
        ? sharp(layerInput, { raw: layerInputInfo })
        : sharp(layerInput);
    const extractedBuf = await extractPipeline
      .extract({
        left: visibleLeft,
        top: visibleTop,
        width: visibleW,
        height: visibleH
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
    extractedInput = extractedBuf;
    extractedRaw = { width: visibleW, height: visibleH, channels: 4 };
  }

  const composite: sharp.OverlayOptions = {
    input: extractedInput,
    top: ty + visibleTop,
    left: tx + visibleLeft,
    ...(extractedRaw !== undefined ? { raw: extractedRaw } : {})
  };

  // sharp.composite accepts raw RGBA accumulator + overlay layer.
  return sharp(accumulator, { raw: canvasInfo })
    .composite([composite])
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * Composite a vector layer (arrow / rect / text / step / highlight /
 * crop / blur) onto the accumulator. Reuses v1's SVG-rasterize logic
 * via the OverlayRow shape — the discriminated union is identical
 * between v1's `OverlayRow.data` and v2's `VectorLayer.shape`.
 *
 * Blur shapes hit this path when the user uses the v1-style blur tool
 * (vector kind=blur). The v2 EFFECT-layer blur (sample-below from
 * the accumulator) is a separate kind, handled by applyEffectOntoAccumulator.
 */
async function compositeVectorOntoAccumulator(
  node: Extract<BundleLayerNode, { kind: "vector" }>,
  accumulator: Buffer,
  canvasInfo: { width: number; height: number; channels: 4 },
  /** UNSCALED canvas dims from the capture record. Distinct from
   *  `canvasInfo.width/height` which are the RENDER dims (post
   *  scale-aware upscale in composeV2). Passed through so the HTML
   *  text bake's sizePx math stays anchored to the source raster's
   *  short side regardless of the bake's render scale. */
  canvasWidthPx: number,
  canvasHeightPx: number,
  /** SOURCE raster's natural dims, captured upstream in `composeV2`
   *  from the root raster layer's `natural_*_px`. Threaded through so
   *  TEXT vector shapes can derive fontSize from sourceShortSide (per
   *  pwrdrvr/PwrSnap#110 — keeps the bake's text size invariant across
   *  crops, matching the editor's commit `881cff0` behavior). Optional
   *  to keep callers that don't have a raster (synthetic test trees,
   *  legacy v1-as-v2 fixtures) working. */
  sourceWidthPx?: number,
  sourceHeightPx?: number
): Promise<Buffer> {
  // v2 VectorLayer.shape is the same Overlay discriminated union as
  // v1 OverlayRow.data. We adapt to v1's buildCompositeLayers
  // interface by wrapping into an OverlayRow-shaped envelope. Coords
  // are now canvas-pixel-space; v1's renderers normalize from
  // [0,1] of source W×H, which equals canvas W×H here.
  const fakeRow: OverlayRow = {
    id: node.id,
    capture_id: "",
    data: node.shape as Overlay,
    schema_version: node.source === "user" ? 1 : 1,
    source: node.source,
    ai_run_id: node.ai_run_id,
    applied_at: node.applied_at,
    rejected_at: node.rejected_at,
    superseded_by: node.superseded_by,
    z_index: node.z_index,
    created_at: node.created_at
  };
  // Lazy-import v1's buildCompositeLayers to avoid a top-level cycle
  // (compose.ts may eventually import this file). The blur kind in v1
  // reads from a srcPath — for v2 vector blurs, we'd pass empty since
  // the v2 effect layer is the canonical blur path. Skip blur shapes
  // here; the user should use an EffectLayer.
  if ((node.shape as Overlay).kind === "blur") {
    return accumulator; // EffectLayer is the v2 blur path
  }

  const { buildCompositeLayersForV2 } = await import("./compose-tree-vector");
  const layers = await buildCompositeLayersForV2(fakeRow, {
    // canvasInfo.width/height are the RENDER dims (post-scale). SVG
    // renderers + the HTML text bake produce output at these.
    renderWidthPx: canvasInfo.width,
    renderHeightPx: canvasInfo.height,
    // UNSCALED canvas dims from the capture record. Threaded so the
    // text bake's sizePx math can derive
    //   fontPx = (renderHeight / canvasHeight) × sizePx
    // — produces text at `renderScale × sizePx` pixels, matching the
    // editor's display behavior.
    canvasWidthPx,
    canvasHeightPx,
    sourceWidthPx,
    sourceHeightPx
  });
  if (layers.length === 0) return accumulator;
  return sharp(accumulator, { raw: canvasInfo })
    .composite(layers)
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * Apply a contextual effect (blur / highlight) by sampling the
 * accumulator under `clip_rect`, running the operation, compositing
 * the result back. This is the v2 "sample-below" semantics — moving
 * a layer beneath this effect changes the bytes the effect operates
 * on, so the rendered output follows.
 *
 * For v2.0, clip_rect with non-finite or zero-area values short-
 * circuits (no-op).
 */
async function applyEffectOntoAccumulator(
  node: Extract<BundleLayerNode, { kind: "effect" }>,
  accumulator: Buffer,
  canvasInfo: { width: number; height: number; channels: 4 },
  /** Render-vs-canvas dim ratio. `clip_rect` is in CANVAS coords; when
   *  the accumulator is at render dims (scale > 1) the rect must be
   *  scaled or the effect lands at the wrong region (typically the
   *  upper-left at unscaled coords). When `clip_rect` is null
   *  (adjustment-layer scope) the fallback uses `canvasInfo` dims
   *  directly — those are ALREADY render dims, so no scaling needed
   *  for that branch. */
  renderScale: number
): Promise<Buffer> {
  // Determine the clip rect. null = entire canvas (adjustment-layer
  // scope, in render coords already). Otherwise scale CANVAS-coord
  // rect into render coords, then clamp to accumulator bounds.
  const rect =
    node.clip_rect !== null
      ? {
          x: node.clip_rect.x * renderScale,
          y: node.clip_rect.y * renderScale,
          w: node.clip_rect.w * renderScale,
          h: node.clip_rect.h * renderScale
        }
      : { x: 0, y: 0, w: canvasInfo.width, h: canvasInfo.height };
  const x = Math.max(0, Math.min(canvasInfo.width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(canvasInfo.height, Math.round(rect.y)));
  const w = Math.max(0, Math.min(canvasInfo.width - x, Math.round(rect.w)));
  const h = Math.max(0, Math.min(canvasInfo.height - y, Math.round(rect.h)));
  if (w === 0 || h === 0) return accumulator;

  // Extract the rect from the accumulator into a raw RGBA buffer.
  const extracted = await sharp(accumulator, { raw: canvasInfo })
    .extract({ left: x, top: y, width: w, height: h })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const extractedInfo = { width: w, height: h, channels: 4 as const };

  let operated: Buffer;
  if (node.effect.type === "blur") {
    // Phase 3.4 — branch on the optional `style` field added to the
    // v2 BlurEffect schema. Legacy v2 bundles without it fall back to
    // gaussian (the historic default). Mirrors the three modes v1's
    // compose.ts bake supports — see apps/desktop/src/main/render/
    // compose.ts:463-506 for the canonical implementation.
    const style = node.effect.style ?? "gaussian";

    if (style === "redact") {
      // Solid opaque black fill. No need to consult the extracted
      // source — just synthesize a same-sized raw RGBA buffer.
      const buf = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 0;
        buf[i * 4 + 1] = 0;
        buf[i * 4 + 2] = 0;
        buf[i * 4 + 3] = 255;
      }
      operated = buf;
    } else if (style === "pixelate") {
      // Mosaic: resize down to a coarse grid (bicubic averaging) then
      // back up with nearest-neighbor so the blocks stay sharp. Block
      // size = 1/16 of the short side, floored at 4 px so tiny rects
      // don't smooth out.
      const shortSide = Math.min(w, h);
      const blockSizePx = Math.max(4, Math.round(shortSide / 16));
      const downW = Math.max(1, Math.floor(w / blockSizePx));
      const downH = Math.max(1, Math.floor(h / blockSizePx));
      operated = await sharp(extracted, { raw: extractedInfo })
        .resize(downW, downH)
        .resize(w, h, { kernel: "nearest" })
        .ensureAlpha()
        .raw()
        .toBuffer();
    } else {
      // gaussian (default) — sharp's blur(sigma). radius_px is
      // interpreted as sigma (sharp's convention). Clamp to sharp's
      // documented range.
      const sigma = Math.max(0.3, Math.min(1000, node.effect.radius_px));
      operated = await sharp(extracted, { raw: extractedInfo })
        .blur(sigma)
        .ensureAlpha()
        .raw()
        .toBuffer();
    }
  } else {
    // Highlight: tint the rect with the chosen color at the given
    // opacity, composited over the extracted region. Simpler than
    // full alpha-blending math — sharp's composite with blend:'over'
    // handles it.
    const hex = node.effect.tint_hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const alpha = Math.round(node.effect.opacity * 255);
    const tintBuf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      tintBuf[i * 4] = r;
      tintBuf[i * 4 + 1] = g;
      tintBuf[i * 4 + 2] = b;
      tintBuf[i * 4 + 3] = alpha;
    }
    operated = await sharp(extracted, { raw: extractedInfo })
      .composite([{ input: tintBuf, raw: extractedInfo, blend: "over" }])
      .ensureAlpha()
      .raw()
      .toBuffer();
  }

  // Composite the operated rect back onto the accumulator at (x,y).
  return sharp(accumulator, { raw: canvasInfo })
    .composite([
      {
        input: operated,
        raw: extractedInfo,
        top: y,
        left: x
      }
    ])
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * Flatten a layer tree into z-order. Groups expand in-place at their
 * sibling position. Output is a flat array suitable for sequential
 * application onto the accumulator.
 *
 * Ordering rules:
 *   • Within a parent, siblings are ordered by `z_index ASC,
 *     created_at ASC` (matches listLayerTree's SQL ORDER BY).
 *   • A group node appears in the output BEFORE its children so the
 *     compositor knows where the group "starts" (currently a no-op
 *     because group-level transforms aren't applied in v2.0).
 */
function flattenTreeInZOrder(layers: readonly BundleLayerNode[]): BundleLayerNode[] {
  // Build parent → children map.
  const childrenByParent = new Map<string | null, BundleLayerNode[]>();
  for (const node of layers) {
    const kids = childrenByParent.get(node.parent_id);
    if (kids === undefined) {
      childrenByParent.set(node.parent_id, [node]);
    } else {
      kids.push(node);
    }
  }
  // Stable sort within each parent (DB already returned in order;
  // re-sort defensively in case caller skipped that).
  for (const kids of childrenByParent.values()) {
    kids.sort((a, b) => {
      if (a.z_index !== b.z_index) return a.z_index - b.z_index;
      return a.created_at.localeCompare(b.created_at);
    });
  }
  const flat: BundleLayerNode[] = [];
  const walk = (parentId: string | null): void => {
    const kids = childrenByParent.get(parentId) ?? [];
    for (const node of kids) {
      flat.push(node);
      if (node.kind === "group") walk(node.id);
    }
  };
  walk(null);
  return flat;
}

/**
 * Compute the cache key for a tree render. Hashes (a) the flattened
 * z-order, (b) every layer's full state including parent_id, transform,
 * effect params, opacity — anything that affects the rendered output.
 * Effect-layer hashing naturally includes "what's below" because
 * we hash the full flattened sequence in order.
 */
/** Sentinel version bumped whenever the bake pipeline produces
 *  different OUTPUT bytes for the same input layer tree + dims +
 *  format. Included in the renderHash so a pipeline change cleanly
 *  invalidates the existing render-cache without requiring users to
 *  nuke `~/Library/Application Support/PwrSnap/render-cache/`.
 *
 *  Bump history:
 *    "1" — original (canvas-dims accumulator, withoutEnlargement,
 *           default sharp.png() palette mode)
 *    "2" — scale-aware accumulator (renders at target dims for
 *           upscale tiers), force RGBA PNG output (palette: false),
 *           HTML text bake via hidden BrowserWindow. The WYSIWYG
 *           shipment. SHIPPED BROKEN — raster + effect compositors
 *           didn't scale their canvas-coord positions/dims by
 *           renderScale, leaving the image in the upper-left and
 *           overlays scattered across the full render canvas.
 *    "3" — fix v2's positioning bug: raster's tx/ty + natural_*_px
 *           and effect's clip_rect now scale by renderScale so the
 *           bake matches the editor across all preset tiers. */
const BAKE_PIPELINE_VERSION = "3";

function computeTreeRenderHash(input: {
  layers: readonly BundleLayerNode[];
  canvasWidthPx: number;
  canvasHeightPx: number;
  width: number;
  format: "png" | "webp";
}): string {
  const flat = flattenTreeInZOrder(input.layers);
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      v: BAKE_PIPELINE_VERSION,
      canvas: [input.canvasWidthPx, input.canvasHeightPx],
      width: input.width,
      format: input.format,
      layers: flat.map((n) => {
        // Strip lifecycle timestamps (applied_at, created_at) from the
        // hash — they don't affect the render. Keep everything that
        // does.
        if (n.kind === "raster") {
          return [n.kind, n.id, n.parent_id, n.z_index, n.opacity, n.blend_mode, n.transform, n.source_ref.sha256, n.natural_width_px, n.natural_height_px, n.visible];
        }
        if (n.kind === "vector") {
          return [n.kind, n.id, n.parent_id, n.z_index, n.opacity, n.blend_mode, n.transform, n.shape, n.visible];
        }
        if (n.kind === "effect") {
          return [n.kind, n.id, n.parent_id, n.z_index, n.opacity, n.blend_mode, n.transform, n.effect, n.clip_rect, n.visible];
        }
        return [n.kind, n.id, n.parent_id, n.z_index, n.visible];
      })
    })
  );
  return hash.digest("hex").slice(0, 32);
}
