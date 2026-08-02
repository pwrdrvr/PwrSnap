// The placed-arrow style projection shared by the Layers list's manual
// comparison accordions and the selected-layer Properties tab. These values
// deliberately come from the stored layer, never the next-tool defaults.

import type { ArrowToolStyle, BundleLayerNode } from "@pwrsnap/shared";
import {
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle
} from "@pwrsnap/shared";
import { storedColorToToolColor } from "../editor/resolveToolColor";

const DEFAULT_LAYER_ARROW_STYLE: ArrowToolStyle = {
  color: "accent",
  thickness: "auto",
  endStyle: "filled-triangle",
  stemStyle: "solid",
  doubleEnded: false
};

export type ArrowLayerStyle = {
  readonly tool: "arrow";
  readonly label: "Arrow";
  readonly style: ArrowToolStyle;
};

export function arrowLayerStyle(node: BundleLayerNode): ArrowLayerStyle | null {
  if (node.kind !== "vector" || node.shape.kind !== "arrow") return null;
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
