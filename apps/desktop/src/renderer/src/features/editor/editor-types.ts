// Shared types + helpers for the editor's draft state. Pulled out of
// Editor.tsx so OverlaySvg and TextDraftInput (separate files) can
// reference the same shapes without circular imports.

export type DraftArrow = {
  kind: "arrow";
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
};

export type DraftRect = {
  /** Same shape for rect / highlight / blur — they all drag a box.
   *  The `tool` discriminator below tells the renderer which look
   *  to apply during drag. */
  kind: "rect-drag";
  tool: "rect" | "highlight" | "blur";
  startXn: number;
  startYn: number;
  curXn: number;
  curYn: number;
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
 */
export function rectFromDrag(
  d: DraftRect
): { x: number; y: number; w: number; h: number } | null {
  const x = Math.min(d.startXn, d.curXn);
  const y = Math.min(d.startYn, d.curYn);
  const w = Math.abs(d.curXn - d.startXn);
  const h = Math.abs(d.curYn - d.startYn);
  if (w < MIN_DRAG_LENGTH || h < MIN_DRAG_LENGTH) return null;
  // Clamp to [0,1] in case the cursor went out of bounds.
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    w: Math.max(0, Math.min(1 - x, w)),
    h: Math.max(0, Math.min(1 - y, h))
  };
}
