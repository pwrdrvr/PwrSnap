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
import type { ArrowEndStyle, OverlayRow } from "@pwrsnap/shared";
import {
  computeArrowGeometry,
  computeStemDashArray,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle,
  readBlurStyle,
  readHighlightBlend,
  readHighlightColor,
  readHighlightOpacity,
  readOverlayRotation,
  readOverlayThickness,
  readRectFilled,
  readTextWeight
} from "@pwrsnap/shared";
import { getCacheRoot } from "../persistence/paths";
import { listLiveOverlays } from "../persistence/overlays-repo";
import { getMainLogger } from "../log";
import { optimizePngBuffer } from "../image/png-optimize";
import { computeRenderHash } from "./overlay-hash";

const log = getMainLogger("pwrsnap:render");

// Main process can't read CSS vars, so the overlay-render default
// for `color: "auto"` mirrors --accent from the design tokens.
// Keep in sync with apps/desktop/src/renderer/src/styles/tokens.css.
const AUTO_ACCENT_HEX = "#ff8a1f";

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

  // Resize-kernel selection. The default (lanczos3) is the right call
  // for photographic content — sharp edges, good anti-aliasing. But
  // pixelate blur overlays are baked into the source-resolution
  // composite as crisp mosaic blocks (`kernel: "nearest"` in
  // blurLayer()); a subsequent lanczos3 downscale to thumbnail width
  // smooths those blocks back out so the library grid renders the
  // pixelate looking like a gaussian blur. Detect a pixelate overlay
  // and downgrade to `nearest` for that capture's downscale — the
  // pixelate blocks survive intact, and the rest of the image gets a
  // slightly harsher (but still legible) thumbnail. Only applies when
  // an actual downscale is happening; equal-width renders are
  // pass-through.
  const hasPixelate = overlays.some(
    (row) => row.data.kind === "blur" && readBlurStyle(row.data) === "pixelate"
  );
  const downscaling = req.width < srcWidthPx;
  const sized = resizePipeline.resize({
    width: req.width,
    withoutEnlargement: true,
    ...(hasPixelate && downscaling ? { kernel: "nearest" as const } : {})
  });

  // Do not pass `effort` to Sharp's PNG encoder here: in Sharp, PNG
  // `effort` implies palette quantization. The follow-up optimizer
  // treats this encode as the truecolor baseline and only replaces it
  // with exact palette output after proving raw-pixel identity.
  const encoded =
    req.format === "png"
      ? await sized.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await sized.webp({ lossless: true, effort: 4 }).toBuffer();
  const buf =
    req.format === "png"
      ? (await optimizePngBuffer(encoded, { recompressTruecolor: false })).buffer
      : encoded;

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
    case "highlight": {
      // Highlight blend modes (multiply / screen / overlay) only take
      // effect at the sharp composite step — the rasterized SVG alone
      // would produce flat "over" compositing. Attach blend to the
      // OverlayOptions after rasterize.
      const layer = await rasterize(
        highlightSvg(data, imageWidthPx, imageHeightPx),
        imageWidthPx,
        imageHeightPx
      );
      return [{ ...layer, blend: highlightBlendMode(data) }];
    }
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
/**
 * Internal SVG rasterize helper. Exposed via `rasterizeSvgForV2`
 * (re-exported below) so the v2 tree-walking compositor in
 * compose-tree-vector.ts can reuse the same pixel-accurate
 * raw-RGBA produce-composite-layer discipline.
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
  const endStyle = readArrowEndStyle(data);
  const stemStyle = readArrowStemStyle(data);
  const doubleEnded = readArrowDoubleEnded(data);
  // Two-step thickness resolution so the head triangle scales with
  // the stem (Small/Medium/Large). Without this, Large doubled the
  // stem but left the head at auto size — fat stem, tiny head, and
  // open-triangle's hollow filled in with the now-thick outline
  // stroke. Live editor's ArrowGlyph mirrors this same pattern.
  //   1. auto geometry → use its strokeFraction as the basis
  //   2. resolve thickness override against that fraction
  //   3. final geometry with the resolved stroke as override
  // styleVersion pins the head proportions + stroke clamps to the
  // recipe this row was drawn with. Missing/undefined → v1 (legacy
  // proportions) so pre-versioning rows render unchanged. New rows
  // get stamped with `CURRENT_ARROW_STYLE_VERSION` at commit time
  // in Editor.tsx.
  const styleVersion = data.styleVersion;
  const autoGeom = computeArrowGeometry({
    from: data.from,
    to: data.to,
    imageWidthPx,
    imageHeightPx,
    styleVersion
  });
  const shortSidePx = Math.max(1, Math.min(imageWidthPx, imageHeightPx));
  // Pass autoStrokeWidthPx + shortSidePx so readOverlayThickness's
  // floor-fraction formula activates on Large/X-Large for high-DPI
  // captures. Output is in pixels.
  const strokeWidthOverridePx =
    data.thickness === undefined || data.thickness === "auto"
      ? undefined
      : readOverlayThickness(data.thickness, autoGeom.strokeWidthPx, shortSidePx);
  const headGeom =
    strokeWidthOverridePx === undefined
      ? autoGeom
      : computeArrowGeometry({
          from: data.from,
          to: data.to,
          imageWidthPx,
          imageHeightPx,
          strokeWidthOverridePx,
          styleVersion
        });
  // Mirrored geometry for the tail-end head — same algorithm with
  // from/to swapped. Keeps the head triangle's proportions identical
  // at both ends instead of trying to reflect points by hand and
  // getting the perpendicular sign wrong on slanted arrows. Same
  // override applied so both ends match.
  const tailGeom = doubleEnded
    ? computeArrowGeometry({
        from: data.to,
        to: data.from,
        imageWidthPx,
        imageHeightPx,
        strokeWidthOverridePx,
        styleVersion
      })
    : null;

  const fillColor = data.color === "auto" ? AUTO_ACCENT_HEX : data.color;
  // Stem stroke = final geometry's strokeWidthPx. Short-arrow
  // correction inside computeArrowGeometry may have shrunk it from
  // the requested override so a Large thickness on a tiny arrow
  // still renders proportionally.
  const strokeWidthPx = headGeom.strokeWidthPx;
  // White outline always drawn (per plan §"Smart arrow algorithm"):
  // legibility on busy images. The outline is a slightly thicker
  // pass underneath the accent.
  const outlineWidth = Math.max(1.5, strokeWidthPx * 0.25);

  // Stem endpoints depend on the head style (see live editor's
  // `stemEndpointFor` — keep this in sync). Filled / open triangles
  // hand off to the head at baseCenter; line / dot terminate at the
  // apex (`to`) and the head paints over the stem end.
  const stemEndAtTo = stemEndpointPx(endStyle, headGeom, imageWidthPx, imageHeightPx);
  const stemEndAtFrom = tailGeom !== null
    ? stemEndpointPx(endStyle, tailGeom, imageWidthPx, imageHeightPx)
    : pxOf(headGeom.from, imageWidthPx, imageHeightPx);

  // Stem dash pattern, aligned to both stem ends via
  // computeStemDashArray (shared with the live editor — same helper
  // = identical math in renderer vs bake). N dashes + (N−1) gaps fill
  // the stem exactly so the line begins and ends on a complete dash.
  // The HALO line uses the same pattern; without that, a dashed
  // colored stem over a solid halo would show white "ghost dashes"
  // through the gaps.
  const stemLengthPx = Math.hypot(
    stemEndAtTo.x - stemEndAtFrom.x,
    stemEndAtTo.y - stemEndAtFrom.y
  );
  const stemDashRaw = computeStemDashArray(stemStyle, stemLengthPx, strokeWidthPx);
  const stemDashAttr = stemDashRaw === null ? "" : ` stroke-dasharray="${stemDashRaw}"`;

  const halo = arrowHeadHaloSvg(endStyle, headGeom, imageWidthPx, imageHeightPx, outlineWidth, strokeWidthPx);
  const head = arrowHeadSvg(endStyle, headGeom, imageWidthPx, imageHeightPx, strokeWidthPx, fillColor);
  const haloTail = tailGeom !== null
    ? arrowHeadHaloSvg(endStyle, tailGeom, imageWidthPx, imageHeightPx, outlineWidth, strokeWidthPx)
    : "";
  const headTail = tailGeom !== null
    ? arrowHeadSvg(endStyle, tailGeom, imageWidthPx, imageHeightPx, strokeWidthPx, fillColor)
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round">
    <line x1="${stemEndAtFrom.x}" y1="${stemEndAtFrom.y}" x2="${stemEndAtTo.x}" y2="${stemEndAtTo.y}"
          stroke="white" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round"${stemDashAttr} fill="none" />
    ${halo}
    ${haloTail}
    <line x1="${stemEndAtFrom.x}" y1="${stemEndAtFrom.y}" x2="${stemEndAtTo.x}" y2="${stemEndAtTo.y}"
          stroke="${fillColor}" stroke-width="${strokeWidthPx}" stroke-linecap="round"${stemDashAttr} fill="none" />
    ${head}
    ${headTail}
  </g>
</svg>`;
}

/** Pixel-space stem endpoint for the bake. Mirror of OverlaySvg's
 *  `stemEndpointFor` — kept in sync so the live preview and the bake
 *  put the stem in the same place relative to each head style. */
