// Where the permission guide goes relative to System Settings.
//
// Pure: no Electron, so the placement rules are testable on every CI lane.
// All rects are global DIP with a top-left origin. That is what Electron's
// `screen` API uses, and what the window-list helper reports
// (`CGWindowListCopyWindowInfo` bounds are points from the top-left of the
// main display).
//
// The panel sits BESIDE the Settings window, never over it: the list the
// user drops into is in that window. Right side first (the list is in the
// right half of Settings), the left side when there is no room on the right,
// and only when neither side fits does it overlap, at the work area's
// right edge, with no notch pointing at anything.
//
// It is planned against the work area, not the display bounds: macOS slides
// a window placed under the menu bar or the Dock back inside on show (see
// "macOS MOVES a window placed outside the work area" in AGENTS.md).

export type GuideRect = { x: number; y: number; width: number; height: number };

export type GuidePlacement = {
  bounds: GuideRect;
  notch: { side: "left" | "right"; y: number } | null;
};

/** Gap between the Settings window's edge and the panel window's edge. */
export const GUIDE_GAP_PX = 6;
/**
 * The panel window is wider than the card it draws by this much on each
 * side, so the notch on either edge has transparent room to poke into.
 */
export const GUIDE_NOTCH_MARGIN_PX = 8;
/**
 * The Screen & System Audio Recording list starts about this far below the
 * top of the System Settings window (title bar, pane header, description).
 * Measured on macOS 26; only used to aim the notch and align the panel, so
 * a few points of drift between releases costs nothing.
 */
export const SETTINGS_LIST_OFFSET_PX = 150;
/** How far above the list the panel's top sits. */
const PANEL_LEAD_PX = 70;
/** Keep the notch clear of the card's rounded corners. */
const NOTCH_INSET_PX = 26;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function planGuidePlacement(input: {
  settings: GuideRect | null;
  workArea: GuideRect;
  size: { width: number; height: number };
}): GuidePlacement {
  const { settings, workArea: wa, size } = input;
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  const minY = wa.y;
  const maxY = wa.y + wa.height - height;

  if (settings === null) {
    return {
      bounds: {
        x: Math.round(wa.x + (wa.width - width) / 2),
        y: Math.round(clamp(wa.y + (wa.height - height) / 3, minY, maxY)),
        width,
        height
      },
      notch: null
    };
  }

  const listY = settings.y + SETTINGS_LIST_OFFSET_PX;
  const y = Math.round(clamp(listY - PANEL_LEAD_PX, minY, maxY));
  const notchY = Math.round(clamp(listY - y, NOTCH_INSET_PX, height - NOTCH_INSET_PX));

  const rightX = settings.x + settings.width + GUIDE_GAP_PX;
  if (rightX + width <= wa.x + wa.width) {
    return { bounds: { x: Math.round(rightX), y, width, height }, notch: { side: "left", y: notchY } };
  }
  const leftX = settings.x - GUIDE_GAP_PX - width;
  if (leftX >= wa.x) {
    return { bounds: { x: Math.round(leftX), y, width, height }, notch: { side: "right", y: notchY } };
  }
  return {
    bounds: { x: Math.round(wa.x + wa.width - width), y, width, height },
    notch: null
  };
}

/**
 * The System Settings window among a window-list snapshot: the largest
 * layer-0 window owned by `com.apple.systempreferences`. Size, not z-order,
 * because Settings can have a sheet or popover above its main window.
 */
export function findSettingsWindow(
  windows: ReadonlyArray<{ bundleId: string | null; bounds: GuideRect }>
): GuideRect | null {
  let best: GuideRect | null = null;
  for (const w of windows) {
    if (w.bundleId !== SYSTEM_SETTINGS_BUNDLE_ID) continue;
    if (best === null || w.bounds.width * w.bounds.height > best.width * best.height) {
      best = w.bounds;
    }
  }
  return best;
}

export const SYSTEM_SETTINGS_BUNDLE_ID = "com.apple.systempreferences";

export function sameRect(a: GuideRect | null, b: GuideRect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < 1 &&
    Math.abs(a.y - b.y) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}
