// "Add label" for an arrow: where the label's text draft opens, and the
// style it takes from the arrow.
//
// The label is an ordinary text layer once committed — nothing links it
// to the arrow. This module only decides the starting point:
//
//   • It sits just beyond the arrow's TAIL, on the side away from the
//     head, so the text reads as "this is what the arrow is about" and
//     never sits on the stem.
//   • It grows away from the arrow while typing. A text row is anchored
//     at its LEFT edge, so a label left of the tail (an arrow pointing
//     right) is drafted end-aligned and converted to a left anchor at
//     commit, once its width is known (`labelLeftAnchorXn`).
//   • It takes the arrow's color and Border, and the text rung that
//     matches the arrow's thickness rung (S/M/L/XL — `annotation-scale`
//     sizes both off one basis, so an M arrow and M text read as a set).
//
// The old "+ Add label" chip (removed in #674) only ARMED the text tool,
// so the user still had to click the canvas to start typing; it was used
// 0 times across 681 arrows. This opens the draft itself, caret ready.

import type {
  ArrowToolStyle,
  OverlayOutlineMode,
  TextFontWeight,
  TextSizeBucket
} from "@pwrsnap/shared";

/** Which edge of the label sits on the planned anchor. */
export type LabelAlign = "start" | "center" | "end";

export type ArrowLabelPlan = {
  /** Anchor in normalized canvas coords. Vertically it is the label's
   *  middle (the text row convention); horizontally, the edge `align`
   *  names. */
  xn: number;
  yn: number;
  align: LabelAlign;
};

export type ArrowLabelStyle = {
  /** The arrow's persisted color ("auto" or a hex). */
  color: "auto" | string;
  size: TextSizeBucket;
  weight: TextFontWeight;
  outline: OverlayOutlineMode;
};

/** Gap between the tail and the label's near edge, in ems. */
const GAP_EM = 0.5;
/** Width the placeholder ("Label") is assumed to take when choosing a
 *  side, in ems. Only used to keep the starting box on the canvas. */
const ESTIMATED_WIDTH_EM = 3;
/** Half the label's height, in ems (line-height 1, plus the border). */
const HALF_HEIGHT_EM = 0.6;
/** |cos| at or above which the arrow counts as horizontal-ish (60°). */
const HORIZONTAL_COS = 0.5;

/** The text rung for an arrow's thickness rung. `auto` is the Medium
 *  rung for both (see annotation-scale.ts), and an explicit numeric
 *  thickness has no rung, so it gets Medium too. */
export function labelSizeForArrowThickness(
  thickness: ArrowToolStyle["thickness"] | undefined
): TextSizeBucket {
  if (thickness === "small" || thickness === "large" || thickness === "x-large") {
    return thickness;
  }
  return "medium";
}

/** The label's style, from the arrow it labels. Labels are bold: they
 *  sit next to a stroke, and regular-weight text beside a Large arrow
 *  reads as an afterthought. A striped Border has no text form (the
 *  text picker never offers it), so it becomes Auto. */
export function labelStyleForArrow(arrow: {
  color: "auto" | string;
  thickness?: ArrowToolStyle["thickness"] | undefined;
  outline?: OverlayOutlineMode | undefined;
}): ArrowLabelStyle {
  const outline = arrow.outline ?? "auto";
  return {
    color: arrow.color,
    size: labelSizeForArrowThickness(arrow.thickness),
    weight: "bold",
    outline: outline === "stripe" ? "auto" : outline
  };
}

type Box = { left: number; right: number; top: number; bottom: number };

function boxFor(
  ax: number,
  ay: number,
  align: LabelAlign,
  width: number,
  halfHeight: number
): Box {
  const left = align === "start" ? ax : align === "end" ? ax - width : ax - width / 2;
  return { left, right: left + width, top: ay - halfHeight, bottom: ay + halfHeight };
}

function fits(box: Box, canvasW: number, canvasH: number): boolean {
  return box.left >= 0 && box.top >= 0 && box.right <= canvasW && box.bottom <= canvasH;
}

/** Where the label's draft opens. Pure: canvas-pixel math in, normalized
 *  anchor out. `fontPx` is the label's glyph size in canvas pixels. */
export function planArrowLabel(args: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  canvasWidthPx: number;
  canvasHeightPx: number;
  fontPx: number;
}): ArrowLabelPlan {
  const W = Math.max(1, args.canvasWidthPx);
  const H = Math.max(1, args.canvasHeightPx);
  const fx = args.from.x * W;
  const fy = args.from.y * H;
  const dx = args.to.x * W - fx;
  const dy = args.to.y * H - fy;
  const len = Math.hypot(dx, dy);
  // A zero-length arrow cannot be drawn (MIN_DRAG_LENGTH), but stay
  // total: treat it as pointing right.
  const ux = len > 0 ? dx / len : 1;
  const uy = len > 0 ? dy / len : 0;
  const font = Math.max(1, args.fontPx);
  const gap = font * GAP_EM;
  const halfH = font * HALF_HEIGHT_EM;
  const width = font * ESTIMATED_WIDTH_EM;

  type Candidate = { ax: number; ay: number; align: LabelAlign };
  const beside: Candidate =
    ux > 0
      ? { ax: fx - gap, ay: fy, align: "end" }
      : { ax: fx + gap, ay: fy, align: "start" };
  // Above or below the tail, centered on it. "Away" is the side the head
  // is not on; a flat arrow has no vertical preference, so below first.
  const above: Candidate = { ax: fx, ay: fy - gap - halfH, align: "center" };
  const below: Candidate = { ax: fx, ay: fy + gap + halfH, align: "center" };
  const awayVertical = uy > 0 ? above : below;
  const towardVertical = uy > 0 ? below : above;

  const horizontal = Math.abs(ux) >= HORIZONTAL_COS;
  const candidates: Candidate[] = horizontal
    ? [beside, awayVertical, towardVertical]
    : [awayVertical, beside, towardVertical];

  const chosen =
    candidates.find((c) => fits(boxFor(c.ax, c.ay, c.align, width, halfH), W, H)) ??
    candidates[0]!;

  // Nothing fits (a tiny capture, or a tail jammed into a corner): keep
  // the preferred side and slide the box back onto the canvas.
  const box = boxFor(chosen.ax, chosen.ay, chosen.align, width, halfH);
  const shiftX = box.left < 0 ? -box.left : box.right > W ? W - box.right : 0;
  const shiftY = box.top < 0 ? -box.top : box.bottom > H ? H - box.bottom : 0;
  return {
    xn: (chosen.ax + shiftX) / W,
    yn: (chosen.ay + shiftY) / H,
    align: chosen.align
  };
}

/** The persisted LEFT anchor for a label drafted with `align` at `xn`,
 *  once its rendered width is known (`widthFrac`, a fraction of the
 *  canvas width). Kept on the canvas when the label is narrower than it. */
export function labelLeftAnchorXn(xn: number, align: LabelAlign, widthFrac: number): number {
  const w = Number.isFinite(widthFrac) && widthFrac > 0 ? widthFrac : 0;
  const left = align === "start" ? xn : align === "end" ? xn - w : xn - w / 2;
  if (w >= 1) return left;
  return Math.min(Math.max(left, 0), 1 - w);
}
