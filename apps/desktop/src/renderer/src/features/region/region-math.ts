// Pure geometry helpers for the region selector. Extracted from
// RegionSelector.tsx so the math is unit-testable without spinning up
// a DOM — `clampRectToViewport` takes `viewport` instead of reading
// window.innerWidth/Height directly so tests can drive any size.
//
// Coordinate space: window-local pixels (the selector window covers
// the whole display, so window-local == display-local). Main converts
// to the global virtual coord space + display id at commit.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type Viewport = { width: number; height: number };

export type HandleId = "tl" | "tr" | "bl" | "br" | "tm" | "bm" | "lm" | "rm";
export const ALL_HANDLES: HandleId[] = ["tl", "tr", "bl", "br", "tm", "bm", "lm", "rm"];

/**
 * Build a positive-area rect from any two points. Handles flipped drags
 * (e.g. drawing right-to-left or bottom-to-top).
 */
export function rectFromTwoPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  };
}

/**
 * Apply a handle drag delta to a rect. The result normalizes flipped
 * resizes — dragging the top-left handle past the bottom-right keeps
 * the rect positive-area instead of producing a negative w/h.
 */
export function applyResize(start: Rect, handle: HandleId, dx: number, dy: number): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle === "tl" || handle === "lm" || handle === "bl") left += dx;
  if (handle === "tr" || handle === "rm" || handle === "br") right += dx;
  if (handle === "tl" || handle === "tm" || handle === "tr") top += dy;
  if (handle === "bl" || handle === "bm" || handle === "br") bottom += dy;
  return {
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.abs(right - left),
    h: Math.abs(bottom - top)
  };
}

/**
 * Clamp a rect to a viewport. Guarantees:
 *   - x ∈ [0, viewport.width - 1]
 *   - y ∈ [0, viewport.height - 1]
 *   - w ≥ 1 and x + w ≤ viewport.width
 *   - h ≥ 1 and y + h ≤ viewport.height
 *
 * Used both for arrow-key nudge (keeps the rect inside the display)
 * and for drag-to-move clamping.
 */
export function clampRectToViewport(rect: Rect, viewport: Viewport): Rect {
  const x = Math.max(0, Math.min(viewport.width - 1, rect.x));
  const y = Math.max(0, Math.min(viewport.height - 1, rect.y));
  const w = Math.max(1, Math.min(viewport.width - x, rect.w));
  const h = Math.max(1, Math.min(viewport.height - y, rect.h));
  return { x, y, w, h };
}

/**
 * True when `(px, py)` is inside (or on the border of) `rect`.
 */
export function isPointInsideRect(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/**
 * Drag-engage threshold in CSS pixels. Once the cursor has moved
 * MORE than this distance in EITHER axis from the mousedown anchor,
 * the interaction is committed to "drawing" — the user has clearly
 * expressed drag intent, no more pending. This is the only number
 * that should gate drawing vs. click-snap.
 *
 * Kept deliberately small (3px) so quick, short drags engage as
 * drags rather than getting interpreted as snap-commits. Anything
 * higher and a real flick of the wrist registers as a click,
 * defeating the user.
 */
export const DRAG_ENGAGE_PX = 3;

/**
 * Minimum positive area, in CSS pixels², that a finished free-draw
 * rect must cover for `commit()` to send it. A 100×1 strip is a
 * legitimate user intent (capture a thin status bar); only truly
 * collapsed rects (area 0, no real drag occurred) should be rejected.
 */
export const MIN_RECT_AREA_PX = 1;

/**
 * True when the cursor has moved far enough from the mousedown anchor
 * to engage drag-to-draw. Uses Chebyshev distance (max-of-axes), not
 * Euclidean — a 3px horizontal-only flick should engage just as
 * readily as a 3px diagonal one. Euclidean was making horizontal /
 * vertical flicks feel sluggish because √(9+0) = 3 sits right at the
 * threshold and one-axis 3px drags failed `< 4`.
 */
export function exceedsDragThreshold(dx: number, dy: number): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) >= DRAG_ENGAGE_PX;
}

/**
 * True when a finished free-draw rect represents a real selection
 * (not a tiny twitch). The check is on area, not per-axis: a long
 * thin strip (e.g. 200×1) is a valid intent; a 2×2 twitch is not.
 */
export function rectIsMeaningful(rect: Rect): boolean {
  return rect.w * rect.h >= MIN_RECT_AREA_PX;
}

