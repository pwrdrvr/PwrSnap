// Freehand Draw strokes — pen, marker, airbrush — and the eraser that
// cuts them. The single source of truth for what a `stroke` overlay paints.
//
// The live editor (OverlaySvg's StrokeGlyph) and the bake
// (compose.ts `strokeSvg`) both call `strokeGeometry` on the same row in
// the same coordinate space — CANVAS pixels, the space the editor's
// viewBox and an unscaled bake share — so the two cannot disagree about
// a path or a width. The bake draws at render scale by wrapping the same
// geometry in a `scale()` group.
//
// Every tool is a path. The airbrush's soft edge is the same path drawn
// as a few nested bands, not a filter or a scatter of dots: the bands
// rasterize identically in Chromium and in the bake, cost a handful of
// SVG elements however long the stroke is, and an eraser cut ends one
// cleanly, as it ends a pen line. Nothing here reads a clock, a random
// source or the DOM.

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
 *  enough to run under a line of UI text; an airbrush's width is its
 *  outermost, faintest band. */
export const STROKE_WIDTH_FACTORS: Readonly<Record<StrokeTool, number>> = {
  pen: 1,
  marker: 3,
  airbrush: 3
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
  return smoothStrokeSpanD(points, n, 1, n - 2, true);
}

/**
 * Part of `smoothStrokePathD` over the first `count` of `points`: its
 * curve sections `from` through `to` (1 ≤ from ≤ to ≤ count − 2), plus
 * the closing straight run to the last point when `withEnd` is set.
 * Section i is the Bézier with point i as its control, and it is fixed
 * once point i + 1 exists, so a live stroke can keep the spans it has
 * already drawn and rebuild only its tail. `scaleX` / `scaleY` map the
 * points into pixels on the way (1 when they already are).
 *
 * Spans [1, k] and [k + 1, count − 2] + end, concatenated, draw exactly
 * the curve the whole path draws.
 */
export function smoothStrokeSpanD(
  points: readonly { x: number; y: number }[],
  count: number,
  from: number,
  to: number,
  withEnd: boolean,
  scaleX = 1,
  scaleY = 1
): string {
  const x = (i: number): number => points[i]!.x * scaleX;
  const y = (i: number): number => points[i]!.y * scaleY;
  let d =
    from === 1
      ? `M${f(x(0))} ${f(y(0))}`
      : `M${f((x(from - 1) + x(from)) / 2)} ${f((y(from - 1) + y(from)) / 2)}`;
  for (let i = from; i <= to; i += 1) {
    d += `Q${f(x(i))} ${f(y(i))} ${f((x(i) + x(i + 1)) / 2)} ${f((y(i) + y(i + 1)) / 2)}`;
  }
  if (withEnd) d += `L${f(x(count - 1))} ${f(y(count - 1))}`;
  return d;
}

// ---- Airbrush ------------------------------------------------------

/** Coverage the airbrush's band stack reaches, from the rim inward. The
 *  last entry is the solid core. */
const AIRBRUSH_RAMP: readonly number[] = [0.15, 0.35, 0.55, 0.75, 1];

/** Each band's width as a fraction of the stroke's full width, outermost
 *  first. The middle 60% is solid; the fade is the outer 20% each side. */
const AIRBRUSH_WIDTH_FACTORS: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6];

/**
 * The airbrush's bands, outermost (widest, faintest) first. Each band's
 * alpha is the one that takes the stack's composite from the coverage
 * outside it to `AIRBRUSH_RAMP` at its own edge — stacked same-color
 * layers compose as 1 − Π(1 − αᵢ) — so the edge ramps evenly to a solid
 * core instead of darkening in uneven steps.
 */
