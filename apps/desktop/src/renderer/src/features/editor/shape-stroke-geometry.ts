import { readOverlayThickness, type OverlayThickness } from "@pwrsnap/shared";

/** Stroke geometry for a stroked shape glyph, in the SAME px space as
 *  `shortSidePx`. Single source of truth shared by three call sites that
 *  must agree pixel-for-pixel:
 *    • the renderer (`ShapeGlyph` in OverlaySvg.tsx) — paints the line,
 *    • the click hit-test (`hitTestOverlays` in Editor.tsx) — decides
 *      what selects,
 *    • the selected-shape drag rect (`TransformHandles` in
 *      OverlaySvg.tsx) — decides what you can grab to move.
 *
 *  Keeping the auto stroke band + halo formula in one place is what
 *  lets the hit region track the painted line instead of drifting from
 *  it (the bug where a thick-lined shape was only grabbable by the thin
 *  inner sliver of its stroke). */
export interface ShapeStrokeGeometry {
  /** Colored stroke width. Centered on the shape's path. */
  strokeWidthPx: number;
  /** White halo (under-stroke) extension beyond the colored stroke on
   *  EACH side. The halo is painted as `strokeWidthPx + outline * 2`. */
  outline: number;
  /** Outer reach from the path to the outside edge of the painted
   *  pixels — half the colored stroke plus the halo
   *  (`strokeWidthPx / 2 + outline`). */
  outerReachPx: number;
}

/** Resolve a shape's stroke geometry from its thickness preset/override
 *  and the image short side. Mirrors the auto band ShapeGlyph uses
 *  (≈1.2% of the short side, floored at 8px, clamped down to ≈0.3%) and
 *  the halo width (`max(stroke * 0.25, 1.5)`). */
export function shapeStrokeGeometry(
  thickness: OverlayThickness | undefined,
  shortSidePx: number
): ShapeStrokeGeometry {
  const autoStrokeWidthPx = Math.min(
    shortSidePx * 0.012,
    Math.max(shortSidePx * 0.003, 8)
  );
  const strokeWidthPx = readOverlayThickness(
    thickness,
    autoStrokeWidthPx,
    shortSidePx
  );
  const outline = Math.max(strokeWidthPx * 0.25, 1.5);
  return { strokeWidthPx, outline, outerReachPx: strokeWidthPx / 2 + outline };
}
