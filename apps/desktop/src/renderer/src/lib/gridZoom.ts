// Pure helpers for the Library-grid pinch-to-zoom feature. The persisted
// value (`settings.library.gridZoom`) is a *target thumbnail min-width in
// px*; the grid fits as many equal columns as fit at that width, so
// stepping the value up/down snaps the column count. The discrete ladder
// (GRID_ZOOM_LEVELS) and the default/bounds are the shared contract; this
// module owns the snap/step *behavior* used by the renderer.
//
// Kept free of React / DOM so the snapping math is unit-testable in
// isolation. The event plumbing lives in ./useGridPinchZoom.ts.

import {
  GRID_ZOOM_DEFAULT,
  GRID_ZOOM_LEVELS,
  GRID_ZOOM_MAX,
  GRID_ZOOM_MIN
} from "@pwrsnap/shared";

const LEVELS: readonly number[] = GRID_ZOOM_LEVELS;

/** Clamp an arbitrary px value to the valid grid-zoom band. */
export function clampGridZoom(px: number): number {
  if (!Number.isFinite(px)) return GRID_ZOOM_DEFAULT;
  return Math.min(GRID_ZOOM_MAX, Math.max(GRID_ZOOM_MIN, px));
}

/** Index of the level nearest to `px` (after clamping). Ties round down
 *  (toward more columns / smaller thumbnails). */
function nearestLevelIndex(px: number): number {
  const target = clampGridZoom(px);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < LEVELS.length; i++) {
    const dist = Math.abs(LEVELS[i] - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Snap an arbitrary px value (e.g. a persisted setting that predates a
 *  change to the ladder, or a hand-edited file) to the nearest defined
 *  level. Always returns one of GRID_ZOOM_LEVELS. */
export function snapGridZoom(px: number): number {
  return LEVELS[nearestLevelIndex(px)];
}

/** Step from the current value to an adjacent level.
 *
 *  `direction === 1`  → zoom IN  (bigger thumbnails / fewer columns →
 *                                 larger min-width / higher level).
 *  `direction === -1` → zoom OUT (smaller thumbnails / more columns).
 *
 *  The current value is first snapped to the nearest level, so stepping
 *  is well-defined even from an off-ladder persisted value. Stepping past
 *  either end is a no-op (returns the clamped end level). */
export function stepGridZoom(current: number, direction: 1 | -1): number {
  const idx = nearestLevelIndex(current);
  const nextIdx = Math.min(LEVELS.length - 1, Math.max(0, idx + direction));
  return LEVELS[nextIdx];
}
