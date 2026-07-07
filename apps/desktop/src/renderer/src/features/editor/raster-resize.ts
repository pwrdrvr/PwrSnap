// Pure scale math for the raster resize handles. Given the handle being
// dragged, the cursor delta (in CANVAS PIXELS), and the raster's transform
// at drag start, compute the new affine transform so the OPPOSITE anchor
// stays pinned — the standard corner/edge resize behaviour.
//
// A raster's transform is `[sx, 0, 0, sy, tx, ty]` in canvas pixels, and
// its on-canvas box is `{ left: tx, top: ty, w: naturalW*sx, h: naturalH*sy }`
// (see raster-layer-style.ts / compose-tree.ts). Resize adjusts the box
// edges the handle controls, re-derives the scale from the new box size vs
// the natural dims, and translates so the anchored edges don't move. The
// commit path (dispatchEdit `{ kind: "transform" }`) is shared with drag.

import type { AffineTransform } from "@pwrsnap/shared";

/** The eight resize handles, by compass direction. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ResizeRasterArgs {
  handle: ResizeHandle;
  /** Cursor delta from the drag start, in CANVAS pixels. */
  dxPx: number;
  dyPx: number;
  /** The raster's transform at drag start. */
  startTransform: AffineTransform;
  naturalWidthPx: number;
  naturalHeightPx: number;
  /** Preserve the start aspect ratio (e.g. Shift held). */
  lockAspect: boolean;
  /** Minimum on-canvas box size, canvas px. Default 8. */
  minSizePx?: number;
}

const movesWest = (h: ResizeHandle): boolean => h === "nw" || h === "w" || h === "sw";
const movesEast = (h: ResizeHandle): boolean => h === "ne" || h === "e" || h === "se";
const movesNorth = (h: ResizeHandle): boolean => h === "nw" || h === "n" || h === "ne";
const movesSouth = (h: ResizeHandle): boolean => h === "sw" || h === "s" || h === "se";

/** True for the four corner handles (both axes scale — aspect lock applies). */
export function isCornerHandle(h: ResizeHandle): boolean {
  return h === "nw" || h === "ne" || h === "se" || h === "sw";
}

/**
 * Compute the resized transform. The anchor (the edge/corner OPPOSITE the
 * dragged handle) stays fixed; the dragged edges move by the cursor delta.
 * Scale is re-derived from the new box size / natural dims, so the pasted
 * raster and the baked composite stay in lockstep.
 */
export function resizeRasterTransform(args: ResizeRasterArgs): AffineTransform {
  const {
    handle,
    dxPx,
    dyPx,
    startTransform,
    naturalWidthPx,
    naturalHeightPx,
    lockAspect,
    minSizePx = 8
  } = args;

  const sx0 = startTransform[0];
  const sy0 = startTransform[3];
  const left0 = startTransform[4];
  const top0 = startTransform[5];
  const w0 = naturalWidthPx * sx0;
  const h0 = naturalHeightPx * sy0;

  // Effective per-axis delta the handle applies (edge handles pin one axis).
  let dx = movesEast(handle) ? dxPx : movesWest(handle) ? -dxPx : 0;
  let dy = movesSouth(handle) ? dyPx : movesNorth(handle) ? -dyPx : 0;

  // Aspect lock: drive both axes off the dominant one, preserving w0/h0.
  // Corners use whichever delta grew the box more; edges drive the pinned
  // axis from the moving one.
  if (lockAspect && w0 > 0 && h0 > 0) {
    const aspect = w0 / h0;
    if (isCornerHandle(handle)) {
      // Pick the axis with the larger proportional change so the drag feels
      // anchored to the cursor, then mirror it onto the other axis.
      if (Math.abs(dx) / w0 >= Math.abs(dy) / h0) {
        dy = dx / aspect;
      } else {
        dx = dy * aspect;
      }
    } else if (movesEast(handle) || movesWest(handle)) {
      dy = dx / aspect; // horizontal edge drives height
    } else {
      dx = dy * aspect; // vertical edge drives width
    }
  }

  // New box size, clamped so it never inverts or collapses below minSize.
  const newW = Math.max(minSizePx, w0 + dx);
  const newH = Math.max(minSizePx, h0 + dy);

  // Anchor the opposite edge: west handles move `left` (right pinned at
  // left0 + w0); east handles keep `left`. Same for north/south.
  const left = movesWest(handle) ? left0 + w0 - newW : left0;
  const top = movesNorth(handle) ? top0 + h0 - newH : top0;

  const sx = naturalWidthPx > 0 ? newW / naturalWidthPx : sx0;
  const sy = naturalHeightPx > 0 ? newH / naturalHeightPx : sy0;

  return [sx, 0, 0, sy, left, top];
}
