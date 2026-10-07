type Rect = { x: number; y: number; width: number; height: number };
type Display = { id: number; bounds: Rect; workArea: Rect };

/** Fail closed: no preview when there is no free area, including a single
 * display recorded in full. Coordinates returned here are global DIPs. */
export function cameraPreviewBounds(
  displays: readonly Display[],
  displayId: number,
  localRect: { x: number; y: number; w: number; h: number },
): Rect | null {
  const display = displays.find(d => d.id === displayId);
  if (!display) return null;
  const recorded = { x: display.bounds.x + localRect.x, y: display.bounds.y + localRect.y,
    width: localRect.w, height: localRect.h };
  const width = 240, height = 159, gap = 12;
  for (const d of [display, ...displays.filter(d => d.id !== displayId)]) {
    const area = d.workArea;
    const candidates = [
      { x: recorded.x + recorded.width + gap, y: recorded.y },
      { x: recorded.x - width - gap, y: recorded.y },
      { x: recorded.x, y: recorded.y + recorded.height + gap },
      { x: recorded.x, y: recorded.y - height - gap },
      { x: area.x + gap, y: area.y + area.height - height - gap },
      { x: area.x + area.width - width - gap, y: area.y + gap },
    ];
    for (const point of candidates) {
      const rect = { x: Math.round(point.x), y: Math.round(point.y), width, height };
      if (rect.x < area.x || rect.y < area.y || rect.x + width > area.x + area.width ||
        rect.y + height > area.y + area.height) continue;
      if (rect.x < recorded.x + recorded.width && rect.x + width > recorded.x &&
        rect.y < recorded.y + recorded.height && rect.y + height > recorded.y) continue;
      return rect;
    }
  }
  return null;
}