function stemEndpointPx(
  style: ArrowEndStyle,
  geom: ReturnType<typeof computeArrowGeometry>,
  imageWidthPx: number,
  imageHeightPx: number
): { x: number; y: number } {
  switch (style) {
    case "filled-triangle":
    case "open-triangle":
      return pxOf(geom.baseCenter, imageWidthPx, imageHeightPx);
    case "line":
    case "dot":
      return pxOf(geom.to, imageWidthPx, imageHeightPx);
  }
}

// `stemDashAttr_PixelSpace` removed in favor of `computeStemDashArray`
// from @pwrsnap/shared — scales the dash pattern to land on a
// complete dash at both ends of the stem (vs the old fixed-cycle
// pattern that left a sliver / partial gap at the tail end). Shared
// helper means renderer + bake produce byte-identical dash math.

function arrowHeadHaloSvg(
  style: ArrowEndStyle,
  geom: ReturnType<typeof computeArrowGeometry>,
  imageWidthPx: number,
  imageHeightPx: number,
  outlineWidth: number,
  strokeWidthPx: number
): string {
  const toPx = pxOf(geom.to, imageWidthPx, imageHeightPx);
  const baseLeftPx = pxOf(geom.baseLeft, imageWidthPx, imageHeightPx);
  const baseRightPx = pxOf(geom.baseRight, imageWidthPx, imageHeightPx);
  switch (style) {
    case "filled-triangle": {
      // Filled head: interior is colored, halo only needs to peek
      // at the rim. fill="white" works because the colored polygon
      // on top covers everything but the rim.
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      return `<polygon points="${polygon}" fill="white" stroke="white" stroke-width="${outlineWidth * 2}" stroke-linejoin="round" />`;
    }
    case "open-triangle": {
      // Hollow head: interior must stay transparent. fill="none" +
      // wider stroke so the white peeks `outlineWidth` past the
      // colored stroke on BOTH sides (outside edge for legibility
      // against the background, inside edge for legibility against
      // whatever shows through the hollow). Mirrors the live editor's
      // ArrowHeadHalo open-triangle case — keep in sync.
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      return `<polygon points="${polygon}" fill="none" stroke="white" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linejoin="round" />`;
    }
    case "line":
      return `<line x1="${baseLeftPx.x}" y1="${baseLeftPx.y}" x2="${baseRightPx.x}" y2="${baseRightPx.y}" stroke="white" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round" />`;
    case "dot": {
      const r = strokeWidthPx * 1.5;
      return `<circle cx="${toPx.x}" cy="${toPx.y}" r="${r + outlineWidth}" fill="white" stroke="white" stroke-width="${outlineWidth * 2}" />`;
    }
  }
}

