// LayerPropertiesPanel — the DetailRail's single-selection inspector.
// Unlike the Layers list's manual comparison accordions, this panel follows
// the editor's canvas selection and presents exactly one layer at a time.

import type { ReactElement } from "react";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { ToolStyleBody } from "../editor/ToolStylePopover";
import { useCaptureModel } from "../editor/useCaptureModel";
import type { LayersPanelApi } from "../editor/Editor";
import { arrowLayerStyle } from "./arrow-layer-style";
import "./LayerPropertiesPanel.css";

export type LayerPropertiesPanelProps = {
  readonly captureId: string;
  readonly selectedLayerIds: readonly string[];
  readonly api: LayersPanelApi | null;
};

function labelForNode(node: BundleLayerNode): string {
  const name = node.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  if (node.kind === "raster") return "Image";
  if (node.kind === "effect") {
    return node.effect.type === "blur" ? "Blur" : "Highlight";
  }
  if (node.kind === "group") return "Group";
  switch (node.shape.kind) {
    case "arrow":
      return "Arrow";
    case "shape":
      return "Shape";
    case "text":
      return "Text";
    case "highlight":
      return "Highlight";
    case "blur":
      return "Blur";
    case "step":
      return "Step";
    case "crop":
      return "Crop";
  }
}

export function LayerPropertiesPanel({
  captureId,
  selectedLayerIds,
  api
}: LayerPropertiesPanelProps): ReactElement {
  const model = useCaptureModel(captureId);
  let body: ReactElement;

  if (model.kind === "loading") {
    body = <p className="psl-layer-properties__empty" role="status">Loading properties…</p>;
  } else if (model.kind === "error") {
    body = <p className="psl-layer-properties__empty" role="status">Couldn’t load properties.</p>;
  } else if (selectedLayerIds.length === 0) {
    body = (
      <p className="psl-layer-properties__empty" role="status">
        Select one layer to inspect its properties.
      </p>
    );
  } else if (selectedLayerIds.length > 1) {
    body = (
      <p className="psl-layer-properties__empty" role="status">
        Select one layer to inspect its properties.
      </p>
    );
  } else {
    const selected = model.layers.find((layer) => layer.id === selectedLayerIds[0]);
    const arrowStyle = selected === undefined ? null : arrowLayerStyle(selected);
    if (selected === undefined) {
      body = (
        <p className="psl-layer-properties__empty" role="status">
          The selected layer is no longer available.
        </p>
      );
    } else if (arrowStyle === null) {
      body = (
        <>
          <p className="psl-layer-properties__selected">{labelForNode(selected)}</p>
          <p className="psl-layer-properties__empty" role="status">
            Editable properties are not available for this layer yet.
          </p>
        </>
      );
    } else {
      body = (
        <>
          <p className="psl-layer-properties__selected">{arrowStyle.label}</p>
          <div className="psl-layer-properties__body">
            <ToolStyleBody
              tool={arrowStyle.tool}
              style={arrowStyle.style}
              onStyleFieldChange={(field, value): void => {
                api?.updateLayerStyle(selected.id, field, value);
              }}
            />
          </div>
        </>
      );
    }
  }

  return (
    <section
      className="psl-layer-properties"
      data-testid="layer-properties-panel"
      aria-label="Selected layer properties"
    >
      <h2 className="psl-layer-properties__heading">Properties</h2>
      {body}
    </section>
  );
}
