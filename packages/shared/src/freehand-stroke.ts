// Freehand Draw strokes — pen, marker, spray — and the eraser that cuts
// them. The single source of truth for what a `stroke` overlay paints.
//
// The live editor (OverlaySvg's StrokeGlyph) and the bake
// (compose.ts `strokeSvg`) both call `strokeGeometry` on the same row in
// the same coordinate space — CANVAS pixels, the space the editor's
// viewBox and an unscaled bake share — so the two cannot disagree about
// a path, a width or a single spray dot. The bake draws at render scale
// by wrapping the same geometry in a `scale()` group rather than
// re-deriving it at render resolution: spray dot counts depend on path
// LENGTH, and a length measured at 2× would scatter twice the dots.
//
// Nothing here reads a clock, a random source or the DOM. Spray "noise"
// is a seeded PRNG keyed by (row seed, segment index), which is what makes
// the dots deterministic across preview, export, reload and machines.

import { annotationStrokeWidthPx } from "./annotation-scale";
import {
  MAX_STROKE_POINTS,
  readOverlayThickness,
  type OverlayThickness,
  type StrokeOverlay,
  type StrokeTool
} from "./overlay-schemas";

/** A point in canvas pixels. */
export interface StrokePointPx {
  x: number;
  y: number;
}

/** Width of each tool relative to the stroke ladder at the same preset.
 *  A pen at Medium is exactly an arrow stem at Medium; a marker is wide
 *  enough to run under a line of UI text; a spray's width is its spread. */
export const STROKE_WIDTH_FACTORS: Readonly<Record<StrokeTool, number>> = {
  pen: 1,
  marker: 3,
  spray: 3
};

/** The marker's translucency. Low enough that text under it stays
 *  readable, high enough to read as a deliberate mark. */
export const DEFAULT_MARKER_OPACITY = 0.42;

/** Paint opacity a tool commits with when the row does not say. */
export function defaultStrokeOpacity(tool: StrokeTool): number {
  return tool === "marker" ? DEFAULT_MARKER_OPACITY : 1;
}

/** Resolve a row's opacity, falling back to the tool's default. */
export function readStrokeOpacity(data: {
  tool: StrokeTool;
  opacity?: number | undefined;
}): number {
  const raw = data.opacity;
  if (raw === undefined || !Number.isFinite(raw)) return defaultStrokeOpacity(data.tool);
  return Math.min(1, Math.max(0, raw));
}

/** Painted width of a stroke in canvas pixels. `basisPx` is
 *  `annotationBasisPx(sourceW, sourceH)` — SOURCE dims, as for every
 *  other annotation, so a crop never re-thins a stroke. "auto" is the
 *  Medium rung. */
export function strokeWidthPx(
  tool: StrokeTool,
  thickness: OverlayThickness | undefined,
  basisPx: number
): number {
  const base = readOverlayThickness(
    thickness,
    annotationStrokeWidthPx("medium", basisPx),
    basisPx
  );
  return base * STROKE_WIDTH_FACTORS[tool];
}

/** Eraser footprint radius in canvas pixels: half a marker at the same
 *  preset, so the eraser is as wide as the widest thing it cuts. */
export function eraserRadiusPx(
  thickness: OverlayThickness | undefined,
  basisPx: number
): number {
  return strokeWidthPx("marker", thickness, basisPx) / 2;
}

// ---- Coordinates ----------------------------------------------------

/** Normalized canvas fractions → canvas pixels. */
export function strokePointsToPx(
  points: readonly { x: number; y: number }[],
  canvasWidthPx: number,
  canvasHeightPx: number
): StrokePointPx[] {
  return points.map((p) => ({ x: p.x * canvasWidthPx, y: p.y * canvasHeightPx }));
}

/** Canvas pixels → normalized canvas fractions, rounded to 6 decimals
 *  (a ten-thousandth of a pixel on a 10k canvas) so rows stay compact. */
export function strokePointsToNormalized(
  points: readonly StrokePointPx[],
  canvasWidthPx: number,
  canvasHeightPx: number
): { x: number; y: number }[] {
  const w = canvasWidthPx > 0 ? canvasWidthPx : 1;
  const h = canvasHeightPx > 0 ? canvasHeightPx : 1;
  return points.map((p) => ({ x: round6(p.x / w), y: round6(p.y / h) }));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Normalized bounding box of a stroke's points (centerline only — no
 *  width). */
