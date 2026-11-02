// Tool-bag slot glyph + name. A slot is recognized at a glance by
// drawing the thing it would draw — a red filled-head arrow, a yellow
// bar-ended range, a hollow red box — in its real color, so nine slots
// read without labels. The name is for the tooltip and the accessible
// label.

import type { ReactElement } from "react";
import type {
  ArrowToolStyle,
  DrawToolStyle,
  ShapeToolStyle,
  ToolBagSlot,
  ToolColor,
  ToolSizePreset
} from "@pwrsnap/shared";
import { DEFAULT_MARKER_OPACITY, isColorToken } from "@pwrsnap/shared";
import { ShapeIcon, type ShapeIconBox, type ShapeIconPatternUnit } from "./ShapeIcon";

const COLOR_NAMES: Record<string, string> = {
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  gray: "Gray",
  black: "Black",
  white: "White",
  accent: "Accent"
};

/** Paint for a tool color: named swatches follow the theme through
 *  their CSS variable, a custom color is used as written. */
export function glyphPaint(color: ToolColor): string {
  return isColorToken(color) ? `var(--swatch-${color})` : color;
}

function colorName(color: ToolColor): string {
  return COLOR_NAMES[color] ?? "Custom";
}

/** " dashed" / " dotted" / "" — the arrow stem and the shape outline
 *  share one value space, so they share one word. */
function patternWord(pattern: ArrowToolStyle["stemStyle"]): string {
  return pattern === "solid" ? "" : ` ${pattern}`;
}

/** Short human name for a slot: "Red arrow", "Yellow range",
 *  "Red dashed box", "Blur". A saved label wins. */
export function describeBagSlot(slot: ToolBagSlot): string {
  const label = slot.label?.trim();
  if (label !== undefined && label.length > 0) return label;
  switch (slot.tool) {
    case "arrow": {
      const s = slot.style;
      const noun =
        s.endStyle === "bar" ? "range" : s.doubleEnded ? "double arrow" : "arrow";
      return `${colorName(s.color)}${patternWord(s.stemStyle)} ${noun}`;
    }
    case "shape": {
      const s = slot.style;
      const noun =
        s.shape === "rect" || s.shape === "square"
          ? "box"
          : s.shape === "parallelogram"
            ? "parallelogram"
            : s.shape;
      // A filled shape has no outline, so its stroke pattern is inert
      // and goes unnamed.
      const look = s.filled ? " filled" : patternWord(s.strokeStyle);
      return `${colorName(s.color)}${look} ${noun}`;
    }
    case "text":
      return `${colorName(slot.style.color)} text`;
    case "highlight":
      return `${colorName(slot.style.color)} highlight`;
    case "blur":
      return slot.style.mode === "redact"
        ? "Redact"
        : slot.style.mode === "pixelate"
          ? "Pixelate"
          : "Blur";
    case "draw":
      // Settings never store an eraser slot; name one anyway rather than
      // calling it a colored "eraser".
      return slot.style.mode === "eraser"
        ? "Eraser"
        : `${colorName(slot.style.color)} ${slot.style.mode}`;
  }
}

function strokeFor(thickness: ToolSizePreset | number): number {
  switch (thickness) {
    case "small":
      return 1.6;
    case "large":
      return 2.8;
    case "x-large":
      return 3.4;
    default:
      return 2.2;
  }
}

function dashFor(stem: ArrowToolStyle["stemStyle"]): string | undefined {
  if (stem === "dashed") return "3 2.5";
  if (stem === "dotted") return "0.1 3";
  return undefined;
}

/** One arrow end, drawn pointing +x with its tip at (21, 12). Returns
 *  where the stem should stop so it does not poke through a head. */