export const AIRBRUSH_BANDS: readonly { readonly widthFactor: number; readonly alpha: number }[] =
  AIRBRUSH_WIDTH_FACTORS.map((widthFactor, i) => {
    const outside = i === 0 ? 0 : AIRBRUSH_RAMP[i - 1]!;
    const alpha = 1 - (1 - AIRBRUSH_RAMP[i]!) / (1 - outside);
    return { widthFactor, alpha: Math.round(alpha * 1e4) / 1e4 };
  });

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
      /** The same centerline stroked once per band, round-capped, widest
       *  first; `opacity` applies to the whole stack. A tap is a stub
       *  0.01px long, which round caps paint as nested discs. */
      readonly kind: "airbrush";
      readonly d: string;
      readonly bands: readonly { readonly widthPx: number; readonly opacity: number }[];
      readonly opacity: number;
    };

/**
 * How a stroke is painted, apart from its path: width, cap, opacity, and
 * the airbrush's bands (empty for the other tools). `strokeGeometry`
 * and the editor's live long-stroke preview both read it, so the two
 * cannot paint a stroke differently.
 */
export function strokePaintStyle(
  data: Pick<StrokeOverlay, "tool" | "thickness" | "opacity">,
  basisPx: number
): {
  widthPx: number;
  cap: "round" | "butt";
  opacity: number;
  bands: readonly { readonly widthPx: number; readonly opacity: number }[];
} {
  const widthPx = strokeWidthPx(data.tool, data.thickness, basisPx);
  return {
    widthPx,
    // The marker's flat tip; the pen and the airbrush are round.
    cap: data.tool === "marker" ? "butt" : "round",
    opacity: readStrokeOpacity(data),
    bands:
      data.tool === "airbrush"
        ? AIRBRUSH_BANDS.map((band) => ({
            widthPx: widthPx * band.widthFactor,
            opacity: band.alpha
          }))
        : []
  };
}

/**
 * Everything needed to paint `data` on a canvas of
 * `canvasWidthPx × canvasHeightPx`, in canvas pixels. `basisPx` is the
 * capture's SOURCE-derived `annotationBasisPx`.
 */
export function strokeGeometry(
  data: Pick<StrokeOverlay, "tool" | "points" | "thickness" | "opacity">,
  canvasWidthPx: number,
  canvasHeightPx: number,
  basisPx: number
): StrokeGeometry {
  const px = strokePointsToPx(data.points, canvasWidthPx, canvasHeightPx);
  const { widthPx, cap, opacity, bands } = strokePaintStyle(data, basisPx);
  const isTap = px.length === 1 || polylineLengthPx(px) < 0.01;
  if (data.tool === "airbrush") {
    const first = px[0]!;
    return {
      kind: "airbrush",
      d: isTap ? `M${f(first.x)} ${f(first.y)}l0.01 0` : smoothStrokePathD(px),
      bands,
      opacity
    };
  }
  if (isTap) {
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
    cap,
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
    case "airbrush":
      return (
        `<g fill="none" stroke="${paint}" stroke-linecap="round" stroke-linejoin="round" ` +
        `opacity="${geometry.opacity}">` +
        geometry.bands
          .map(
            (band) =>
              `<path d="${geometry.d}" stroke-width="${f(band.widthPx)}" opacity="${band.opacity}"/>`
          )
          .join("") +
        `</g>`
      );
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
 * cut are new — so what survives is drawn exactly where it was.
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
): StrokePointPx[][] | null {
  if (stroke.length === 0 || eraser.length === 0) return null;
  const r = Math.max(0, radiusPx);
  const covered = (p: StrokePointPx): boolean => distanceToPolylinePx(p, eraser) <= r;

  // Cheap rejection: the stroke's bounds never come within `r` of the
  // eraser's.
  const eb = boundsPx(eraser);
  if (!boundsWithin(boundsPx(stroke), eb, r)) return null;

  if (stroke.length === 1) {
    return covered(stroke[0]!) ? [] : null;
  }

  const step = Math.max(0.25, r / 4);
  const pieces: StrokePointPx[][] = [];
  let current: StrokePointPx[] | null = null;
  let touched = false;
  let lastUncovered: StrokePointPx | null = null;
  const pushUnique = (run: StrokePointPx[], p: StrokePointPx): void => {
    const last = run[run.length - 1];
    if (last === undefined || last.x !== p.x || last.y !== p.y) run.push(p);
  };

  for (let i = 0; i < stroke.length - 1; i += 1) {
    const a = stroke[i]!;
    const b = stroke[i + 1]!;
    // A segment whose box never comes within `r` of the eraser's has no
    // covered sample, so skip the sampling and keep its far vertex. This
    // is what keeps a cut proportional to the stroke's vertex count, not
    // its length in pixels. (`a` is uncovered too: it is in the box. At
    // i > 0 that means a run is already open; at i === 0 it opens one.)
    if (!boundsWithin(boundsPx([a, b]), eb, r)) {
      if (current === null) current = [a];
      pushUnique(current, b);
      lastUncovered = b;
      continue;
    }
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
          pieces.push(current);
          current = null;
        }
        lastUncovered = null;
        continue;
      }
      if (current === null) {
        current = [q];
      } else if (atVertex) {
        pushUnique(current, q);
      }
      lastUncovered = q;
    }
  }
  if (current !== null) {
    if (lastUncovered !== null) pushUnique(current, lastUncovered);
    pieces.push(current);
  }
  if (!touched) return null;
  return pieces.filter(
    (piece) => piece.length > 1 && polylineLengthPx(piece) >= minPieceLengthPx
  );
}

