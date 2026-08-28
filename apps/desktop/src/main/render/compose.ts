// Overlay-shape SVG generators + pixel-accurate rasterizer, shared
// with the v2 tree-walking compositor (render/compose-tree-vector.ts).
//
// This module USED to host the v1 linear compositor (`compose()`)
// alongside these SVG helpers. The v1 read/write path has been
// retired — every capture is a v2 layer-tree bundle — so the linear
// compositor, its blur-region extractor, and the overlays-table read
// are gone. What remains is the SVG-generation + rasterize discipline
// that v2 reuses verbatim: the wire format is identical (a
// VectorLayer.shape IS the same Overlay discriminated union as the
// old OverlayRow.data).
//
// Each `*Svg` function takes an overlay's `data` blob + the canvas
// pixel dimensions and returns an SVG string sized to exactly
// `imageWidthPx × imageHeightPx`. `rasterize` turns that SVG into a
// raw-RGBA sharp composite layer with explicit dimensions so sharp's
// `composite` never rejects it for being larger than the base image.

import sharp, { type OverlayOptions } from "sharp";
import type { ArrowEndStyle, OverlayRow } from "@pwrsnap/shared";
import {
  computeArrowGeometry,
  computeStemDashArray,
  outlineHaloColor,
  outlineSolidStrokeHex,
  outlineStripeDashArray,
  outlineStripeDashArrayForStemDash,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle,
  readHighlightBlend,
  readHighlightColor,
  readHighlightOpacity,
  readOverlayOutline,
  readOverlayRotation,
  readOverlayThickness,
  readShapeFilled,
  readShapeKind,
  readShapeSkewDeg,
  readTextOverlayOutline,
  readTextWeight,
  shapeAutoStrokeWidthPx
} from "@pwrsnap/shared";

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
 *
 * Exposed via `rasterizeSvgForV2` (re-exported below) so the v2
 * tree-walking compositor in compose-tree-vector.ts can reuse the
 * same pixel-accurate raw-RGBA produce-composite-layer discipline.
 */
