// Occlusion-aware visibility math for snap candidates.
//
// The Swift helper hands us windows in front-to-back z-order. A
// hit-test that walks that list from the front and returns the first
// window whose raw bounds contain the cursor is topology-correct
// — anything in front of that window would have been matched first,
// so the picked window IS the one visually under the cursor.
//
// The earlier bug was unrelated to that algorithm: we were filtering
// PwrSnap-owned windows out BEFORE the hit-test. So if the library
// window covered a hidden 1Password window and the cursor was over
// the library, the algorithm walked past the (filtered-out) library
// and reported 1Password — which the user can't actually see at the
// cursor. Fix: keep our windows in the list, mark them as
// `ownedByUs`, and have the hit-test return null when the topmost
// match is one of ours. The cursor is visually on a window we don't
// want to snap to, so the answer is "no window snap" — fall through
// to display snap.
//
// The second piece — the snap rect should reflect the *visible*
// portion of a window, not its raw bounds — needs the geometry
// below. For each candidate we compute its visible region by
// subtracting the union of windows in front. The bounding box of
// that region is the snap rect we draw. Fully-occluded windows have
// a zero-area visible region; callers drop them from the snap list
// entirely (a window that's 100% hidden is not a meaningful target).
//
// We only do axis-aligned rectangle subtraction — no polygon
// clipping. An L-shaped visible region collapses to its bounding
// box, which is a slight over-approximation. That's fine for snap
// UX (the user gets the obvious enclosing rect; if they want
// something tighter they free-draw). It's O(n²) over windows in
// front, which is fine for typical n < 50.

export type Rect = { x: number; y: number; w: number; h: number };

export type Visibility<T> = {
  /** The candidate window itself (caller-supplied). */
  source: T;
  /** Window bounds passed in, mirrored for convenience. */
  rawBounds: Rect;
  /**
   * Snap-rect we paint as the highlight: the **largest contiguous
   * visible rectangular fragment** within the window's visible
   * region. For windows whose visible region is a single rect this
   * just equals that rect; for L-shaped or split visible regions it
   * picks the biggest meaningful piece — better UX than the
   * bounding box (which would wrap occluded areas the user can't
   * actually see).
   */
  visibleBounds: Rect;
  /** Sum of pixels in the entire visible region. Zero = fully occluded. */
  visibleArea: number;
  /** Z-order index in the original list (0 = frontmost). */
  zIndex: number;
};

type WithBounds = { bounds: { x: number; y: number; width: number; height: number } };

/**
 * Compute the visible region of every window in front-to-back order.
 * `windows` MUST be ordered front-to-back. Output preserves order.
 */
export function computeVisibility<T extends WithBounds>(
  windows: readonly T[]
): Visibility<T>[] {
  const out: Visibility<T>[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    const rawBounds = boundsToRect(w.bounds);
    const occluders = windows.slice(0, i).map((f) => boundsToRect(f.bounds));
    const fragments = subtractAll([rawBounds], occluders);
    const visibleArea = fragments.reduce((acc, r) => acc + r.w * r.h, 0);
    // Pick the largest single fragment as the snap rect — NOT the
    // bounding box of all fragments. The bounding box of an L-shape
    // wraps the occluded inside corner, painting a snap rect that
    // includes pixels the user can't actually see at this window.
    // Largest-fragment is a tight, fully-visible rectangle that
    // matches what the user expects to capture.
    const visibleBounds = largestFragment(fragments) ?? rawBounds;
    out.push({ source: w, rawBounds, visibleBounds, visibleArea, zIndex: i });
  }
  return out;
}

/**
 * Pick the topmost window at (x, y) using raw-bounds z-order walk.
 *
 * Returns null when:
 *   - The cursor is over background (no window's bounds contain it).
 *   - The topmost window at the point is a blocker (e.g. one of our
 *     own PwrSnap windows). The user is visually on a non-snappable
 *     surface; fall back to display snap.
 */
export function pickWindowAt<T extends WithBounds>(
  windows: readonly T[],
  x: number,
  y: number,
  isBlocker: (source: T) => boolean
): T | null {
  for (const w of windows) {
    if (!pointInRect(boundsToRect(w.bounds), x, y)) continue;
    return isBlocker(w) ? null : w;
  }
  return null;
}

function boundsToRect(b: WithBounds["bounds"]): Rect {
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

export function pointInRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

/**
 * Subtract `b` from `a` — returns up to 4 axis-aligned rectangles
 * representing `a \ b`. If they don't overlap, returns [a]. If `b`
 * fully covers `a`, returns []. Used by computeVisibility to
 * iteratively carve away occluders.
 */
export function subtractRect(a: Rect, b: Rect): Rect[] {
  if (!rectsIntersect(a, b)) return [a];
  const out: Rect[] = [];
  // Top strip — part of `a` above `b`.
  if (b.y > a.y) {
    out.push({ x: a.x, y: a.y, w: a.w, h: b.y - a.y });
  }
  // Bottom strip — part of `a` below `b`.
  if (b.y + b.h < a.y + a.h) {
    out.push({ x: a.x, y: b.y + b.h, w: a.w, h: a.y + a.h - (b.y + b.h) });
  }
  // Middle band — left + right slivers between top and bottom strips.
  const midTop = Math.max(a.y, b.y);
  const midBottom = Math.min(a.y + a.h, b.y + b.h);
  const midH = Math.max(0, midBottom - midTop);
  if (midH > 0) {
    if (b.x > a.x) {
      out.push({ x: a.x, y: midTop, w: b.x - a.x, h: midH });
    }
    if (b.x + b.w < a.x + a.w) {
      out.push({ x: b.x + b.w, y: midTop, w: a.x + a.w - (b.x + b.w), h: midH });
    }
  }
  return out;
}

export function subtractAll(rects: Rect[], subtractors: readonly Rect[]): Rect[] {
  let work = rects;
  for (const s of subtractors) {
    const next: Rect[] = [];
    for (const r of work) {
      next.push(...subtractRect(r, s));
    }
    work = next;
    if (work.length === 0) break;
  }
  return work;
}

export function boundingBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * The biggest rectangle in the list (by area). Used as the snap
 * highlight for windows whose visible region splits into multiple
 * fragments: instead of the over-approximating bounding box we
 * draw a tight rect over the largest piece. Returns null on empty.
 */
export function largestFragment(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let best: Rect | null = null;
  let bestArea = -1;
  for (const r of rects) {
    const area = r.w * r.h;
    if (area > bestArea) {
      best = r;
      bestArea = area;
    }
  }
  return best;
}