interface PxBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsWithin(a: PxBounds, b: PxBounds, reach: number): boolean {
  return !(
    a.maxX < b.minX - reach ||
    a.minX > b.maxX + reach ||
    a.maxY < b.minY - reach ||
    a.minY > b.maxY + reach
  );
}

/** A stroke the eraser may cut, as the editor lists it. */
export interface EraseTarget {
  readonly id: string;
  readonly data: StrokeOverlay;
}

interface ErasedStroke {
  /** The row this state was cut from. A different object (the row was
   *  edited mid-drag) starts over against the whole eraser path. */
  readonly data: StrokeOverlay;
  /** The cut radius for this stroke: the eraser's plus the stroke's own
   *  painted reach, so grazing the edge of a wide marker cuts it. */
  readonly reachPx: number;
  pieces: { points: StrokePointPx[]; bounds: PxBounds }[];
  bounds: PxBounds;
  touched: boolean;
  /** `pieces` as rows, built when asked for and kept until the next cut
   *  — the same array, so a renderer memoized on it does nothing. */
  rows: StrokeOverlay[] | null;
}

/**
 * One eraser drag. Each pointer event extends the eraser with just its
 * new samples, and only those new segments are tested — against the
 * pieces the earlier segments left, and only for strokes whose box they
 * reach. An eraser's cut is a union of discs, so cutting segment by
 * segment removes what one pass over the whole path would, and the
 * work per event stays proportional to what the new segments touch,
 * not to the length of the drag times every stroke on the canvas.
 *
 * The editor's live preview and its commit both read this session, so
 * what the drag shows is exactly what the release writes.
 */
export class StrokeEraseSession {
  private readonly path: StrokePointPx[] = [];
  private readonly strokes = new Map<string, ErasedStroke>();
  private live: ReadonlySet<string> = new Set();
  private preview: ReadonlyMap<string, readonly StrokeOverlay[]> = new Map();

  constructor(
    private readonly radiusPx: number,
    private readonly canvasWidthPx: number,
    private readonly canvasHeightPx: number,
    private readonly basisPx: number
  ) {}