function arrowEnd(
  endStyle: ArrowToolStyle["endStyle"],
  paint: string,
  w: number
): { el: ReactElement | null; stemTo: number } {
  switch (endStyle) {
    case "filled-triangle":
      return {
        el: <path d="M21 12 L14.5 8 L14.5 16 Z" fill={paint} />,
        stemTo: 15
      };
    case "open-triangle":
      return {
        el: (
          <path
            d="M15 7.5 L21 12 L15 16.5"
            fill="none"
            stroke={paint}
            strokeWidth={w}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
        stemTo: 20.5
      };
    case "dot":
      return { el: <circle cx="19" cy="12" r="2.8" fill={paint} />, stemTo: 18 };
    case "bar":
      return {
        el: (
          <line x1="21" y1="6.5" x2="21" y2="17.5" stroke={paint} strokeWidth={w} strokeLinecap="round" />
        ),
        stemTo: 21
      };
    case "line":
      return { el: null, stemTo: 21 };
  }
}

function ArrowGlyph({ style }: { style: ArrowToolStyle }): ReactElement {
  const paint = glyphPaint(style.color);
  const w = strokeFor(style.thickness);
  const head = arrowEnd(style.endStyle, paint, w);
  const tail = style.doubleEnded ? arrowEnd(style.endStyle, paint, w) : null;
  const stemFrom = tail === null ? 3 : 24 - tail.stemTo;
  const dash = dashFor(style.stemStyle);
  return (
    // A range reads as a range when it lies flat; everything else is
    // drawn on the diagonal an annotation arrow usually takes.
    <g transform={style.endStyle === "bar" ? undefined : "rotate(-40 12 12)"}>
      <line
        x1={stemFrom}
        y1="12"
        x2={head.stemTo}
        y2="12"
        stroke={paint}
        strokeWidth={w}
        strokeLinecap="round"
        {...(dash !== undefined ? { strokeDasharray: dash } : {})}
      />
      {head.el}
      {tail?.el !== null && tail !== null && (
        <g transform="translate(24 0) scale(-1 1)">{tail.el}</g>
      )}
    </g>
  );
}

/** Glyph-space boxes (24×24 viewBox) — the one statement of each shape
 *  glyph's geometry; `ShapeIcon` builds the primitive and its dash
 *  pattern from it. */
const GLYPH_SHAPE_BOX: Record<ShapeToolStyle["shape"], ShapeIconBox> = {
  rect: { cx: 12, cy: 12, w: 18, h: 11 },
  square: { cx: 12, cy: 12, w: 15, h: 15 },
  circle: { cx: 12, cy: 12, w: 15, h: 15 },
  oval: { cx: 12, cy: 12, w: 18, h: 12 },
  parallelogram: { cx: 12, cy: 12, w: 14, h: 11, shear: 2 }
};

/** A few dashes or dots per side at 22px: dashed lands near 3-on /
 *  1.5-off, dotted near a 3px pitch. */
const GLYPH_PATTERN_UNIT: ShapeIconPatternUnit = { dashed: 0.75, dotted: 1.7 };

function ShapeGlyph({ style }: { style: ShapeToolStyle }): ReactElement {
  const paint = glyphPaint(style.color);
  return (
    <ShapeIcon
      shape={style.shape}
      box={GLYPH_SHAPE_BOX[style.shape]}
      paint={
        style.filled
          ? { fill: paint }
          : { fill: "none", stroke: paint, strokeWidth: strokeFor(style.thickness) }
      }
      strokeStyle={style.filled ? "solid" : style.strokeStyle}
      patternUnit={GLYPH_PATTERN_UNIT}
    />
  );
}

/** A pen loop, a flat marker band, or a soft airbrush line — the board 4c
 *  glyphs, in the slot's color. */
function DrawGlyph({ style }: { style: DrawToolStyle }): ReactElement {
  const paint = glyphPaint(style.color);
  switch (style.mode) {
    case "marker":
      return (
        <line
          x1="3"
          y1="13"
          x2="21"
          y2="13"
          stroke={paint}
          strokeWidth="7"
          strokeLinecap="butt"
          opacity={DEFAULT_MARKER_OPACITY + 0.2}
        />
      );
    case "airbrush":
      return (
        <g fill="none" stroke={paint} strokeLinecap="round">
          <path d="M5 15c4-6 10-6 14-3" strokeWidth="8" opacity="0.2" />
          <path d="M5 15c4-6 10-6 14-3" strokeWidth="5" opacity="0.35" />
          <path d="M5 15c4-6 10-6 14-3" strokeWidth="2.5" />
        </g>
      );
    case "eraser":
      return (
        <path
          d="M9.5 19 4 13.5l8.5-8.5 7.5 7.5-6.5 6.5zM7 10.5l7.5 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      );
    case "pen":
      return (
        <path
          d="M3.5 16c3.5-11 6.5-11 8.5-4s5 7 8.5-5"
          fill="none"
          stroke={paint}
          strokeWidth={strokeFor(style.thickness)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

export function ToolBagGlyph({ slot }: { slot: ToolBagSlot }): ReactElement {
  let body: ReactElement;
  switch (slot.tool) {
    case "arrow":
      body = <ArrowGlyph style={slot.style} />;
      break;
    case "shape":
      body = <ShapeGlyph style={slot.style} />;
      break;
    case "text":
      body = (
        <text
          x="12"
          y="17.5"
          textAnchor="middle"
          fontSize="16"
          fontWeight={slot.style.weight === "bold" ? 800 : 600}
          fill={glyphPaint(slot.style.color)}
        >
          T
        </text>
      );
      break;
    case "highlight":
      body = (
        <rect
          x="2.5"
          y="8"
          width="19"
          height="8"
          rx="1.5"
          fill={glyphPaint(slot.style.color)}
          opacity={Math.max(0.35, slot.style.opacity)}
        />
      );
      break;
    case "blur":
      body =
        slot.style.mode === "redact" ? (
          <rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor" />
        ) : slot.style.mode === "pixelate" ? (
          <g fill="currentColor">
            <rect x="4" y="6" width="5" height="5" opacity="0.9" />
            <rect x="9.5" y="6" width="5" height="5" opacity="0.45" />
            <rect x="15" y="6" width="5" height="5" opacity="0.75" />
            <rect x="4" y="13" width="5" height="5" opacity="0.5" />
            <rect x="9.5" y="13" width="5" height="5" opacity="0.85" />
            <rect x="15" y="13" width="5" height="5" opacity="0.35" />
          </g>
        ) : (
          <g fill="currentColor">
            <circle cx="12" cy="12" r="7.5" opacity="0.25" />
            <circle cx="12" cy="12" r="5" opacity="0.45" />
            <circle cx="12" cy="12" r="2.5" opacity="0.9" />
          </g>
        );
      break;
    case "draw":
      body = <DrawGlyph style={slot.style} />;
      break;
  }
  return (
    <svg className="psl__bag-glyph" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {body}
    </svg>
  );
}
