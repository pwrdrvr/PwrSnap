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
  /** Optional home-size detent: when the resized box lands within the given
   *  per-axis radius (canvas px) of the home dimensions, snap exactly to
   *  them — so dragging back to the original size "sticks". */
  snapToHomeSize?: {
    homeWidthPx: number;
    homeHeightPx: number;
    radiusWidthPx: number;
    radiusHeightPx: number;
  };
}

const movesWest = (h: ResizeHandle): boolean => h === "nw" || h === "w" || h === "sw";
const movesEast = (h: ResizeHandle): boolean => h === "ne" || h === "e" || h === "se";
const movesNorth = (h: ResizeHandle): boolean => h === "nw" || h === "n" || h === "ne";
const movesSouth = (h: ResizeHandle): boolean => h === "sw" || h === "s" || h === "se";

/** True for the four corner handles (both axes scale — aspect lock applies). */
export function isCornerHandle(h: ResizeHandle): boolean {
  return h === "nw" || h === "ne" || h === "se" || h === "sw";
}

/** Element-wise equality of two affine transforms (the 6-tuple). Used to
 *  decide whether a raster still sits at its home transform — i.e. whether
 *  the Layers-panel Reset control has anything to do. */
export function affineTransformsEqual(a: AffineTransform, b: AffineTransform): boolean {
  return (
    a[0] === b[0] &&
    a[1] === b[1] &&
    a[2] === b[2] &&
    a[3] === b[3] &&
    a[4] === b[4] &&
    a[5] === b[5]
  );
}

/** Screen-pixel capture radius for the "home" detents — resize-back-to-
 *  original-size and drag-back-to-original-position. Each gesture converts
 *  this to canvas px using its current zoom, so the magnetic feel is the
 *  same on screen regardless of how the canvas is scaled. */
export const HOME_SNAP_SCREEN_PX = 7;

/** Magnetic detent: pull `value` to `home` when within `radiusPx`, else pass
 *  it through unchanged. Stateless — the "sticks briefly, then unsticks when
 *  you drag past it" feel comes from the flat home output across the ±radius
 *  capture zone. `radiusPx <= 0` disables the snap. */
export function snapToHome(value: number, home: number, radiusPx: number): number {
  return radiusPx > 0 && Math.abs(value - home) <= radiusPx ? home : value;
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
    minSizePx = 8,
    snapToHomeSize
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
  let newW = Math.max(minSizePx, w0 + dx);
  let newH = Math.max(minSizePx, h0 + dy);

  // Home-size detent: pull each axis to the original dimension when the drag
  // lands within its capture radius. For a proportional (aspect-locked) drag
  // both axes cross home together, so this snaps cleanly back to the exact
  // original size; edge / distorted drags snap per-axis.
  if (snapToHomeSize !== undefined) {
    newW = snapToHome(newW, snapToHomeSize.homeWidthPx, snapToHomeSize.radiusWidthPx);
    newH = snapToHome(newH, snapToHomeSize.homeHeightPx, snapToHomeSize.radiusHeightPx);
  }

  // Anchor the opposite edge: west handles move `left` (right pinned at
  // left0 + w0); east handles keep `left`. Same for north/south.
  const left = movesWest(handle) ? left0 + w0 - newW : left0;
  const top = movesNorth(handle) ? top0 + h0 - newH : top0;

  const sx = naturalWidthPx > 0 ? newW / naturalWidthPx : sx0;
  const sy = naturalHeightPx > 0 ? newH / naturalHeightPx : sy0;

  return [sx, 0, 0, sy, left, top];
}
