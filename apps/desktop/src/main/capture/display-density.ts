export type DisplayDensity = {
  readonly id: number;
  readonly scaleFactor: number;
};

/** Resolve the scale of the display that produced a capture. Unknown or
 * malformed display metadata is conservatively standard-DPI: inventing 2×
 * detail is worse than omitting a density badge. */
export function displayScaleFactorForId(
  displays: readonly DisplayDensity[],
  displayId: number
): number {
  const scale = displays.find((display) => display.id === displayId)?.scaleFactor;
  return scale !== undefined && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
