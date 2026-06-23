// Pure 2D grid-selection navigation. Given the ordered visible record ids
// (reading order: left→right, top→bottom), the current selection, a
// direction, and the layout (cells per row + rows per page), returns the
// id the selection should move to.
//
// Clamps at the ends — no wrap. Wrapping a 2D grid with arrows is
// disorienting (Right at the end of a row jumping to the start of the next
// is fine because that's just +1 in reading order; but wrapping the whole
// grid end→start is not). With no current selection the first key enters
// from the natural end so the keyboard can take over a fresh grid.
//
// Day-group boundaries: the grid is grouped by day, so ↑/↓ by exactly
// `cellsPerRow` is an approximation across a day's partial last row. It's
// close enough to feel right and avoids threading per-day row geometry
// into the pure layer; precise per-row nav can layer on later if needed.

export type GridNavDir = "left" | "right" | "up" | "down" | "pageup" | "pagedown";

export const GRID_NAV_KEYS: Readonly<Record<string, GridNavDir>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  PageUp: "pageup",
  PageDown: "pagedown"
};

export function nextGridSelectionId(
  orderedIds: readonly string[],
  currentId: string | null,
  dir: GridNavDir,
  cellsPerRow: number,
  rowsPerPage: number
): string | null {
  const n = orderedIds.length;
  if (n === 0) return null;
  const cpr = Math.max(1, Math.floor(cellsPerRow));
  const rpp = Math.max(1, Math.floor(rowsPerPage));

  const idx = currentId === null ? -1 : orderedIds.indexOf(currentId);
  if (idx < 0) {
    // No (or stale) selection — enter from the natural end.
    const towardEnd = dir === "left" || dir === "up" || dir === "pageup";
    return (towardEnd ? orderedIds[n - 1] : orderedIds[0]) ?? null;
  }

  const delta =
    dir === "left"
      ? -1
      : dir === "right"
        ? 1
        : dir === "up"
          ? -cpr
          : dir === "down"
            ? cpr
            : dir === "pageup"
              ? -cpr * rpp
              : cpr * rpp;

  const next = Math.min(n - 1, Math.max(0, idx + delta));
  return orderedIds[next] ?? null;
}
