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
