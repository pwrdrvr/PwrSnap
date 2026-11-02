// Small shape icon — the primitive the tool bag glyph and the Layers
// list preview both draw. The box is the ONE statement of each icon's
// geometry: the primitive is built from it, and so is the outline's
// dash pattern, so the two can never disagree about the perimeter.
//
// A patterned outline uses the same corner-aligned pattern as the
// editor canvas and the bake (`computeShapeStrokeDash`): every corner
// sits in the middle of a dash or on a dot. Only the pattern UNIT is
// icon-sized — the canvas measures it in painted stroke widths, which
// at icon scale would leave one dash per side.

import type { ReactElement } from "react";
import type { ShapeKind, ShapeStrokeStyle } from "@pwrsnap/shared";
import { computeShapeStrokeDash } from "@pwrsnap/shared";

/** Icon-space bounding box. `shear` (parallelogram only) is how far the
 *  top edge sits right of centre, and the bottom edge left of it. */
export type ShapeIconBox = {
  cx: number;
  cy: number;
  w: number;
  h: number;
  shear?: number;
};

/** Pattern unit per style, in icon units. */
export type ShapeIconPatternUnit = { dashed: number; dotted: number };

export type ShapeIconPaint = {
  fill: string;
  fillOpacity?: number | undefined;
  stroke?: string | undefined;
  strokeWidth?: number | undefined;
};

export function ShapeIcon({
  shape,
  box,
  paint,
  strokeStyle,
  patternUnit
}: {
  shape: ShapeKind;
  box: ShapeIconBox;
  paint: ShapeIconPaint;
  /** Outline pattern; pass "solid" when there is no outline to pattern
   *  (a filled shape). */
  strokeStyle: ShapeStrokeStyle;
  patternUnit: ShapeIconPatternUnit;
}): ReactElement {
  const shear = box.shear ?? 0;
  const skewDeg = (Math.atan2(shear, box.h / 2) * 180) / Math.PI;
  const dash =
    strokeStyle === "solid" || paint.stroke === undefined
      ? null
      : computeShapeStrokeDash(strokeStyle, shape, box.w, box.h, skewDeg, patternUnit[strokeStyle]);
  const props = {
    fill: paint.fill,
    ...(paint.fillOpacity !== undefined ? { fillOpacity: paint.fillOpacity } : {}),
    ...(paint.stroke !== undefined
      ? { stroke: paint.stroke, strokeWidth: paint.strokeWidth, strokeLinejoin: "round" as const }
      : {}),
    // Round caps: a dotted dash is only a dot through its cap.
    ...(dash !== null
      ? {
          strokeDasharray: dash.dasharray,
          strokeLinecap: "round" as const,
          ...(dash.dashoffset !== 0 ? { strokeDashoffset: dash.dashoffset } : {})
        }
      : {})
  };
  const left = box.cx - box.w / 2;
  const top = box.cy - box.h / 2;
  switch (shape) {
    case "circle":
    case "oval":
      return <ellipse cx={box.cx} cy={box.cy} rx={box.w / 2} ry={box.h / 2} {...props} />;
    case "parallelogram": {
      // Same vertex order as the canvas polygon: the pattern starts at
      // the sheared top-left corner.
      const right = left + box.w;
      const bottom = top + box.h;
      const points = `${left + shear},${top} ${right + shear},${top} ${right - shear},${bottom} ${left - shear},${bottom}`;
      return <polygon points={points} {...props} />;
    }
    case "rect":
    case "square":
      // A rounded rect's path starts past the corner radius, which would
      // put the pattern out of phase with the corners; a patterned
      // outline is square-cornered and its round joins soften the bends.
      return (
        <rect
          x={left}
          y={top}
          width={box.w}
          height={box.h}
          {...(dash === null ? { rx: 1 } : {})}
          {...props}
        />
      );
  }
}