/**
 * Overlaps thinner than this are noise, not geometry. The renderer
 * scales every window rect from display-logical px into CSS px, and on
 * a scaled display `x * s + w * s` can exceed `(x + w) * s` by an ulp —
 * so two windows that share an edge would otherwise "overlap" by
 * ~1e-15px and clip each other for no visible reason.
 */
const SUBPIXEL_EPSILON_PX = 0.001;

/** Rounded to the same 1/1000 px as `SUBPIXEL_EPSILON_PX`. */
function roundPx(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * `base` minus the union of `cutters`, as disjoint rects. Cutters that
 * only touch `base` along an edge (to within `SUBPIXEL_EPSILON_PX`) cut
 * nothing. Empty result = `base` is fully covered.
 *
 * Each cutter splits every piece it overlaps into up to four bands —
 * full-width above and below the overlap, then left and right of it
 * within the overlap's rows — so the pieces never overlap each other.
 */
export function subtractRects(base: Rect, cutters: readonly Rect[]): Rect[] {
  let pieces: Rect[] = base.w > 0 && base.h > 0 ? [base] : [];
  for (const c of cutters) {
    const next: Rect[] = [];
    for (const p of pieces) {
      const left = Math.max(p.x, c.x);
      const right = Math.min(p.x + p.w, c.x + c.w);
      const top = Math.max(p.y, c.y);
      const bottom = Math.min(p.y + p.h, c.y + c.h);
      if (right - left < SUBPIXEL_EPSILON_PX || bottom - top < SUBPIXEL_EPSILON_PX) {
        next.push(p);
        continue;
      }
      if (top - p.y >= SUBPIXEL_EPSILON_PX) {
        next.push({ x: p.x, y: p.y, w: p.w, h: top - p.y });
      }
      if (p.y + p.h - bottom >= SUBPIXEL_EPSILON_PX) {
        next.push({ x: p.x, y: bottom, w: p.w, h: p.y + p.h - bottom });
      }
      if (left - p.x >= SUBPIXEL_EPSILON_PX) {
        next.push({ x: p.x, y: top, w: left - p.x, h: bottom - top });
      }
      if (p.x + p.w - right >= SUBPIXEL_EPSILON_PX) {
        next.push({ x: right, y: top, w: p.x + p.w - right, h: bottom - top });
      }
    }
    pieces = next;
  }
  return pieces;
}

/**
 * How to draw one window frame when other frames sit in front of it.
 *
 *   - `hidden` — every pixel of the frame is covered; draw no frame.
 *   - `clipPath` — CSS `clip-path` for a visible frame, in the frame's
 *     own coordinates. `null` when nothing in front overlaps it (draw it
 *     whole) and whenever `hidden` is true.
 *   - `badge` — where the ordinal badge's corner goes, relative to the
 *     frame's origin. The frame's own corner unless that corner is
 *     covered; then the top-left of the highest visible piece, so the
 *     number stays next to an edge that belongs to it.
 */
export type OccludedFrame = {
  hidden: boolean;
  clipPath: string | null;
  badge: Point;
};

/** A frame with nothing in front of it. */
export const UNOCCLUDED_FRAME: Readonly<OccludedFrame> = {
  hidden: false,
  clipPath: null,
  badge: { x: 0, y: 0 }
};

export function occludedFrame(base: Rect, inFront: readonly Rect[]): OccludedFrame {
  const pieces = subtractRects(base, inFront);
  if (pieces.length === 0) return { hidden: true, clipPath: null, badge: { x: 0, y: 0 } };
  // `subtractRects` passes an untouched piece through by reference.
  if (pieces.length === 1 && pieces[0] === base) return UNOCCLUDED_FRAME;
  // Nonzero fill over same-winding, disjoint subpaths is their union.
  const n = (v: number): string => String(roundPx(v));
  const d = pieces
    .map(
      (p) => `M${n(p.x - base.x)} ${n(p.y - base.y)}h${n(p.w)}v${n(p.h)}h${n(-p.w)}Z`
    )
    .join("");
  const cornerVisible = pieces.some((p) => p.x === base.x && p.y === base.y);
  let badge: Point = { x: 0, y: 0 };
  if (!cornerVisible) {
    const top = pieces.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a));
    badge = { x: roundPx(top.x - base.x), y: roundPx(top.y - base.y) };
  }
  return { hidden: false, clipPath: `path("${d}")`, badge };
}
