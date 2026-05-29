// Shared types + helpers for the editor's draft state. Pulled out of
// Editor.tsx so OverlaySvg and TextDraftInput (separate files) can
// reference the same shapes without circular imports.

import type { ShapeKind } from "@pwrsnap/shared";

export type DraftArrow = {
  kind: "arrow";
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
};

export type DraftRect = {
  /** Same shape for shape / highlight / blur — they all drag a box.
   *  The `tool` discriminator below tells the renderer which look
   *  to apply during drag. */
  kind: "rect-drag";
  tool: "shape" | "highlight" | "blur";
  startXn: number;
  startYn: number;
  curXn: number;
  curYn: number;
  /** When `tool === "shape"`, the shape kind the user picked in the
   *  popover (drives the live-preview glyph and dictates 1:1 lock
   *  semantics in onPointerMove). Undefined for highlight / blur. */
  shape?: ShapeKind;
};

export type DraftText = {
  kind: "text";
  /** Anchor point. With dominantBaseline="central", this is the
   *  vertical center of the first line; horizontally the left edge. */
  xn: number;
  yn: number;
  /** Live-typed body. Persisted on commit (Enter / blur). */
  body: string;
  /** When set, the draft is RE-EDITING an existing text overlay (the
   *  user double-clicked it). commitText writes back to this overlay's
   *  id via the `updateOverlay` dispatch op instead of creating a new
   *  row. When undefined, the draft is a fresh text placement and
   *  commit creates a new overlay. */
  editingId?: string;
};

export type Draft = DraftArrow | DraftRect | DraftText;

/** Minimum normalized drag length below which we treat a pointer
 *  gesture as a click (no-op for drawing tools, just clears the
 *  draft). 0.5% of canvas in each axis. */
export const MIN_DRAG_LENGTH = 0.005;

/**
 * Convert the rect-drag draft into a normalized {x, y, w, h}. Returns
 * null when the drag is below the minimum-length threshold (treats a
 * stray click as a no-op rather than producing an invisible rect).
 *
 * Optional `canvasAspect` (width/height ratio in pixel space) drives
 * the 1:1 lock for `square` and `circle` shapes. Without it, equal
 * normalized w/h would render as an aspect-canvas-shaped rect (since
 * normalized coords are fractions of W and H independently), not a
 * pixel-square. Pass `canvasAspect = canvasWidthPx / canvasHeightPx`
 * to get a true 1:1 in pixel space; the helper does the conversion.
 * Defaults to 1 when omitted (test paths that don't care about pixel
 * squareness).
 */
export function rectFromDrag(
  d: DraftRect,
  canvasAspect?: number
): { x: number; y: number; w: number; h: number } | null {
  const dragX = Math.min(d.startXn, d.curXn);
  const dragY = Math.min(d.startYn, d.curYn);
  const dragW = Math.abs(d.curXn - d.startXn);
  const dragH = Math.abs(d.curYn - d.startYn);
  if (dragW < MIN_DRAG_LENGTH || dragH < MIN_DRAG_LENGTH) return null;

  // 1:1 lock for square + circle. The dragged box can be any shape
  // in normalized coords; pick the SMALLER pixel-space extent and
  // shrink the other axis to match. This keeps the locked shape
  // contained inside the gesture box (the user can always overshoot
  // the box they want; they can't accidentally grow it past the
  // pointer). Aspect-correct so canvasAspect = 16/9 still produces
  // a visually-square box on screen.
  const lock = d.tool === "shape" && (d.shape === "square" || d.shape === "circle");
  let x = dragX;
  let y = dragY;
  let w = dragW;
  let h = dragH;
  if (lock) {
    const aspect = canvasAspect ?? 1;
    // Pixel-space dims: wPx = w * canvasW, hPx = h * canvasH.
    // canvasW/canvasH ratio = aspect; pick smaller pixel side and
    // re-derive the other axis. We do the comparison in pixel space
    // by normalizing through aspect.
    const wPxFraction = dragW;            // already w-fraction
    const hPxFraction = dragH / aspect;   // h-fraction normalized to w-space
    const sidePxFraction = Math.min(wPxFraction, hPxFraction);
    w = sidePxFraction;
    h = sidePxFraction * aspect;
    // Re-anchor so the locked shape grows from the pointer-down
    // corner toward the cursor, not from the bbox center.
    if (d.curXn < d.startXn) x = d.startXn - w;
    else x = d.startXn;
    if (d.curYn < d.startYn) y = d.startYn - h;
    else y = d.startYn;
  }

  // Clamp to [0,1] in case the cursor went out of bounds.
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    w: Math.max(0, Math.min(1 - Math.max(0, x), w)),
    h: Math.max(0, Math.min(1 - Math.max(0, y), h))
  };
}