async function rasterize(svg: string, width: number, height: number): Promise<OverlayOptions> {
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
  // Contrast border (outline) under the colored glyph. Legacy rows —
  // no `outline` field — resolve to the historical always-white halo
  // and must bake byte-identically; the new modes swap the color,
  // stripe it, or drop it. The width formula is unchanged in every
  // mode (no independent border sizing by design).
  const outlineWidth = Math.max(1.5, strokeWidthPx * 0.25);
  const resolvedOutline = readOverlayOutline(data, "white");
  const haloColor = outlineHaloColor(resolvedOutline);

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

  // Stripe: black dash pattern painted over the (solid-or-stem-dashed)
  // white halo. On dashed / dotted stems the black phase splits each
  // stem dash in half so black never lands in a stem gap; the head
  // glyphs use the plain halo-width-scaled pattern.
  const haloWidthPx = strokeWidthPx + outlineWidth * 2;
  const headStripeDash =
    resolvedOutline.kind === "stripe" ? outlineStripeDashArray(haloWidthPx) : null;
  const stemStripe =
    resolvedOutline.kind !== "stripe"
      ? null
      : stemDashRaw !== null
        ? outlineStripeDashArrayForStemDash(stemDashRaw)
        : { dasharray: outlineStripeDashArray(haloWidthPx), dashoffset: 0 };

  const hasOutline = resolvedOutline.kind !== "none";
  const halo = hasOutline
    ? arrowHeadHaloSvg(endStyle, headGeom, imageWidthPx, imageHeightPx, outlineWidth, strokeWidthPx, haloColor, headStripeDash)
    : "";
  const head = arrowHeadSvg(endStyle, headGeom, imageWidthPx, imageHeightPx, strokeWidthPx, fillColor);
  const haloTail = tailGeom !== null && hasOutline
    ? arrowHeadHaloSvg(endStyle, tailGeom, imageWidthPx, imageHeightPx, outlineWidth, strokeWidthPx, haloColor, headStripeDash)
    : "";
  const headTail = tailGeom !== null
    ? arrowHeadSvg(endStyle, tailGeom, imageWidthPx, imageHeightPx, strokeWidthPx, fillColor)
    : "";

  // Stem halo — same two-line layout the pre-outline template used so
  // legacy rows (haloColor="white", no stripe) emit byte-identical SVG.
  const stemHalo = !hasOutline
    ? ""
    : `<line x1="${stemEndAtFrom.x}" y1="${stemEndAtFrom.y}" x2="${stemEndAtTo.x}" y2="${stemEndAtTo.y}"
          stroke="${haloColor}" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round"${stemDashAttr} fill="none" />` +
      (stemStripe === null
        ? ""
        : `
    <line x1="${stemEndAtFrom.x}" y1="${stemEndAtFrom.y}" x2="${stemEndAtTo.x}" y2="${stemEndAtTo.y}"
          stroke="black" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round" stroke-dasharray="${stemStripe.dasharray}"${stemStripe.dashoffset !== 0 ? ` stroke-dashoffset="${stemStripe.dashoffset}"` : ""} fill="none" />`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round">
    ${stemHalo}
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
  strokeWidthPx: number,
  /** Border color for the halo pass. Legacy rows resolve to "white"
   *  and must emit byte-identical SVG to the pre-outline template. */
  haloColor: string,
  /** Non-null for striped borders: a black twin of the halo element
   *  is appended with this dash pattern; the colored glyph on top
   *  leaves only the outline band showing the alternation. */
  stripeDash: string | null
): string {
  const toPx = pxOf(geom.to, imageWidthPx, imageHeightPx);
  const baseLeftPx = pxOf(geom.baseLeft, imageWidthPx, imageHeightPx);
  const baseRightPx = pxOf(geom.baseRight, imageWidthPx, imageHeightPx);
  switch (style) {
    case "filled-triangle": {
      // Filled head: interior is colored, halo only needs to peek
      // at the rim. Solid fill works because the colored polygon
      // on top covers everything but the rim.
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      const base = `<polygon points="${polygon}" fill="${haloColor}" stroke="${haloColor}" stroke-width="${outlineWidth * 2}" stroke-linejoin="round" />`;
      if (stripeDash === null) return base;
      return `${base}
    <polygon points="${polygon}" fill="none" stroke="black" stroke-width="${outlineWidth * 2}" stroke-linejoin="round" stroke-dasharray="${stripeDash}" />`;
    }
    case "open-triangle": {
      // Hollow head: interior must stay transparent. fill="none" +
      // wider stroke so the halo peeks `outlineWidth` past the
      // colored stroke on BOTH sides (outside edge for legibility
      // against the background, inside edge for legibility against
      // whatever shows through the hollow). Mirrors the live editor's
      // ArrowHeadHalo open-triangle case — keep in sync.
      const polygon = `${toPx.x},${toPx.y} ${baseLeftPx.x},${baseLeftPx.y} ${baseRightPx.x},${baseRightPx.y}`;
      const base = `<polygon points="${polygon}" fill="none" stroke="${haloColor}" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linejoin="round" />`;
      if (stripeDash === null) return base;
      return `${base}
    <polygon points="${polygon}" fill="none" stroke="black" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linejoin="round" stroke-dasharray="${stripeDash}" />`;
    }
    case "line": {
      const base = `<line x1="${baseLeftPx.x}" y1="${baseLeftPx.y}" x2="${baseRightPx.x}" y2="${baseRightPx.y}" stroke="${haloColor}" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round" />`;
      if (stripeDash === null) return base;
      return `${base}
    <line x1="${baseLeftPx.x}" y1="${baseLeftPx.y}" x2="${baseRightPx.x}" y2="${baseRightPx.y}" stroke="black" stroke-width="${strokeWidthPx + outlineWidth * 2}" stroke-linecap="round" stroke-dasharray="${stripeDash}" />`;
    }
    case "dot": {
      const r = strokeWidthPx * 1.5;
      const base = `<circle cx="${toPx.x}" cy="${toPx.y}" r="${r + outlineWidth}" fill="${haloColor}" stroke="${haloColor}" stroke-width="${outlineWidth * 2}" />`;
      if (stripeDash === null) return base;
      return `${base}
    <circle cx="${toPx.x}" cy="${toPx.y}" r="${r + outlineWidth}" fill="none" stroke="black" stroke-width="${outlineWidth * 2}" stroke-dasharray="${stripeDash}" />`;
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

/* ----------------------------- Shape ---------------------------- */

function shapeSvg(
  data: Extract<OverlayRow["data"], { kind: "shape" }>,
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
  const filled = readShapeFilled(data);
  const shape = readShapeKind(data);
  // Contrast border resolution — legacy stroked shapes keep the
  // always-white halo (byte-identical emit); legacy filled shapes
  // keep no rim. See `readOverlayOutline` in @pwrsnap/shared.
  const resolvedOutline = readOverlayOutline(data, "white");
  const haloColor = outlineHaloColor(resolvedOutline);
  // Rotation transform — same convention as ShapeGlyph (live editor):
  // SVG `rotate(deg cx cy)` in pixel-space with cx/cy at the bbox
  // geometric center. `transform` is omitted entirely when rotation
  // is 0, so existing unrotated rows bake byte-identical to before.
  const rotateDeg = (readOverlayRotation(data) * 180) / Math.PI;
  const cx = xPx + wPx / 2;
  const cy = yPx + hPx / 2;
  const groupTransform =
    rotateDeg !== 0 ? ` transform="rotate(${rotateDeg} ${cx} ${cy})"` : "";

  // Per-shape primitive emitters. Stroke + halo branches share the
  // same primitive choice so editor preview = baked output for every
  // shape kind.
  function strokedPrimitive(
    stroke: string,
    strokeWidth: number,
    dasharray: string | null = null
  ): string {
    // Empty for solid strokes so legacy rows emit byte-identical SVG.
    const dashAttr = dasharray === null ? "" : ` stroke-dasharray="${dasharray}"`;
    switch (shape) {
      case "circle":
      case "oval":
        return `<ellipse cx="${cx}" cy="${cy}" rx="${wPx / 2}" ry="${hPx / 2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashAttr} />`;
      case "parallelogram": {
        const skewRad = (readShapeSkewDeg(data) * Math.PI) / 180;
        const shearPx = (hPx / 2) * Math.tan(skewRad);
        const xL = xPx;
        const xR = xPx + wPx;
        const yT = yPx;
        const yB = yPx + hPx;
        const points =
          `${xL + shearPx},${yT} ${xR + shearPx},${yT} ${xR - shearPx},${yB} ${xL - shearPx},${yB}`;
        return `<polygon points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashAttr} />`;
      }
      case "rect":
      case "square":
      default:
        return `<rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashAttr} />`;
    }
  }

  function filledPrimitive(): string {
    switch (shape) {
      case "circle":
      case "oval":
        return `<ellipse cx="${cx}" cy="${cy}" rx="${wPx / 2}" ry="${hPx / 2}" fill="${fillColor}" />`;
      case "parallelogram": {
        const skewRad = (readShapeSkewDeg(data) * Math.PI) / 180;
        const shearPx = (hPx / 2) * Math.tan(skewRad);
        const xL = xPx;
        const xR = xPx + wPx;
        const yT = yPx;
        const yB = yPx + hPx;
        const points =
          `${xL + shearPx},${yT} ${xR + shearPx},${yT} ${xR - shearPx},${yB} ${xL - shearPx},${yB}`;
        return `<polygon points="${points}" fill="${fillColor}" />`;
      }
      case "rect":
      case "square":
      default:
        return `<rect x="${xPx}" y="${yPx}" width="${wPx}" height="${hPx}" fill="${fillColor}" />`;
    }
  }

  if (filled) {
    // Solid fill. Legacy rows (and Border = Off) draw the bare
    // primitive — a same-color halo would just expand the fill without
    // adding contrast. The explicit border modes draw a contrast RIM
    // under the fill: a centered stroke of 2×rim width, whose inner
    // half the fill covers — the same reach as a stroked shape's halo.
    //
    // The rim sizes itself from the EDITOR's stroke band
    // (shapeAutoStrokeWidthPx via readOverlayThickness), NOT this
    // file's legacy clamp band above: a filled shape draws no stroke
    // in the bake, so nothing forces the two bands to agree here, and
    // using the editor band is what makes the exported rim match the
    // preview pixel-for-pixel. (The stroked path keeps the legacy
    // band — its bytes predate this feature.)
    const rimStrokeWidthPx = readOverlayThickness(
      data.thickness,
      shapeAutoStrokeWidthPx(shortSidePx),
      shortSidePx
    );
    const rimPx = Math.max(1.5, rimStrokeWidthPx * 0.25);
    const rim =
      resolvedOutline.kind === "legacy" || resolvedOutline.kind === "none"
        ? ""
        : resolvedOutline.kind === "stripe"
          ? `${strokedPrimitive("white", rimPx * 2)}
    ${strokedPrimitive("black", rimPx * 2, outlineStripeDashArray(rimPx * 2))}
    `
          : `${strokedPrimitive(haloColor, rimPx * 2)}
    `;
    // Round joins only when a rim is painted — the legacy filled emit
    // (`<g${groupTransform}>`, no stroke anywhere) must stay
    // byte-identical.
    const rimJoin = rim === "" ? "" : ` stroke-linejoin="round"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g${rimJoin}${groupTransform}>
    ${rim}${filledPrimitive()}
  </g>
</svg>`;
  }

  if (resolvedOutline.kind === "none") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round"${groupTransform}>
    ${strokedPrimitive(fillColor, strokeWidthPx)}
  </g>
</svg>`;
  }

  const stripeDash =
    resolvedOutline.kind === "stripe"
      ? outlineStripeDashArray(strokeWidthPx + outlinePx * 2)
      : null;
  const stripeHalo =
    stripeDash === null
      ? ""
      : `${strokedPrimitive("black", strokeWidthPx + outlinePx * 2, stripeDash)}
    `;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  <g stroke-linejoin="round"${groupTransform}>
    ${strokedPrimitive(haloColor, strokeWidthPx + outlinePx * 2)}
    ${stripeHalo}${strokedPrimitive(fillColor, strokeWidthPx)}
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
  // `case "highlight"` branch in the v2 vector compositor.
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
   *  Callers that don't have source dims at hand can omit these args;
   *  the function falls back to canvas shortSide, matching the
   *  pre-#110-bake behavior. */
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
  // editor's click-to-center UX). The renderer (TextGlyph) does the
  // same. xml-escape each line so user input can't break out of the
  // SVG.
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
  // Contrast border → glyph stroke. Legacy rows keep the historical
  // translucent rgba(0,0,0,0.7) (byte-identical attrs); the solid
  // modes swap the color; "none" drops the stroke block entirely.
  // Stripe is coerced to solid black by readTextOverlayOutline.
  const resolvedOutline = readTextOverlayOutline(data);
  const strokeColor =
    resolvedOutline.kind === "legacy"
      ? "rgba(0,0,0,0.7)"
      : outlineSolidStrokeHex(resolvedOutline);
  const strokeAttrs =
    strokeColor === null
      ? ""
      : `
        stroke="${strokeColor}"
        stroke-width="${fontSizePx * 0.08}"
        paint-order="stroke"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidthPx}" height="${imageHeightPx}" viewBox="0 0 ${imageWidthPx} ${imageHeightPx}">
  ${textOpenG}<text x="${xPx}" y="${yPx}"
        font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSizePx}"
        font-weight="${fontWeight}"
        fill="${accent}"${strokeAttrs}
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ── v2 reuse exports ────────────────────────────────────────────────
// The v2 tree-walking compositor (render/compose-tree-vector.ts)
// reuses the SVG-rasterize discipline for arrow / rect / text /
// highlight / step shapes — the wire format is identical
// (VectorLayer.shape is the same Overlay discriminated union the
// retired v1 path used as OverlayRow.data). Exporting the helpers
// under explicit names keeps the v2 import surface small and the
// generators private to this module.
export const rasterizeSvgForV2 = rasterize;
export const arrowSvgForV2 = arrowSvg;
export const shapeSvgForV2 = shapeSvg;
export const highlightSvgForV2 = highlightSvg;
/** Maps a highlight overlay row to the sharp composite `blend` option
 *  string. Used by the v2 vector compositor to keep the bake's blend
 *  behavior identical to the retired v1 path's. */
export const highlightBlendModeForV2 = highlightBlendMode;
export const textSvgForV2 = textSvg;
