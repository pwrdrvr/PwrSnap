// Pure 2D grid-selection navigation over the REAL on-screen layout.
//
// The Library grid is day-grouped: each day is its own sub-grid whose
// items wrap into rows of `cellsPerRow`. So navigation can't just step by
// `cellsPerRow` in a flat list — a day with fewer items than a full row
// (e.g. 2 captures) would make ↓ overshoot into the wrong column of the
// next day. Instead we reconstruct the visual rows from the day groups
// and move like a person expects:
//   • ←/→  : reading order (±1 across rows + day boundaries)
//   • ↑/↓  : same COLUMN in the adjacent visual row (clamped to its width)
//   • Pg   : same column, ±rowsPerPage visual rows
// Clamps at the edges (no wrap). With no current selection the first key
// enters from the natural end.
//
// `dayGroups` is the ordered record-ids per day (the same partition the
// grid renders), so this is cheap — no geometry measurement, no
// header bookkeeping.

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
  dayGroups: readonly (readonly string[])[],
  currentId: string | null,
  dir: GridNavDir,
  cellsPerRow: number,
  rowsPerPage: number
): string | null {
  const cpr = Math.max(1, Math.floor(cellsPerRow));
  const rpp = Math.max(1, Math.floor(rowsPerPage));

  // Build the visual rows (each day chunked into rows of `cpr`) and the
  // flat reading-order sequence in one pass.
  const rows: string[][] = [];
  const flat: string[] = [];
  for (const day of dayGroups) {
    for (let i = 0; i < day.length; i += cpr) {
      rows.push(day.slice(i, i + cpr));
    }
    for (const id of day) flat.push(id);
  }
  if (flat.length === 0) return null;

  // No / stale selection → enter from the natural end.
  const flatIdx = currentId === null ? -1 : flat.indexOf(currentId);
  if (flatIdx < 0) {
    const towardEnd = dir === "left" || dir === "up" || dir === "pageup";
    return (towardEnd ? flat[flat.length - 1] : flat[0]) ?? null;
  }

  // ←/→ move in reading order across rows and day boundaries.
  if (dir === "left" || dir === "right") {
    const next = Math.min(flat.length - 1, Math.max(0, flatIdx + (dir === "right" ? 1 : -1)));
    return flat[next] ?? null;
  }

  // ↑/↓/Page move by visual ROWS, preserving the column.
  let rowIdx = -1;
  let colIdx = 0;
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r]!.indexOf(currentId as string);
    if (c >= 0) {
      rowIdx = r;
      colIdx = c;
      break;
    }
  }
  if (rowIdx < 0) return null; // unreachable (flatIdx >= 0 ⇒ id is in some row)

  const rowDelta = dir === "up" ? -1 : dir === "down" ? 1 : dir === "pageup" ? -rpp : rpp;
  const newRow = Math.min(rows.length - 1, Math.max(0, rowIdx + rowDelta));
  const target = rows[newRow]!;
  // Clamp the column to the target row's width (a narrower row — e.g. a
  // day with only 2 captures, or a partial last row — lands on its last
  // item rather than overshooting).
  const newCol = Math.min(colIdx, target.length - 1);
  return target[newCol] ?? null;
}
