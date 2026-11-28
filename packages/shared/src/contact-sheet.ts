// Contact sheet layout — one PNG with every cart image laid out in a grid,
// in cart order. Pure geometry shared by main (which bakes the sheet) and
// the cart panel (which shows the dimensions a sheet will have before it is
// made), so the two can never disagree about the size.
//
// Every cell has the same size: the column width (but never wider than the
// widest image, so small snaps do not float in empty cells), and the MEDIAN
// image aspect ratio. Each image fits inside its cell (contain), centered,
// and is never drawn larger than its own pixels. Cells run left to right,
// top to bottom; a short last row stays left-aligned.

export type ContactSheetSize = "s" | "m" | "l";
export type ContactSheetSpacing = "none" | "tight" | "roomy";
export type ContactSheetBackground = "clear" | "hatch" | "black" | "white";
/** `"auto"` or an explicit column count, 1…CONTACT_SHEET_MAX_COLUMNS. */
export type ContactSheetColumns = "auto" | number;

export type ContactSheetLayout = {
  columns: ContactSheetColumns;
  spacing: ContactSheetSpacing;
  background: ContactSheetBackground;
};

export const CONTACT_SHEET_SIZES: readonly ContactSheetSize[] = ["s", "m", "l"];
export const CONTACT_SHEET_WIDTHS: Readonly<Record<ContactSheetSize, number>> = {
  s: 1600,
  m: 2400,
  l: 3600
};
export const CONTACT_SHEET_SPACINGS: readonly ContactSheetSpacing[] = ["none", "tight", "roomy"];
export const CONTACT_SHEET_BACKGROUNDS: readonly ContactSheetBackground[] = [
  "clear",
  "hatch",
  "black",
  "white"
];
export const CONTACT_SHEET_MAX_COLUMNS = 8;
/** Tallest sheet we bake. Past it (or past the pixel cap) the width shrinks. */
export const CONTACT_SHEET_MAX_HEIGHT = 16_384;
export const CONTACT_SHEET_MAX_PIXELS = 64_000_000;
/** Auto columns aim for a sheet about this wide relative to its height. */
export const CONTACT_SHEET_AUTO_ASPECT = 1.5;
/** Gap (and outer padding) as a fraction of the requested sheet width. */
const SPACING_RATIO: Readonly<Record<ContactSheetSpacing, number>> = {
  none: 0,
  tight: 0.006,
  roomy: 0.02
};

export const DEFAULT_CONTACT_SHEET_LAYOUT: ContactSheetLayout = {
  columns: "auto",
  spacing: "tight",
  background: "hatch"
};

export function isContactSheetColumns(value: unknown): value is ContactSheetColumns {
  return (
    value === "auto" ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= CONTACT_SHEET_MAX_COLUMNS)
  );
}

export type ContactSheetImageSize = { width: number; height: number };

export type ContactSheetTile = { x: number; y: number; width: number; height: number };

export type ContactSheetPlan = {
  width: number;
  height: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  padding: number;
  /** One per input image, in input order. */
  tiles: ContactSheetTile[];
  /** True when the size caps forced a narrower sheet than requested. */
  scaledDown: boolean;
};

function sanitizeSize(size: ContactSheetImageSize): ContactSheetImageSize {
  const width = Number.isFinite(size.width) && size.width >= 1 ? Math.floor(size.width) : 1;
  const height = Number.isFinite(size.height) && size.height >= 1 ? Math.floor(size.height) : 1;
  return { width, height };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Gap (and outer padding) for a sheet `widthPx` wide. */
export function contactSheetGap(widthPx: number, spacing: ContactSheetSpacing): number {
  return Math.round(widthPx * SPACING_RATIO[spacing]);
}

/** The column count a layout resolves to for `count` images of median
 *  aspect `cellAspect`. Never more columns than images. `auto` picks the
 *  count whose grid (whole rows, gaps ignored) is closest to 3:2, comparing
 *  ratios so 2:1 and 3:4 are equally far from it; a tie takes fewer columns. */
export function resolveContactSheetColumns(
  columns: ContactSheetColumns,
  count: number,
  cellAspect: number
): number {
  const n = Math.max(1, Math.floor(count));
  const cap = Math.min(n, CONTACT_SHEET_MAX_COLUMNS);
  if (columns !== "auto") {
    return Math.min(cap, Math.max(1, Math.floor(columns)));
  }
  let best = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let cols = 1; cols <= cap; cols++) {
    const sheetAspect = (cols * cellAspect) / Math.ceil(n / cols);
    const distance = Math.abs(Math.log(sheetAspect / CONTACT_SHEET_AUTO_ASPECT));
    if (distance < bestDistance - 1e-12) {
      best = cols;
      bestDistance = distance;
    }
  }
  return best;
}