  /**
   * Extend the eraser by `points` (canvas pixels, continuing the drag)
   * and cut every stroke in `targets` it reaches. `targets` is the
   * canvas's current stroke rows; a row seen for the first time, or
   * edited since the last call, is cut against the whole path so far.
   * Returns whether any stroke's pieces changed.
   *
   * With no new points it only re-syncs `targets`: a release calls it so
   * a row edited or added after the last move is cut from its current
   * data, as the commit used to by re-reading the canvas.
   */
  extend(points: readonly StrokePointPx[], targets: Iterable<EraseTarget>): boolean {
    const segment =
      points.length === 0 || this.path.length === 0
        ? [...points]
        : [this.path[this.path.length - 1]!, ...points];
    for (const p of points) this.path.push(p);
    // Bounds once per eraser, not once per stroke.
    const segmentBounds = boundsPx(segment);
    let pathBounds: PxBounds | null = null;
    let changed = false;
    const live = new Set<string>();
    for (const { id, data } of targets) {
      live.add(id);
      let state = this.strokes.get(id);
      let eraser = segment;
      let eraserBounds = segmentBounds;
      if (state === undefined || state.data !== data) {
        if (state?.touched === true) changed = true;
        state = this.track(data);
        this.strokes.set(id, state);
        eraser = this.path;
        eraserBounds = pathBounds ??= boundsPx(this.path);
      }
      if (eraser.length > 0 && this.cut(state, eraser, eraserBounds)) changed = true;
    }
    for (const id of this.live) {
      if (!live.has(id) && this.strokes.get(id)?.touched === true) changed = true;
    }
    this.live = live;
    if (changed) {
      const next = new Map<string, readonly StrokeOverlay[]>();
      for (const [id, state] of this.strokes) {
        if (state.touched && live.has(id)) next.set(id, this.rowsOf(state));
      }
      this.preview = next;
    }
    return changed;
  }

  /** What each cut stroke currently is, by row id: an empty list for a
   *  stroke erased whole. The map is replaced only when a cut changes
   *  it, and an untouched entry keeps its array. */
  pieces(): ReadonlyMap<string, readonly StrokeOverlay[]> {
    return this.preview;
  }

  /** The edits a release commits: every stroke the drag cut, with the
   *  rows that replace it. */
  changes(): { id: string; pieces: StrokeOverlay[] }[] {
    return [...this.preview].map(([id, rows]) => ({ id, pieces: [...rows] }));
  }

  private track(data: StrokeOverlay): ErasedStroke {
    const points = strokePointsToPx(data.points, this.canvasWidthPx, this.canvasHeightPx);
    const bounds = boundsPx(points);
    return {
      data,
      reachPx: this.radiusPx + strokeReachPx(data, this.basisPx),
      pieces: [{ points, bounds }],
      bounds,
      touched: false,
      rows: null
    };
  }

  private cut(state: ErasedStroke, eraser: readonly StrokePointPx[], eb: PxBounds): boolean {
    if (state.pieces.length === 0) return false;
    if (!boundsWithin(state.bounds, eb, state.reachPx)) return false;
    let changed = false;
    const next: ErasedStroke["pieces"] = [];
    for (const piece of state.pieces) {
      const cut = boundsWithin(piece.bounds, eb, state.reachPx)
        ? eraseStroke(piece.points, eraser, state.reachPx)
        : null;
      if (cut === null) {
        next.push(piece);
        continue;
      }
      changed = true;
      for (const points of cut) next.push({ points, bounds: boundsPx(points) });
    }
    if (!changed) return false;
    state.pieces = next;
    state.bounds = next.reduce<PxBounds>(
      (all, piece) => ({
        minX: Math.min(all.minX, piece.bounds.minX),
        minY: Math.min(all.minY, piece.bounds.minY),
        maxX: Math.max(all.maxX, piece.bounds.maxX),
        maxY: Math.max(all.maxY, piece.bounds.maxY)
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    );
    state.touched = true;
    state.rows = null;
    return true;
  }

  private rowsOf(state: ErasedStroke): StrokeOverlay[] {
    state.rows ??= state.pieces.map((piece) => ({
      ...state.data,
      points: strokePointsToNormalized(piece.points, this.canvasWidthPx, this.canvasHeightPx)
    }));
    return state.rows;
  }
}

function boundsPx(points: readonly StrokePointPx[]): PxBounds {
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
