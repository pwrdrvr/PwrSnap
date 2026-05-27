// Pure geometry primitive — checks whether a selector-shaped rect
// (`{ x, y, w, h }`, the shape `Rect` uses) overlaps a
// BrowserWindow-shaped bounds (`{ x, y, width, height }`, the shape
// `getBounds()` returns). Pulled out so the gate in main/index.ts
// (`appWindowsOverlappingRecording`) has a directly-testable seam
// without dragging the full main module into the test environment.

/**
 * Edge contact is not overlap. Coords are half-open on the right +
 * bottom (`a.x + a.w > b.x` is strict greater-than), matching how
 * Electron + CGWindow treat window bounds in pixel space.
 */
export function rectIntersectsBounds(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  if (a.w <= 0 || a.h <= 0) return false;
  if (b.width <= 0 || b.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.w > b.x &&
    a.y < b.y + b.height &&
    a.y + a.h > b.y
  );
}