function arrowHeadSvg(
  style: ArrowEndStyle,
  geom: ReturnType<typeof computeArrowGeometry>,
  imageWidthPx: number,
  imageHeightPx: number,
  strokeWidthPx: number,
  fillColor: string
): string {
  const toPx = pxOf(geom.to, imageWidthPx, imageHeightPx);
  const baseLeftPx = pxOf(geom.baseLeft, imageWidthPx, imageHeightPx);
  const baseRightPx = pxOf(geom.baseRight, imageWidthPx, imageHeightPx);
  switch (style) {
    case "filled-triangle": {
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      return `<polygon points="${polygon}" fill="${fillColor}" />`;
    }
    case "open-triangle": {
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      return `<polygon points="${polygon}" fill="none" stroke="${fillColor}" stroke-width="${strokeWidthPx}" stroke-linejoin="round" />`;
    }
    case "line":
      return `<line x1="${baseLeftPx.x}" y1="${baseLeftPx.y}" x2="${baseRightPx.x}" y2="${baseRightPx.y}" stroke="${fillColor}" stroke-width="${strokeWidthPx}" stroke-linecap="round" />`;
    case "dot": {
      const r = strokeWidthPx * 1.5;
      return `<circle cx="${toPx.x}" cy="${toPx.y}" r="${r}" fill="${fillColor}" />`;
    }
  }
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
  const autoStrokeWidthPx = clamp(shortSidePx / 220, 4, 14);
  // Pass shortSidePx so the floor-fraction formula activates on
  // Large/X-Large — same Retina rescue as the arrow path. Numeric
  // thickness values are normalized fractions in the schema; the
  // helper expands them when shortSidePx is provided.
  const strokeWidthPx = readOverlayThickness(
    data.thickness,
    autoStrokeWidthPx,
    shortSidePx
  );
  const outlinePx = Math.max(1.5, strokeWidthPx * 0.25);
  const fillColor = data.color === "auto" ? AUTO_ACCENT_HEX : data.color;
  const filled = readRectFilled(data);
  // Rotation transform — same convention as RectGlyph (live editor):
  // SVG `rotate(deg cx cy)` in pixel-space with cx/cy at the rect's
  // geometric center. `transform` is omitted entirely when rotation
  // is 0, so existing unrotated rows bake byte-identical to before.
  const rotateDeg = (readOverlayRotation(data) * 180) / Math.PI;
  const cx = xPx + wPx / 2;
  const cy = yPx + hPx / 2;
  const groupTransform =
    rotateDeg !== 0 ? ` transform="rotate(${rotateDeg} ${cx} ${cy})"` : "";

  if (filled) {
    // Solid fill — single rect, no stroke / halo. A halo around a
    // solid fill would just visually expand the same color outward
    // by a stroke-width without adding contrast.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g${groupTransform}>
    <rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}" fill="${fillColor}" />
  </g>
</svg>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round"${groupTransform}>
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
  // Honor the row's `color` + `opacity` (legacy rows fall back to
  // yellow + 0.32 via the shared read helpers — matches the renderer's
  // HighlightGlyph defaults). The blend mode is NOT applied in the
  // SVG — resvg doesn't honor `mix-blend-mode` reliably, and even if
  // it did, the blend would happen between the highlight rect and the
  // SVG background (transparent), not against the photo below. We
  // attach `blend` to the sharp composite layer instead; see the
  // `case "highlight"` branch in buildCompositeLayers /
  // buildCompositeLayersForV2.
  const fillHex = readHighlightColor(data);
  const fillOpacity = readHighlightOpacity(data);
  // Rotation transform — same convention as the live HighlightGlyph;
  // omit attribute entirely when rotation is 0 so unrotated legacy
  // rows produce byte-identical SVG.
  const rotateDeg = (readOverlayRotation(data) * 180) / Math.PI;
  const cx = xPx + wPx / 2;
  const cy = yPx + hPx / 2;
  const transformAttr =
    rotateDeg !== 0 ? ` transform="rotate(${rotateDeg} ${cx} ${cy})"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}" fill="${fillHex}" fill-opacity="${fillOpacity}"${transformAttr} />
</svg>`;
}

