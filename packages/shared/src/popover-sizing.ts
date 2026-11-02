/** Responsive sizing shared by the tray and post-capture popovers.
 *
 * Inputs are display work-area dimensions in DIP, never the current
 * BrowserWindow viewport. The popovers size their windows from renderer
 * content, so using `innerWidth` / `innerHeight` here would close a feedback
 * loop that a shrunken window could never grow back out of.
 */

export type PopoverDensity = "regular" | "compact";
export type PopoverKind = "tray" | "float-over";

export const POPOVER_COMPACT_BREAKPOINT_DIP = 800;
export const FLOAT_OVER_RAIL_MIN_WORK_AREA_WIDTH_DIP = 700;

export const TRAY_WIDTH_REGULAR_DIP = 440;
export const TRAY_WIDTH_COMPACT_DIP = 360;
export const FLOAT_OVER_WIDTH_REGULAR_DIP = 392;
export const FLOAT_OVER_WIDTH_COMPACT_DIP = 320;

const HORIZONTAL_MARGIN_DIP: Readonly<Record<PopoverKind, number>> = {
  tray: 8,
  "float-over": 48
};

function validDimension(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A short or narrow work area gets the denser surface. Unknown dimensions
 * preserve the regular layout rather than collapsing a pre-warmed window. */
export function popoverDensityForWorkArea(options: {
  readonly widthDip: number | null | undefined;
  readonly heightDip: number | null | undefined;
}): PopoverDensity {
  const dimensions = [validDimension(options.widthDip), validDimension(options.heightDip)].filter(
    (value): value is number => value !== null
  );
  if (dimensions.length === 0) return "regular";
  return Math.min(...dimensions) <= POPOVER_COMPACT_BREAKPOINT_DIP ? "compact" : "regular";
}

/** Width in DIP, including a final fit-to-work-area clamp for unusually
 * narrow virtual displays. */
export function popoverWidthDip(options: {
  readonly kind: PopoverKind;
  readonly workAreaWidthDip: number | null | undefined;
  readonly workAreaHeightDip: number | null | undefined;
}): number {
  const density = popoverDensityForWorkArea({
    widthDip: options.workAreaWidthDip,
    heightDip: options.workAreaHeightDip
  });
  const regular = options.kind === "tray" ? TRAY_WIDTH_REGULAR_DIP : FLOAT_OVER_WIDTH_REGULAR_DIP;
  const compact = options.kind === "tray" ? TRAY_WIDTH_COMPACT_DIP : FLOAT_OVER_WIDTH_COMPACT_DIP;
  const target = density === "compact" ? compact : regular;
  const workAreaWidth = validDimension(options.workAreaWidthDip);
  if (workAreaWidth === null) return target;
  return Math.max(1, Math.min(target, Math.floor(workAreaWidth - HORIZONTAL_MARGIN_DIP[options.kind])));
}

/** Width in renderer CSS pixels. Main multiplies this measurement by the
 * same zoom factor before calling BrowserWindow.setContentSize. */
export function popoverWidthCss(options: {
  readonly kind: PopoverKind;
  readonly workAreaWidthDip: number | null | undefined;
  readonly workAreaHeightDip: number | null | undefined;
  readonly zoomFactor: number;
}): number {
  const zoom =
    Number.isFinite(options.zoomFactor) && options.zoomFactor > 0 ? options.zoomFactor : 1;
  return Math.max(1, Math.floor(popoverWidthDip(options) / zoom));
}

/** The recent rail is useful only when it does not consume most of a narrow
 * display. Unknown work-area width preserves the existing rail behavior. */
export function floatOverRailFits(workAreaWidthDip: number | null | undefined): boolean {
  const width = validDimension(workAreaWidthDip);
  return width === null || width >= FLOAT_OVER_RAIL_MIN_WORK_AREA_WIDTH_DIP;
}
