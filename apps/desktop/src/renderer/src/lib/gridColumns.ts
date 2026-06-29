// Pure column-count math for the Library grid — DOM-free so it's unit-
// testable in isolation (sibling of gridZoom.ts / grid-nav.ts). The event
// plumbing + measurement live in Library.tsx's `useCellsPerRow`.

// Below this grid-pane INNER width (px), bias toward a larger target cell so
// thumbnails don't shrink to where the corner app-source chip is all that's
// legible (the "all icons, no image" symptom).
export const NARROW_GRID_PANE_PX = 560;
// The raised target used under NARROW_GRID_PANE_PX.
export const NARROW_GRID_CELL_MIN = 220;
// Absolute floor on cell width — the column count never produces cells
// smaller than this, so the grid stays readable even at the densest nudge on
// a tight pane.
export const HARD_MIN_CELL_PX = 96;
// Per-notch size ratio for the column nudge. Each step toward fewer columns
// scales the target cell up by this factor (toward more columns, down). ~1.25
// matches the pinch-zoom ladder's spacing, so one notch ≈ one column step
// through the common range while keeping cell sizes consistent.
export const COLUMN_BIAS_RATIO = 1.25;

/** Resolve how many columns to render.
 *
 *  Given the grid pane's INNER width (px, horizontal padding already
 *  removed), the target cell width, the user's column nudge, and the inter-
 *  cell gap, returns the column count.
 *
 *  Two key choices:
 *
 *  1. Round to the column count whose cell width is CLOSEST to the (scaled)
 *     target — NOT the most columns that clear it as a minimum (`floor`).
 *     Floor let cells balloon to ~1.5× the target at low column counts before
 *     adding a column and dropped a column the instant cells hit the target
 *     when shrinking, so the "biggest cell" was much larger at 2 cols than at
 *     4. Round keeps cell sizes centered on the target at every count
 *     (deviation only ~±0.5/N) and puts each breakpoint at the midpoint. (The
 *     ~(N+1)/N size step at a column boundary is inherent to integer columns
 *     and can't be removed.)
 *
 *  2. The nudge SCALES THE TARGET CELL SIZE (`COLUMN_BIAS_RATIO^-bias`), it
 *     does NOT offset the column count. Offsetting decoupled the breakpoint
 *     (width-driven count) from the rendered cells (count + bias), inflating
 *     low-column-count cells by ~|bias|·target/cols — so at a negative nudge
 *     the "smallest cell before dropping" grew from 250px at 4 cols to 322px
 *     at 2 cols. Scaling the target keeps cells centered on the scaled target
 *     at EVERY column count, so sizes stay consistent at any nudge level.
 *
 *  Then: raise the target on a narrow pane, and cap so the densest nudge
 *  can't produce sub-{@link HARD_MIN_CELL_PX} slivers.
 */
export function resolveColumnCount(
  innerWidth: number,
  targetCellWidth: number,
  columnBias: number,
  gap: number
): number {
  if (innerWidth <= 0) return 1;
  const biasedTarget = targetCellWidth * Math.pow(COLUMN_BIAS_RATIO, -columnBias);
  const effectiveTarget =
    innerWidth < NARROW_GRID_PANE_PX
      ? Math.max(biasedTarget, NARROW_GRID_CELL_MIN)
      : biasedTarget;
  const computed = Math.max(
    1,
    Math.round((innerWidth + gap) / (effectiveTarget + gap))
  );
  const maxByHardMin = Math.max(
    1,
    Math.floor((innerWidth + gap) / (HARD_MIN_CELL_PX + gap))
  );
  return Math.min(maxByHardMin, computed);
}
