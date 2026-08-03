// Projection shared by the Layers list's manual comparison accordions and
// the selected-layer Properties tab. Every value comes from the stored layer,
// never the active tool's defaults for the next drawing.

import type {
  ArrowToolStyle,
  BlurToolStyle,
  BundleLayerNode,
  HighlightToolStyle,
  ShapeKind,
  ShapeToolStyle,
  TextToolStyle
} from "@pwrsnap/shared";
import {
  DEFAULT_BLUR_STYLE,
  DEFAULT_HIGHLIGHT_BLEND_MODE,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  deriveBlurRadiusPx,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle,
  readBlurStyle,
  readHighlightBlend,
  readHighlightOpacity,
  readShapeFilled,
  readShapeKind,
  readShapeSkewDeg
} from "@pwrsnap/shared";
import { storedColorToToolColor } from "../editor/resolveToolColor";

const DEFAULT_LAYER_ARROW_STYLE: ArrowToolStyle = {
  color: "accent",
  thickness: "auto",
  endStyle: "filled-triangle",
  stemStyle: "solid",
  doubleEnded: false
};

const DEFAULT_LAYER_TEXT_STYLE: TextToolStyle = {
  color: "accent",
  fontSize: "auto",
  weight: "regular"
};

const DEFAULT_LAYER_SHAPE_STYLE: ShapeToolStyle = {
  color: "accent",
  thickness: "auto",
  filled: false,
  shape: "rect",
  skewDeg: DEFAULT_PARALLELOGRAM_SKEW_DEG
};

const DEFAULT_LAYER_BLUR_STYLE: BlurToolStyle = {
  mode: DEFAULT_BLUR_STYLE,
  radius: { mode: "auto" }
};

const DEFAULT_LAYER_HIGHLIGHT_STYLE: HighlightToolStyle = {
  color: "yellow",
  opacity: DEFAULT_HIGHLIGHT_OPACITY,
  blend: DEFAULT_HIGHLIGHT_BLEND_MODE
};

const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "Rectangle",
  square: "Square",
  circle: "Circle",
  oval: "Oval",
  parallelogram: "Parallelogram"
};

export type StyledLayerStyle =
  | {
      readonly tool: "arrow";
      readonly label: "Arrow";
      readonly style: ArrowToolStyle;
    }
  | {
      readonly tool: "text";
      readonly label: "Text";
      readonly style: TextToolStyle;
    }
  | {
      readonly tool: "shape";
      readonly label: string;
      readonly style: ShapeToolStyle;
    }
  | {
      readonly tool: "blur";
      readonly label: "Blur";
      readonly style: BlurToolStyle;
    }
  | {
      readonly tool: "highlight";
      readonly label: "Highlight";
      readonly style: HighlightToolStyle;
    };

/**
 * Return the human-editable tool style for a placed layer. Vector blur and
 * highlight layers remain supported for older bundles; current layers store
 * those two as effects, so both forms deliberately project here.
 */
export function styledLayerStyle(
  node: BundleLayerNode,
  canvas: { width: number; height: number }
): StyledLayerStyle | null {
  if (node.kind === "effect") {
    if (node.effect.type === "blur") {
      const autoRadiusPx = deriveBlurRadiusPx(canvas);
      return {
        tool: "blur",
        label: "Blur",
        style: {
          ...DEFAULT_LAYER_BLUR_STYLE,
          mode: node.effect.style ?? DEFAULT_LAYER_BLUR_STYLE.mode,
          // Effect layers must persist a concrete radius for the compositor,
          // including Auto. Reconstitute the user-facing Auto selection when
          // that stored radius is the canonical one for this canvas; otherwise
          // expose the explicit custom value.
          radius:
            node.effect.radius_px === autoRadiusPx
              ? { mode: "auto" }
              : { mode: "px", value: node.effect.radius_px }
        }
      };
    }
    return {
      tool: "highlight",
      label: "Highlight",
      style: {
        ...DEFAULT_LAYER_HIGHLIGHT_STYLE,
        color: storedColorToToolColor(
          node.effect.tint_hex,
          DEFAULT_LAYER_HIGHLIGHT_STYLE.color
        ),
        opacity: node.effect.opacity,
        blend: node.effect.blend ?? DEFAULT_LAYER_HIGHLIGHT_STYLE.blend
      }
    };
  }

  if (node.kind !== "vector") return null;

  switch (node.shape.kind) {
    case "arrow": {
      const arrow = node.shape;
      return {
        tool: "arrow",
        label: "Arrow",
        style: {
          ...DEFAULT_LAYER_ARROW_STYLE,
          color: storedColorToToolColor(arrow.color, DEFAULT_LAYER_ARROW_STYLE.color),
          thickness: arrow.thickness ?? DEFAULT_LAYER_ARROW_STYLE.thickness,
          endStyle: readArrowEndStyle(arrow),
          stemStyle: readArrowStemStyle(arrow),
          doubleEnded: readArrowDoubleEnded(arrow)
        }
      };
    }
    case "text": {
      const text = node.shape;
      return {
        tool: "text",
        label: "Text",
        style: {
          ...DEFAULT_LAYER_TEXT_STYLE,
          color: storedColorToToolColor(text.color, DEFAULT_LAYER_TEXT_STYLE.color),
          fontSize: text.size,
          // Old text rows have no explicit field but render at the historic
          // semi-bold weight. Bold is the closest editable representation.
          weight: text.weight ?? "bold"
        }
      };
    }
    case "shape": {
      const shape = node.shape;
      const kind = readShapeKind(shape);
      return {
        tool: "shape",
        label: SHAPE_LABELS[kind],
        style: {
          ...DEFAULT_LAYER_SHAPE_STYLE,
          color: storedColorToToolColor(shape.color, DEFAULT_LAYER_SHAPE_STYLE.color),
          thickness: shape.thickness ?? DEFAULT_LAYER_SHAPE_STYLE.thickness,
          filled: readShapeFilled(shape),
          shape: kind,
          skewDeg:
            kind === "parallelogram"
              ? readShapeSkewDeg(shape)
              : DEFAULT_LAYER_SHAPE_STYLE.skewDeg
        }
      };
    }
    case "blur": {
      const blur = node.shape;
      return {
        tool: "blur",
        label: "Blur",
        style: {
          ...DEFAULT_LAYER_BLUR_STYLE,
          mode: readBlurStyle(blur),
          ...(blur.radiusPx !== undefined
            ? { radius: { mode: "px" as const, value: blur.radiusPx } }
            : {})
        }
      };
    }
    case "highlight": {
      const highlight = node.shape;
      return {
        tool: "highlight",
        label: "Highlight",
        style: {
          ...DEFAULT_LAYER_HIGHLIGHT_STYLE,
          color: storedColorToToolColor(
            highlight.color,
            DEFAULT_LAYER_HIGHLIGHT_STYLE.color
          ),
          opacity: readHighlightOpacity(highlight),
          blend: readHighlightBlend(highlight)
        }
      };
    }
    case "step":
    case "crop":
      return null;
  }
}
