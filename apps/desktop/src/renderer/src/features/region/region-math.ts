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
