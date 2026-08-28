// Auto contrast-border sampling spec — the single source of truth for
// HOW `outline: "auto"` picks black vs white.
//
// The editor is the only surface that actually samples pixels: it
// resolves Auto at placement / move time and PERSISTS the pick in the
// row's `outlineAuto` field. The bake then reads the stored pick via
// `readOverlayOutline` and never touches pixels — that's what keeps
// the render cache deterministic (hash of row data + source, no
// sampling in main) and makes preview = export by construction.
//
// This module is environment-agnostic (no DOM, no Node): it generates
// WHERE to sample (normalized points along the border's own path) and
// decides WHAT the samples mean (median luminance vs threshold). The
// renderer-side `outline-auto-sampler.ts` owns the actual pixel reads.

import { computeTextGlyphSize } from "./text-glyph-size";
import type { Overlay } from "./overlay-schemas";
import type { OverlayOutlineAutoColor } from "./overlay-schemas";

/** Cap on sample points per decision. 100 keeps the work trivial
 *  (one downscaled ImageData lookup per point) while being dense
 *  enough that a long arrow crossing one odd UI element can't skew
 *  the median. */
export const OUTLINE_AUTO_SAMPLE_COUNT = 100;

/** Median-luma cutoff (0–255, BT.601): above = "light background" →
 *  black border; at/below → white border. 160 rather than 128 keeps
 *  mid-gray UI chrome (#999 ≈ 153) on the white halo the app has
 *  always drawn there — black only wins on genuinely light pages,
 *  which is the case the fixed white halo actually fails on. */
export const OUTLINE_AUTO_LUMA_THRESHOLD = 160;

/** BT.601 luma in the samples' own 0–255 range. */
export function outlineAutoLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Median-based black/white decision. Median, not mean — one bright
 *  window crossed by an arrow that mostly sits on dark chrome must
 *  not flip the pick. Empty input resolves to "white" (the historical
 *  halo) so callers with no readable pixels degrade to legacy. */
export function decideOutlineAutoColor(
  lumas: readonly number[]
): OverlayOutlineAutoColor {
  if (lumas.length === 0) return "white";
  const sorted = [...lumas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
  return median > OUTLINE_AUTO_LUMA_THRESHOLD ? "black" : "white";
}

export interface OutlineSampleDims {
  canvasWidthPx: number;
  canvasHeightPx: number;
  /** Source raster natural dims — only consulted for text (bucket →
   *  sizePx fallback when the row has no stored sizePx). Omitted →
   *  canvas dims, matching `textSvgForV2`'s fallback. */
  sourceWidthPx?: number | undefined;
  sourceHeightPx?: number | undefined;
}

export interface NormalizedSamplePoint {
  xn: number;
  yn: number;
}

/** Evenly spaced points along a segment, endpoints included. */
export function outlineSamplePointsForSegment(
  from: { x: number; y: number },
  to: { x: number; y: number },
  count: number = OUTLINE_AUTO_SAMPLE_COUNT
): NormalizedSamplePoint[] {
  const n = Math.max(2, Math.floor(count));
  const points: NormalizedSamplePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    points.push({
      xn: from.x + (to.x - from.x) * t,
      yn: from.y + (to.y - from.y) * t
    });
  }
  return points;
}

/** Evenly spaced points around a rect's perimeter — uniform in PIXEL
 *  space (needs canvas dims: normalized x/y aren't isotropic), so a
 *  wide flat rect doesn't oversample its short edges. Rotation is
 *  deliberately ignored: the unrotated bbox ring covers essentially
 *  the same background region and keeps the spec trivial. */