export function strokeBoundsN(points: readonly { x: number; y: number }[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Total centerline length in pixels. */
export function polylineLengthPx(points: readonly StrokePointPx[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** Shortest distance from `p` to the polyline, in pixels. A single
 *  point is its own polyline. Infinity for an empty one. */
export function distanceToPolylinePx(
  p: StrokePointPx,
  points: readonly StrokePointPx[]
): number {
  if (points.length === 0) return Infinity;
  if (points.length === 1) {
    const only = points[0]!;
    return Math.hypot(p.x - only.x, p.y - only.y);
  }
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const d = distanceToSegmentPx(p, points[i - 1]!, points[i]!);
    if (d < best) best = d;
  }
  return best;
}

function distanceToSegmentPx(p: StrokePointPx, a: StrokePointPx, b: StrokePointPx): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---- Smoothing ------------------------------------------------------

/**
 * Ramer–Douglas–Peucker simplification in pixel space. Drops points that
 * sit within `tolerancePx` of the line between their neighbours, which is
 * most of a pointer stream. Never drops the first or last point. A very
 * long scribble that still has more than `MAX_STROKE_POINTS` after that
 * is thinned evenly — it loses detail rather than failing to save.
 *
 * RDP is quadratic on input that will not simplify (a dense zig-zag), so
 * the input is evenly thinned to twice the cap first. A real pointer
 * stream never gets near that; the bound is for the one that does.
 */
export function simplifyStrokePoints(
  points: readonly StrokePointPx[],
  tolerancePx: number
): StrokePointPx[] {
  const deduped: StrokePointPx[] = [];
  for (const p of points) {
    const last = deduped[deduped.length - 1];
    if (last === undefined || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) {
      deduped.push(p);
    }
  }
  if (deduped.length <= 2) return deduped;
  const kept = rdp(thinEvenly(deduped, MAX_STROKE_POINTS * 2), Math.max(0, tolerancePx));
  return thinEvenly(kept, MAX_STROKE_POINTS);
}

/** Keep at most `max` points, evenly spaced by index, always including
 *  the first and last. */
function thinEvenly(points: readonly StrokePointPx[], max: number): StrokePointPx[] {
  if (points.length <= max) return [...points];
  const out: StrokePointPx[] = [];
  const last = points.length - 1;
  for (let k = 0; k < max; k += 1) {
    out.push(points[Math.round((k * last) / (max - 1))]!);
  }
  return out;
}

function rdp(points: readonly StrokePointPx[], tolerance: number): StrokePointPx[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = distanceToSegmentPx(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  const out: StrokePointPx[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i] === 1) out.push(points[i]!);
  }
  return out;
}

/** Two decimals — a hundredth of a pixel. Keeps the bake's SVG text
 *  stable and short; the editor uses the same string. */
function f(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * SVG path data for a smoothed centerline: quadratic Béziers through the
 * midpoints of consecutive points, with each point as the control. The
 * curve starts and ends exactly on the first and last points, and a
 * two-point stroke is a straight line.
 */
export function smoothStrokePathD(points: readonly StrokePointPx[]): string {
  const n = points.length;
  if (n === 0) return "";
  const first = points[0]!;
  if (n === 1) return `M${f(first.x)} ${f(first.y)}`;
  if (n === 2) {
    const last = points[1]!;
    return `M${f(first.x)} ${f(first.y)}L${f(last.x)} ${f(last.y)}`;
  }
  let d = `M${f(first.x)} ${f(first.y)}`;
  for (let i = 1; i < n - 1; i += 1) {
    const c = points[i]!;
    const next = points[i + 1]!;
    d += `Q${f(c.x)} ${f(c.y)} ${f((c.x + next.x) / 2)} ${f((c.y + next.y) / 2)}`;
  }
  const last = points[n - 1]!;
  d += `L${f(last.x)} ${f(last.y)}`;
  return d;
}

// ---- Spray ----------------------------------------------------------

/** Alpha of each dot class. Dots are grouped by class into one path per
 *  class, so a spray is three SVG elements however many dots it has. */
export const SPRAY_DOT_ALPHAS: readonly number[] = [0.35, 0.6, 0.85];

/** Dots per pixel of centerline, per pixel of spray radius. */
const SPRAY_DENSITY = 0.1;

/** Hard ceiling on dots per stroke. A screen-length XL spray lands around
 *  a third of this. */
export const MAX_SPRAY_DOTS = 40_000;

export interface SprayDot {
  x: number;
  y: number;
  r: number;
  /** Index into SPRAY_DOT_ALPHAS. */
  alpha: number;
}

/** mulberry32 — small, fast, and identical in every JS engine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One PRNG per (stroke seed, segment). Keying by the segment's index in
 *  the ORIGINAL stroke (`seedOffset + i`) is what lets an erased spray's
 *  surviving segments keep their exact dots. */
function segmentRng(seed: number, segmentIndex: number): () => number {
  return mulberry32((seed ^ Math.imul(segmentIndex + 1, 0x9e3779b1)) >>> 0);
}

/**
 * The dots a spray stroke paints, in canvas pixels. Pure function of
 * (points, width, seed, seedOffset): same row in, same dots out.
 *
 * Each segment scatters `length × radius × SPRAY_DENSITY` dots (the
 * fraction rounded by the segment's own PRNG) at uniform positions along
 * it, pushed off the centerline by a Gaussian of σ = 0.42 × radius and
 * kept inside the radius. A single-point spray (a tap) scatters as if it
 * were one radius long.
 */
export function sprayDots(
  points: readonly StrokePointPx[],
  widthPx: number,
  seed: number,
  seedOffset = 0
): SprayDot[] {
  const radius = Math.max(0.5, widthPx / 2);
  const dots: SprayDot[] = [];
  const perPx = radius * SPRAY_DENSITY;
  const scatter = (
    rng: () => number,
    a: StrokePointPx,
    b: StrokePointPx,
    lengthPx: number
  ): void => {
    const exact = lengthPx * perPx;
    const count = Math.floor(exact) + (rng() < exact - Math.floor(exact) ? 1 : 0);
    for (let k = 0; k < count && dots.length < MAX_SPRAY_DOTS; k += 1) {
      const t = rng();
      // Box–Muller radius, re-drawn until it lands inside the spray.
      let d = Infinity;
      for (let attempt = 0; attempt < 4 && d > radius; attempt += 1) {
        const u = Math.max(1e-9, rng());
        d = radius * 0.42 * Math.sqrt(-2 * Math.log(u));
      }
      if (d > radius) d = radius * rng();
      const angle = rng() * Math.PI * 2;
      const r = Math.max(0.5, radius * (0.025 + rng() * 0.05));
      const alpha = Math.min(SPRAY_DOT_ALPHAS.length - 1, Math.floor(rng() * SPRAY_DOT_ALPHAS.length));
      dots.push({
        x: a.x + (b.x - a.x) * t + Math.cos(angle) * d,
        y: a.y + (b.y - a.y) * t + Math.sin(angle) * d,
        r,
        alpha
      });
    }
  };
  if (points.length === 1) {
    const only = points[0]!;
    scatter(segmentRng(seed, seedOffset), only, only, radius);
    return dots;
  }
  for (let i = 1; i < points.length && dots.length < MAX_SPRAY_DOTS; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    scatter(segmentRng(seed, seedOffset + i - 1), a, b, Math.hypot(b.x - a.x, b.y - a.y));
  }
  return dots;
}

/** One path of circles per alpha class. */
function sprayPathsByAlpha(dots: readonly SprayDot[]): string[] {
  const parts: string[][] = SPRAY_DOT_ALPHAS.map(() => []);
  for (const dot of dots) {
    const r = dot.r;
    parts[dot.alpha]!.push(
      `M${f(dot.x - r)} ${f(dot.y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`
    );
  }
  return parts.map((p) => p.join(""));
}

// ---- What a stroke paints -------------------------------------------

export type StrokeGeometry =
  | {
      readonly kind: "path";
      readonly d: string;
      readonly widthPx: number;
      readonly cap: "round" | "butt";
      readonly opacity: number;
    }
  | {
      /** A tap with a pen or marker: no length to stroke, so it paints
       *  the cap it would have had — a disc for the pen, a square for the
       *  marker's flat tip. */
      readonly kind: "dot";
      readonly cx: number;
      readonly cy: number;
      readonly widthPx: number;
      readonly square: boolean;
      readonly opacity: number;
    }
  | {
      readonly kind: "spray";
      readonly layers: readonly { readonly opacity: number; readonly d: string }[];
    };

/**
 * Everything needed to paint `data` on a canvas of
 * `canvasWidthPx × canvasHeightPx`, in canvas pixels. `basisPx` is the
 * capture's SOURCE-derived `annotationBasisPx`.
 */
export function strokeGeometry(
  data: Pick<StrokeOverlay, "tool" | "points" | "thickness" | "opacity" | "seed" | "seedOffset">,
  canvasWidthPx: number,
  canvasHeightPx: number,
  basisPx: number
): StrokeGeometry {
  const px = strokePointsToPx(data.points, canvasWidthPx, canvasHeightPx);
  const widthPx = strokeWidthPx(data.tool, data.thickness, basisPx);
  const opacity = readStrokeOpacity(data);
  if (data.tool === "spray") {
    const dots = sprayDots(px, widthPx, data.seed ?? 0, data.seedOffset ?? 0);
    const paths = sprayPathsByAlpha(dots);
    return {
      kind: "spray",
      layers: SPRAY_DOT_ALPHAS.map((alpha, i) => ({
        opacity: alpha * opacity,
        d: paths[i] ?? ""
      })).filter((layer) => layer.d !== "")
    };
  }
  if (px.length === 1 || polylineLengthPx(px) < 0.01) {
    const only = px[0]!;
    return {
      kind: "dot",
      cx: only.x,
      cy: only.y,
      widthPx,
      square: data.tool === "marker",
      opacity
    };
  }
  return {
    kind: "path",
    d: smoothStrokePathD(px),
    widthPx,
    cap: data.tool === "marker" ? "butt" : "round",
    opacity
  };
}

/** The SVG elements for a stroke, as a string — the bake's half of the
 *  WYSIWYG pair. `paint` is a resolved color (never "auto"). The editor
 *  renders the same `strokeGeometry` as JSX. */
export function strokeSvgElements(geometry: StrokeGeometry, paint: string): string {
  switch (geometry.kind) {
    case "path":
      return (
        `<path d="${geometry.d}" fill="none" stroke="${paint}" ` +
        `stroke-width="${f(geometry.widthPx)}" stroke-linecap="${geometry.cap}" ` +
        `stroke-linejoin="round" opacity="${geometry.opacity}"/>`
      );
    case "dot": {
      const half = geometry.widthPx / 2;
      return geometry.square
        ? `<rect x="${f(geometry.cx - half)}" y="${f(geometry.cy - half)}" ` +
            `width="${f(geometry.widthPx)}" height="${f(geometry.widthPx)}" ` +
            `fill="${paint}" opacity="${geometry.opacity}"/>`
        : `<circle cx="${f(geometry.cx)}" cy="${f(geometry.cy)}" r="${f(half)}" ` +
            `fill="${paint}" opacity="${geometry.opacity}"/>`;
    }
    case "spray":
      return geometry.layers
        .map((layer) => `<path d="${layer.d}" fill="${paint}" opacity="${layer.opacity}"/>`)
        .join("");
  }
}

/** How far a stroke's paint reaches past its centerline, in pixels — the
 *  half-width every outline, hit-test and body box pads by. */
export function strokeReachPx(
  data: Pick<StrokeOverlay, "tool" | "thickness">,
  basisPx: number
): number {
  return strokeWidthPx(data.tool, data.thickness, basisPx) / 2;
}

// ---- The eraser -----------------------------------------------------

/** A run of a stroke the eraser left behind. `seedOffset` is the index,
 *  in the stroke it came from, of the segment the run starts on. */
export interface StrokePiece {
  points: StrokePointPx[];
  seedOffset: number;
}

/**
 * Cut a stroke where an eraser passed over it.
 *
 * The eraser is a polyline swept by a disc of `radiusPx` (callers add the
 * stroke's own half-width, so grazing the edge of a wide marker cuts it).
 * The stroke is walked in steps no longer than a quarter of the radius;
 * every step inside the swept area is removed, and what is left comes
 * back as separate runs.
 *
 * The runs keep the stroke's own vertices — only the two points at each
 * cut are new — and each run records which original segment it starts
 * on. Together those keep the dots of a spray's WHOLE surviving segments
 * where they were: its dots are keyed by original segment index (see
 * `sprayDots`). The segment a cut lands in is shorter afterwards, so its
 * remainder is re-scattered — dots next to a cut move.
 *
 * Returns `null` when the eraser never touched the stroke (nothing to
 * change), and `[]` when it removed all of it. Runs shorter than
 * `minPieceLengthPx` are dropped: a crumb left at the edge of a cut is
 * not something the user meant to keep.
 */
export function eraseStroke(
  stroke: readonly StrokePointPx[],
  eraser: readonly StrokePointPx[],
  radiusPx: number,
  minPieceLengthPx = 1
): StrokePiece[] | null {
  if (stroke.length === 0 || eraser.length === 0) return null;
  const r = Math.max(0, radiusPx);
  const covered = (p: StrokePointPx): boolean => distanceToPolylinePx(p, eraser) <= r;

  // Cheap rejection: the stroke's bounds never come within `r` of the
  // eraser's.
  const sb = boundsPx(stroke);
  const eb = boundsPx(eraser);
  if (
    sb.maxX < eb.minX - r ||
    sb.minX > eb.maxX + r ||
    sb.maxY < eb.minY - r ||
    sb.minY > eb.maxY + r
  ) {
    return null;
  }

  if (stroke.length === 1) {
    return covered(stroke[0]!) ? [] : null;
  }

  const step = Math.max(0.25, r / 4);
  const pieces: StrokePiece[] = [];
  let current: StrokePointPx[] | null = null;
  let currentOffset = 0;
  let touched = false;
  let lastUncovered: StrokePointPx | null = null;
  const pushUnique = (run: StrokePointPx[], p: StrokePointPx): void => {
    const last = run[run.length - 1];
    if (last === undefined || last.x !== p.x || last.y !== p.y) run.push(p);
  };

  for (let i = 0; i < stroke.length - 1; i += 1) {
    const a = stroke[i]!;
    const b = stroke[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let j = i === 0 ? 0 : 1; j <= steps; j += 1) {
      const atVertex = j === 0 || j === steps;
      const q: StrokePointPx =
        j === 0 ? a : j === steps ? b : { x: a.x + ((b.x - a.x) * j) / steps, y: a.y + ((b.y - a.y) * j) / steps };
      if (covered(q)) {
        touched = true;
        if (current !== null) {
          if (lastUncovered !== null) pushUnique(current, lastUncovered);
          pieces.push({ points: current, seedOffset: currentOffset });
          current = null;
        }
        lastUncovered = null;
        continue;
      }
      if (current === null) {
        current = [q];
        // A run that starts ON the far vertex starts on the next segment.
        currentOffset = j === steps ? i + 1 : i;
      } else if (atVertex) {
        pushUnique(current, q);
      }
      lastUncovered = q;
    }
  }
  if (current !== null) {
    if (lastUncovered !== null) pushUnique(current, lastUncovered);
    pieces.push({ points: current, seedOffset: currentOffset });
  }
  if (!touched) return null;
  return pieces.filter(
    (piece) => piece.points.length > 1 && polylineLengthPx(piece.points) >= minPieceLengthPx
  );
}

/** How far the simplified eraser path may stray from the pointer path,
 *  in canvas pixels — a fraction of any eraser's radius, so the cut is
 *  unchanged to the eye. */
const ERASER_SIMPLIFY_TOLERANCE_PX = 0.5;

/** The eraser drag as the polyline `eraseStroke` sweeps, in canvas
 *  pixels. A drag is a raw pointer stream — hundreds of samples a second
 *  — and every sample of every stroke is measured against every segment
 *  of it, so it is simplified first. */
export function eraserPathPx(
  points: readonly { x: number; y: number }[],
  canvasWidthPx: number,
  canvasHeightPx: number
): StrokePointPx[] {
  return simplifyStrokePoints(
    strokePointsToPx(points, canvasWidthPx, canvasHeightPx),
    ERASER_SIMPLIFY_TOLERANCE_PX
  );
}

/**
 * Cut a stroke ROW where an eraser passed: the strokes that replace it,
 * in the same normalized canvas space, or `null` when the eraser never
 * touched it (`[]` when it took all of it). The editor's live preview
 * and its commit both call this, so what the drag shows is what the
 * release writes.
 *
 * `eraserRadiusPx` is the eraser's own radius; the stroke's painted
 * reach is added here, so grazing the edge of a wide marker cuts it.
 * Each spray piece records where it starts in the original stroke
 * (`seedOffset`), so its whole surviving segments keep their dots.
 */
export function eraseStrokeOverlay(
  data: StrokeOverlay,
  eraserPx: readonly StrokePointPx[],
  eraserRadiusPx: number,
  canvasWidthPx: number,
  canvasHeightPx: number,
  basisPx: number
): StrokeOverlay[] | null {
  const pieces = eraseStroke(
    strokePointsToPx(data.points, canvasWidthPx, canvasHeightPx),
    eraserPx,
    eraserRadiusPx + strokeReachPx(data, basisPx)
  );
  if (pieces === null) return null;
  return pieces.map((piece) => ({
    ...data,
    points: strokePointsToNormalized(piece.points, canvasWidthPx, canvasHeightPx),
    ...(data.tool === "spray" ? { seedOffset: (data.seedOffset ?? 0) + piece.seedOffset } : {})
  }));
}

function boundsPx(points: readonly StrokePointPx[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}