/** Resolve a highlight row's blend mode to the sharp/libvips
 *  composite `blend` option string. The schema's blend values
 *  (`multiply` / `screen` / `overlay`) map 1:1 to libvips blend
 *  modes — sharp accepts them verbatim. Exported via
 *  `highlightBlendForV2` below so the v2 vector compositor stays
 *  in lockstep. */
function highlightBlendMode(
  data: Extract<OverlayRow["data"], { kind: "highlight" }>
): "multiply" | "screen" | "overlay" {
  return readHighlightBlend(data);
}

/* ----------------------------- Text ----------------------------- */

function textSvg(
  data: Extract<OverlayRow["data"], { kind: "text" }>,
  imageWidthPx: number,
  imageHeightPx: number,
  /** SOURCE raster's natural dims, when known. v2 captures can be
   *  cropped — the canvas dims (`imageWidthPx` / `imageHeightPx`)
   *  shrink with every crop but the raster's source-pixel scale stays
   *  constant. To keep text overlays at the same physical size as the
   *  editor renders them (commit `881cff0` made the editor source-
   *  shortSide-based), the bake must use the source's shortSide too.
   *
   *  v1 callers — and v2 callers that don't have source dims at hand —
   *  can omit these args; the function falls back to canvas shortSide,
   *  matching the pre-#110-bake behavior. v1 captures have source ==
   *  canvas so the fallback is also correct for them. */
  sourceWidthPx?: number,
  sourceHeightPx?: number
): string {
  const xPx = data.point.x * imageWidthPx;
  const yPx = data.point.y * imageHeightPx;
  // When the row carries an explicit sizePx (pwrdrvr/PwrSnap#110),
  // that value wins — bucket math is bypassed. Otherwise fall back to
  // bucket × source-shortSide (with canvas-shortSide as the legacy
  // fallback when source dims aren't known). Same precedence as
  // `computeTextGlyphSize` in @pwrsnap/shared — the renderer and the
  // bake walk the same decision tree so the live preview and the
  // export always agree.
  //
  //   small  ≈ shortSide / 50
  //   medium ≈ shortSide / 30
  //   large  ≈ shortSide / 18
  const shortSideForSizing =
    sourceWidthPx !== undefined &&
    sourceHeightPx !== undefined &&
    sourceWidthPx > 0 &&
    sourceHeightPx > 0
      ? Math.min(sourceWidthPx, sourceHeightPx)
      : Math.min(imageWidthPx, imageHeightPx);
  const bucketSizePx =
    data.size === "large"
      ? shortSideForSizing / 18
      : data.size === "medium"
        ? shortSideForSizing / 30
        : shortSideForSizing / 50;
  const fontSizePx =
    data.sizePx !== undefined && Number.isFinite(data.sizePx) && data.sizePx > 0
      ? data.sizePx
      : bucketSizePx;
  const accent = data.color === "auto" ? AUTO_ACCENT_HEX : data.color;
  // Multi-line: split body on "\n" and emit one tspan per line, each
  // advancing the baseline by 1.2em. dominant-baseline="central" puts
  // the first line's glyph center on the click point (matches the
  // editor's click-to-center UX) — the v1 default was "hanging" which
  // put the click at the TOP of the text, causing it to appear below
  // the cursor on commit. The renderer (TextGlyph) does the same.
  // xml-escape each line so user input can't break out of the SVG.
  const splitLines = data.body.split("\n");
  const lines = splitLines
    .map((line, i) => {
      const dy = i === 0 ? "0em" : "1.2em";
      return `<tspan x="${xPx}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  // Resolve weight via the shared helper — legacy rows (no weight)
  // fall back to 600 (the historical hardcoded value) so old captures
  // bake identically. New rows from the popover land "regular" → 400
  // or "bold" → 700.
  const fontWeight = readTextWeight(data);
  // Rotation transform — same convention as the live TextGlyph:
  // rotation pivots around the BODY-BOX CENTER (not the anchor) so
  // the visible glyph rotates around its visual center instead of
  // swinging around the off-glyph left-edge anchor point. Body-box
  // center in viewport coords:
  //   • cx = xPx + naturalWidthPx / 2
  //   • cy = yPx + (naturalHeightPx - fontSizePx) / 2
  //     (yPx is the first line's vertical center via dominant-
  //     baseline=central; box top is yPx - fontSizePx/2; box height
  //     is naturalHeightPx; so center = yPx - fontSizePx/2 +
  //     naturalHeightPx/2 = yPx + (naturalHeightPx - fontSizePx) / 2)
  // Same charAdvance / line-height constants as `textBoundsBox` in
  // OverlaySvg.tsx — keeping them in lockstep is what makes the
  // bake match the live editor on rotated text.
  const rotateDeg = (readOverlayRotation(data) * 180) / Math.PI;
  const charAdvance = 0.55;
  const maxChars = splitLines.reduce((m, l) => Math.max(m, l.length), 0);
  const naturalWidthPx = maxChars * fontSizePx * charAdvance;
  const naturalHeightPx = fontSizePx * (splitLines.length * 1.2 - 0.2);
  const cxPivot = xPx + naturalWidthPx / 2;
  const cyPivot = yPx + (naturalHeightPx - fontSizePx) / 2;
  const textOpenG =
    rotateDeg !== 0
      ? `<g transform="rotate(${rotateDeg} ${cxPivot} ${cyPivot})">`
      : "";
  const textCloseG = rotateDeg !== 0 ? "</g>" : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  ${textOpenG}<text x="${xPx}" y="${yPx}"
        font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSizePx}"
        font-weight="${fontWeight}"
        fill="${accent}"
        stroke="rgba(0,0,0,0.7)"
        stroke-width="${fontSizePx * 0.08}"
        paint-order="stroke"
        dominant-baseline="central">${lines}</text>${textCloseG}
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

/** Compute the AABB of a rotated rect in pixel space. Used by the
 *  blur bake to know how much source to extract + how big the mask
 *  needs to be. The rect's geometric center is the rotation pivot
 *  (matches the renderer's `RectGlyph` + `compose.ts` `rectSvg`
 *  conventions). Returns the four bounds + a few derived offsets
 *  the caller uses to position the mask. */
function rotatedRectAabbPx(
  leftPx: number,
  topPx: number,
  widthPx: number,
  heightPx: number,
  rotation: number
): {
  aabbLeft: number;
  aabbTop: number;
  aabbWidth: number;
  aabbHeight: number;
} {
  if (rotation === 0) {
    return {
      aabbLeft: leftPx,
      aabbTop: topPx,
      aabbWidth: widthPx,
      aabbHeight: heightPx
    };
  }
  const cx = leftPx + widthPx / 2;
  const cy = topPx + heightPx / 2;
  const hw = widthPx / 2;
  const hh = heightPx / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // Four corners in the rect's local frame; rotate, translate to
  // pivot, then compute min/max across all four.
  const corners = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh }
  ].map(({ x, y }) => ({
    x: cx + x * cos - y * sin,
    y: cy + x * sin + y * cos
  }));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    aabbLeft: minX,
    aabbTop: minY,
    aabbWidth: maxX - minX,
    aabbHeight: maxY - minY
  };
}

/** SVG mask shaped like a rotated rect, rendered at AABB-local
 *  coords. White inside the rect, transparent everywhere else —
 *  ready for sharp's `dest-in` composite to keep only the rect-
 *  shaped subset of the blurred AABB.
 *
 *  Coordinates are AABB-local: caller passes the rect's top-left
 *  position relative to the AABB's origin, plus the rotation pivot
 *  (which is the rect center, also in AABB-local coords). For
 *  unrotated rects the rect fills the AABB exactly (the AABB IS
 *  the rect), so the mask is a solid white fill — but we still
 *  emit the rect form for code uniformity. */
function rotatedRectMaskSvg(args: {
  aabbWidth: number;
  aabbHeight: number;
  rectLocalLeft: number;
  rectLocalTop: number;
  rectWidth: number;
  rectHeight: number;
  rotation: number;
}): Buffer {
  const rotDeg = (args.rotation * 180) / Math.PI;
  const cx = args.rectLocalLeft + args.rectWidth / 2;
  const cy = args.rectLocalTop + args.rectHeight / 2;
  const transformAttr =
    args.rotation !== 0 ? ` transform="rotate(${rotDeg} ${cx} ${cy})"` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${args.aabbWidth}" height="${args.aabbHeight}" viewBox="0 0 ${args.aabbWidth} ${args.aabbHeight}">
  <rect x="${args.rectLocalLeft}" y="${args.rectLocalTop}" width="${args.rectWidth}" height="${args.rectHeight}" fill="white"${transformAttr} />
</svg>`;
  return Buffer.from(svg);
}

async function blurLayer(
  data: Extract<OverlayRow["data"], { kind: "blur" }>,
  srcPath: string,
  imageWidthPx: number,
  imageHeightPx: number
): Promise<sharp.OverlayOptions | null> {
  // Mask-style overlay: extract the rect from the source, transform
  // it (Gaussian blur / nearest-neighbor downscale / solid fill),
  // composite back at the same coords. Cheaper than running the
  // operation on the full source + masking, because the inner pixel
  // cost scales with the rect, not the whole image.
  //
  // Rotation support: when the row carries a non-zero `rotation`, we
  // extract the AABB of the ROTATED rect (a few more pixels than the
  // rect itself), run the operation on the AABB, then mask the result
  // with a rotated-rect SVG via `dest-in` composite so the visible
  // blurred region matches the user-rotated shape. Unrotated rows
  // (rotation === 0) skip the mask step entirely — the operated buffer
  // is composited back as-is, byte-identical to the pre-rotation bake.
  const rotation = readOverlayRotation(data);
  const leftPx = data.rect.x * imageWidthPx;
  const topPx = data.rect.y * imageHeightPx;
  const widthPx = data.rect.w * imageWidthPx;
  const heightPx = data.rect.h * imageHeightPx;
  if (widthPx <= 0 || heightPx <= 0) return null;

  const aabb = rotatedRectAabbPx(leftPx, topPx, widthPx, heightPx, rotation);

  // Clamp the AABB to image bounds so .extract() doesn't error.
  // The mask is computed AFTER clamping so partial-off-canvas
  // rotations still produce a coherent rotated shape.
  const extractLeft = Math.max(0, Math.floor(aabb.aabbLeft));
  const extractTop = Math.max(0, Math.floor(aabb.aabbTop));
  const extractWidth = Math.max(
    1,
    Math.min(
      imageWidthPx - extractLeft,
      Math.ceil(aabb.aabbLeft + aabb.aabbWidth) - extractLeft
    )
  );
  const extractHeight = Math.max(
    1,
    Math.min(
      imageHeightPx - extractTop,
      Math.ceil(aabb.aabbTop + aabb.aabbHeight) - extractTop
    )
  );
  if (extractWidth <= 0 || extractHeight <= 0) return null;

  const style = readBlurStyle(data);

  // Produce the operated buffer (pre-mask). Three style branches; the
  // shape of the output is always extractWidth × extractHeight PNG.
  let operatedBuf: Buffer;
  if (style === "redact") {
    // Solid opaque black — privacy redaction. Cheapest of the three
    // because no source extraction is needed; we just generate a
    // flat PNG of the right dimensions.
    operatedBuf = await sharp({
      create: {
        width: extractWidth,
        height: extractHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .png()
      .toBuffer();
  } else if (style === "pixelate") {
    // Classic "mosaic" pixelation — downscale the extracted region
    // to a coarse grid (one pixel per visible block), then scale it
    // back up with nearest-neighbor so the blocks stay crisp instead
    // of smoothing back out.
    //
    // Block size proportional to the rect's short side: ~16 blocks
    // along the short side at any rect size keeps the visual chunk
    // density consistent. Floor to at least 4×4 pixels per block so
    // tiny rects don't end up looking smooth.
    const shortSide = Math.min(extractWidth, extractHeight);
    const blocksAcrossShortSide = 16;
    const blockSizePx = Math.max(4, Math.round(shortSide / blocksAcrossShortSide));
    const downW = Math.max(1, Math.floor(extractWidth / blockSizePx));
    const downH = Math.max(1, Math.floor(extractHeight / blockSizePx));
    operatedBuf = await sharp(srcPath)
      .extract({
        left: extractLeft,
        top: extractTop,
        width: extractWidth,
        height: extractHeight
      })
      // First hop: average down to the coarse grid (default bicubic
      // kernel does the averaging — exactly what mosaic wants).
      .resize(downW, downH)
      // Second hop: scale back up with nearest-neighbor so the
      // blocks stay sharp-edged.
      .resize(extractWidth, extractHeight, { kernel: "nearest" })
      .png()
      .toBuffer();
  } else {
    // gaussian (default) — soft Gaussian blur. Sigma proportional to
    // the rect's short side so the blur amount looks similar
    // regardless of the rect's size. Cap at 60 to keep the kernel
    // cost bounded.
    const rectShortSidePx = Math.min(widthPx, heightPx);
    const sigma = Math.min(60, Math.max(8, rectShortSidePx / 8));
    operatedBuf = await sharp(srcPath)
      .extract({
        left: extractLeft,
        top: extractTop,
        width: extractWidth,
        height: extractHeight
      })
      .blur(sigma)
      .png()
      .toBuffer();
  }

  if (rotation === 0) {
    // Unrotated — operated buffer IS the visible shape. No mask
    // step; output is byte-identical to the pre-rotation bake (the
    // AABB equals the rect for rotation 0, and extractLeft/Top/Width/
    // Height match the old `clamped` values).
    return { input: operatedBuf, top: extractTop, left: extractLeft };
  }

  // Rotated — mask the operated buffer with a rotated-rect SVG so
  // only the rect-shaped subset of the AABB ends up rendered. The
  // mask's coords are AABB-local: the rect's original top-left is
  // at `(leftPx - extractLeft, topPx - extractTop)`, and it's
  // rotated around its center (which is at `leftPx + widthPx/2 -
  // extractLeft, topPx + heightPx/2 - extractTop` in AABB-local
  // coords). `rotatedRectMaskSvg` handles the SVG transform.
  const maskBuf = rotatedRectMaskSvg({
    aabbWidth: extractWidth,
    aabbHeight: extractHeight,
    rectLocalLeft: leftPx - extractLeft,
    rectLocalTop: topPx - extractTop,
    rectWidth: widthPx,
    rectHeight: heightPx,
    rotation
  });
  const maskedBuf = await sharp(operatedBuf)
    .composite([{ input: maskBuf, blend: "dest-in" }])
    .png()
    .toBuffer();
  return { input: maskedBuf, top: extractTop, left: extractLeft };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── v2 reuse exports ────────────────────────────────────────────────
// The v2 tree-walking compositor (render/compose-tree.ts) reuses
// v1's SVG-rasterize discipline for arrow / rect / text / highlight /
// step shapes — the wire format is identical (VectorLayer.shape is
// the same Overlay discriminated union as OverlayRow.data). Exporting
// the helpers under explicit names keeps the v2 import surface small
// and the v1 internals private to this module.
export const rasterizeSvgForV2 = rasterize;
export const arrowSvgForV2 = arrowSvg;
export const rectSvgForV2 = rectSvg;
export const highlightSvgForV2 = highlightSvg;
/** Maps a highlight overlay row to the sharp composite `blend` option
 *  string. Used by the v2 vector compositor to keep the bake's blend
 *  behavior identical to v1's. */
export const highlightBlendModeForV2 = highlightBlendMode;
export const textSvgForV2 = textSvg;
/** Internal blur-layer builder, exported for unit tests so the bake
 *  paths for gaussian / pixelate / redact can be asserted in
 *  isolation without spinning up a full compose() pipeline. */
export const blurLayerForTests = blurLayer;