export function outlineSamplePointsForRectPerimeter(
  rect: { x: number; y: number; w: number; h: number },
  dims: OutlineSampleDims,
  count: number = OUTLINE_AUTO_SAMPLE_COUNT
): NormalizedSamplePoint[] {
  const wPx = Math.abs(rect.w) * dims.canvasWidthPx;
  const hPx = Math.abs(rect.h) * dims.canvasHeightPx;
  const perimeterPx = 2 * (wPx + hPx);
  if (!(perimeterPx > 0)) {
    return [{ xn: rect.x, yn: rect.y }];
  }
  const n = Math.max(4, Math.floor(count));
  const points: NormalizedSamplePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    let d = (perimeterPx * i) / n;
    let xPx: number;
    let yPx: number;
    if (d < wPx) {
      xPx = d;
      yPx = 0;
    } else if (d < wPx + hPx) {
      d -= wPx;
      xPx = wPx;
      yPx = d;
    } else if (d < wPx + hPx + wPx) {
      d -= wPx + hPx;
      xPx = wPx - d;
      yPx = hPx;
    } else {
      d -= wPx + hPx + wPx;
      xPx = 0;
      yPx = hPx - d;
    }
    points.push({
      xn: rect.x + xPx / dims.canvasWidthPx,
      yn: rect.y + yPx / dims.canvasHeightPx
    });
  }
  return points;
}

// Text body-box estimate constants (charAdvance 0.55, 1.2em line
// spacing). The estimate only feeds background SAMPLING, so metric
// drift vs the real laid-out glyph is tolerable. The box is centered
// VERTICALLY on the anchor to match what is actually painted: both
// text surfaces (TextHtml display and the HTML bake, via
// computeTextHtmlStyle's `translateY(-50%)` wrapper) center the FULL
// multi-line block on the anchor — not the first line, which is the
// legacy SVG-fallback convention. Sampling with the first-line model
// displaced a multi-line ring ~(N−1)·fontPx·0.6 below the glyph.
const TEXT_SAMPLE_CHAR_ADVANCE = 0.55;
const TEXT_SAMPLE_LINE_HEIGHT = 1.2;

/** Where to sample for a given overlay's border. Arrow: along the
 *  stem (from → to). Shape / highlight: the rect perimeter. Text: the
 *  estimated body-box perimeter. Returns null for kinds that carry no
 *  outline (blur / step / crop). */
export function outlineSamplePointsForOverlay(
  data: Overlay,
  dims: OutlineSampleDims,
  count: number = OUTLINE_AUTO_SAMPLE_COUNT
): NormalizedSamplePoint[] | null {
  if (data.kind === "arrow") {
    return outlineSamplePointsForSegment(data.from, data.to, count);
  }
  if (data.kind === "shape" || data.kind === "highlight") {
    return outlineSamplePointsForRectPerimeter(data.rect, dims, count);
  }
  if (data.kind === "text") {
    const { sizePx } = computeTextGlyphSize({
      size: data.size,
      sourceWidthPx: dims.sourceWidthPx ?? dims.canvasWidthPx,
      sourceHeightPx: dims.sourceHeightPx ?? dims.canvasHeightPx,
      canvasWidthPx: dims.canvasWidthPx,
      canvasHeightPx: dims.canvasHeightPx,
      storedSizePx: data.sizePx
    });
    const lines = data.body.length === 0 ? [""] : data.body.split("\n");
    const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 1);
    const widthPx = maxChars * sizePx * TEXT_SAMPLE_CHAR_ADVANCE;
    const heightPx =
      sizePx * (lines.length * TEXT_SAMPLE_LINE_HEIGHT - (TEXT_SAMPLE_LINE_HEIGHT - 1));
    const xPx = data.point.x * dims.canvasWidthPx;
    // Full-block vertical centering (see the constants comment above).
    // Single-line output is unchanged: heightPx === sizePx there, so
    // top = anchor − sizePx/2 either way.
    const topPx = data.point.y * dims.canvasHeightPx - heightPx / 2;
    return outlineSamplePointsForRectPerimeter(
      {
        x: xPx / dims.canvasWidthPx,
        y: topPx / dims.canvasHeightPx,
        w: widthPx / dims.canvasWidthPx,
        h: heightPx / dims.canvasHeightPx
      },
      dims,
      count
    );
  }
  return null;
}