function planAtWidth(
  sizes: ContactSheetImageSize[],
  requestedWidth: number,
  columns: number,
  spacing: ContactSheetSpacing,
  cellAspect: number
): Omit<ContactSheetPlan, "scaledDown"> {
  const gap = contactSheetGap(requestedWidth, spacing);
  const padding = gap;
  const rows = Math.ceil(sizes.length / columns);
  const widestImage = Math.max(...sizes.map((size) => size.width));
  const cellWidth = Math.max(
    1,
    Math.min(widestImage, Math.floor((requestedWidth - 2 * padding - (columns - 1) * gap) / columns))
  );
  const cellHeight = Math.max(1, Math.round(cellWidth / cellAspect));
  const width = 2 * padding + columns * cellWidth + (columns - 1) * gap;
  const height = 2 * padding + rows * cellHeight + (rows - 1) * gap;
  const tiles = sizes.map((size, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cellX = padding + col * (cellWidth + gap);
    const cellY = padding + row * (cellHeight + gap);
    // Contain, then never past the image's own pixels.
    const scale = Math.min(cellWidth / size.width, cellHeight / size.height, 1);
    const tileWidth = Math.min(cellWidth, Math.max(1, Math.round(size.width * scale)));
    const tileHeight = Math.min(cellHeight, Math.max(1, Math.round(size.height * scale)));
    return {
      x: cellX + Math.floor((cellWidth - tileWidth) / 2),
      y: cellY + Math.floor((cellHeight - tileHeight) / 2),
      width: tileWidth,
      height: tileHeight
    };
  });
  return { width, height, columns, rows, cellWidth, cellHeight, gap, padding, tiles };
}

/**
 * Lay out `images` (pixel sizes, in cart order) on a sheet `widthPx` wide.
 * The result is at most `widthPx` wide (cell rounding trims the remainder, and
 * a cell is never wider than the widest image), at most
 * CONTACT_SHEET_MAX_HEIGHT tall and at most CONTACT_SHEET_MAX_PIXELS; when a
 * cap binds, the sheet is laid out narrower and `scaledDown` is set.
 */
export function planContactSheet(args: {
  images: readonly ContactSheetImageSize[];
  widthPx: number;
  columns: ContactSheetColumns;
  spacing: ContactSheetSpacing;
}): ContactSheetPlan {
  if (args.images.length === 0) {
    throw new Error("A contact sheet needs at least one image");
  }
  const sizes = args.images.map(sanitizeSize);
  const cellAspect = Math.min(
    20,
    Math.max(0.05, median(sizes.map((size) => size.width / size.height)))
  );
  const columns = resolveContactSheetColumns(args.columns, sizes.length, cellAspect);
  let width = Math.max(columns, Math.floor(args.widthPx));
  let plan = planAtWidth(sizes, width, columns, args.spacing, cellAspect);
  let scaledDown = false;
  // Shrink until both caps hold. Each pass estimates the factor from the
  // sheet as laid out (cells capped at the widest image can make it narrower
  // than the request), and the `- 1` guarantees progress even when rounding
  // keeps a plan just over.
  while (
    (plan.height > CONTACT_SHEET_MAX_HEIGHT || plan.width * plan.height > CONTACT_SHEET_MAX_PIXELS) &&
    width > columns
  ) {
    const factor = Math.min(
      CONTACT_SHEET_MAX_HEIGHT / plan.height,
      Math.sqrt(CONTACT_SHEET_MAX_PIXELS / (plan.width * plan.height))
    );
    width = Math.max(columns, Math.min(plan.width - 1, Math.floor(plan.width * factor)));
    plan = planAtWidth(sizes, width, columns, args.spacing, cellAspect);
    scaledDown = true;
  }
  return { ...plan, scaledDown };
}
