// Geometry for a multi-window pick.
//
// The picker can hand main a set of window extents instead of a single
// rect. `rect` is always their union bounding box — that keeps every
// downstream consumer (validation, source-app resolution, cursor
// placement, recording) working with no knowledge of extents — and
// `extents` rides alongside as a mask: in `windows` output mode the
// crop keeps only the pixels inside them and makes the rest of the box
// transparent.
//
// This module is the pure half of that: logical-px rectangles in,
// snapshot-pixel extract/composite coordinates out. It is separate from
// capture-handlers so the arithmetic — which is where the off-by-one
// and negative-offset bugs live — can be tested without sharp, Electron,
// or a real screenshot.
//
// IMPORTANT: this is a mask over the frozen full-screen snapshot, not a
// per-window capture. Each extent is a plain rectangle on that image, so
// whatever was composited on top of a picked window at freeze time comes
// along — exactly what the picker showed under its dim mask. Capturing a
// window *through* an occluder is a different feature.

/** A rectangle in display-logical px, global (virtual-screen) coords. */
export type MaskRect = { x: number; y: number; w: number; h: number };

/** A rectangle in snapshot pixels, relative to the snapshot's origin. */
export type PhysicalBox = { left: number; top: number; width: number; height: number };

export type ExtentMaskPlan = {
  /** The output canvas: the union box, clamped to the snapshot. */
  box: PhysicalBox;
  /**
   * One composite layer per extent that survived clipping. `extract` is
   * where to cut from the snapshot; `left`/`top` are where that cut
   * lands on the canvas (always >= 0, which is what sharp requires).
   */
  layers: { extract: PhysicalBox; left: number; top: number }[];
};

/**
 * Upper bound on a multi-window pick.
 *
 * The window list itself is usually well under this; the cap exists
 * because `extents` is renderer-supplied and each entry costs a sharp
 * extract + composite at commit time. A pick larger than this is a bug
 * or an attack, not a user.
 */
export const MAX_SELECTOR_EXTENTS = 64;

/** Shape + sanity check for one renderer-supplied extent. */
export function isExtentRect(value: unknown): value is MaskRect {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  for (const key of ["x", "y", "w", "h"] as const) {
    const n = r[key];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  // Zero-area extents would make sharp throw on extract; reject here
  // rather than filtering silently at crop time.
  return (r.w as number) > 0 && (r.h as number) > 0;
}

/**
 * Plan the extract + composite operations for a masked multi-window
 * crop.
 *
 * Coordinate handling mirrors the single-rect crop: `rect` and
 * `extents` are display-logical px in global coords; the snapshot is
 * physical px covering the display's bounds. Everything is clamped
 * twice — to the union box and to the snapshot — because a stray or
 * rounded extent that composites outside the canvas makes sharp throw
 * on a negative offset.
 *
 * Returns null when there is nothing to render: a degenerate box, an
 * unreadable snapshot, or no extent that overlaps the canvas.
 */
export function planExtentMask(args: {
  rect: MaskRect;
  extents: readonly MaskRect[];
  /** The display's origin in global logical coords (display.bounds). */
  displayOrigin: { x: number; y: number };
  scaleFactor: number;
  snapshot: { width: number; height: number };
}): ExtentMaskPlan | null {
  const { rect, extents, displayOrigin, scaleFactor, snapshot } = args;
  if (rect.w <= 0 || rect.h <= 0) return null;
  if (extents.length === 0) return null;
  if (snapshot.width <= 0 || snapshot.height <= 0) return null;

  const toPhysical = (r: MaskRect): PhysicalBox => ({
    left: Math.round((r.x - displayOrigin.x) * scaleFactor),
    top: Math.round((r.y - displayOrigin.y) * scaleFactor),
    width: Math.max(1, Math.round(r.w * scaleFactor)),
    height: Math.max(1, Math.round(r.h * scaleFactor))
  });

  const raw = toPhysical(rect);
  const boxLeft = Math.min(Math.max(0, raw.left), snapshot.width - 1);
  const boxTop = Math.min(Math.max(0, raw.top), snapshot.height - 1);
  // A union box that starts off the left/top edge is clamped to 0, so
  // its far edge — not its width — is what survives the clamp.
  const boxRight = Math.min(raw.left + raw.width, snapshot.width);
  const boxBottom = Math.min(raw.top + raw.height, snapshot.height);
  const boxW = boxRight - boxLeft;
  const boxH = boxBottom - boxTop;
  if (boxW <= 0 || boxH <= 0) return null;

  const layers: ExtentMaskPlan["layers"] = [];
  for (const extent of extents) {
    const e = toPhysical(extent);
    // Intersect with the canvas: an extent hanging off the display edge
    // (or off the union box, which a rounding difference can produce)
    // contributes only its visible part.
    const left = Math.max(e.left, boxLeft);
    const top = Math.max(e.top, boxTop);
    const right = Math.min(e.left + e.width, boxLeft + boxW);
    const bottom = Math.min(e.top + e.height, boxTop + boxH);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) continue;
    layers.push({
      extract: { left, top, width, height },
      left: left - boxLeft,
      top: top - boxTop
    });
  }
  if (layers.length === 0) return null;

  return { box: { left: boxLeft, top: boxTop, width: boxW, height: boxH }, layers };
}
