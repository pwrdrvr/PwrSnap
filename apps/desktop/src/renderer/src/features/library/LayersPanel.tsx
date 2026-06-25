// LayersPanel — the Library DetailRail "Layers" tab. Lists every layer
// in the selected image capture (top-to-bottom = front-to-back) and
// exposes per-row show/hide, reorder, delete, and — for the crop row —
// a proper "uncrop" that keeps all other annotations correctly placed.
//
// Data source: this panel reads its own `useCaptureModel(captureId)`
// instance. That hook auto-refetches on `events:overlays:changed` /
// `events:captures:changed`, so every mutation (from here OR from the
// canvas) reflects live with no extra wiring.
//
// Actions route through the editor's imperative `LayersPanelApi`
// (published via the chromeless Editor's `onLayersApi` callback and
// threaded down by Library → DetailRail). The editor stays the single
// source of truth for selection; this panel only reads
// `selectedLayerIds` to highlight rows and calls `api.selectLayers`
// on click. See the architecture note in Editor.tsx (`LayersPanelApi`).

import { useMemo, type ReactElement } from "react";
import type { BundleLayerNode } from "@pwrsnap/shared";
import { useCaptureModel } from "../editor/useCaptureModel";
import type { LayersPanelApi } from "../editor/Editor";
import { TOOLS } from "../editor/editor-tools";
import "./LayersPanel.css";

export type LayersPanelProps = {
  readonly captureId: string;
  /** Mirror of the canvas selection (owned by the editor). Drives the
   *  highlighted row. */
  readonly selectedLayerIds: readonly string[];
  /** Imperative editor handle. `null` until the editor publishes it
   *  (e.g. between captures) — buttons no-op while null. */
  readonly api: LayersPanelApi | null;
};

// Reuse the toolbar's tool glyphs so a layer's icon matches the tool
// that drew it. TOOLS uses `currentColor`, so the icons inherit the
// row's text color for free.
const TOOL_ICON: Record<string, ReactElement> = Object.fromEntries(
  TOOLS.map((t) => [t.id, t.icon])
);

const STEP_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v8M9 12h6" strokeLinecap="round" />
  </svg>
);

const IMAGE_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m4 17 5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const EYE_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EYE_OFF_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M3 3l18 18" />
    <path d="M10.6 6.2A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.3 4M6.5 7.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 3.2-.5" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </svg>
);

const UP_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 14 6-6 6 6" />
  </svg>
);

const DOWN_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 10 6 6 6-6" />
  </svg>
);

const TRASH_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7" />
  </svg>
);

function shapeLabel(node: Extract<BundleLayerNode, { kind: "vector" }>): string {
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

function labelForNode(node: BundleLayerNode): string {
  const name = node.name?.trim();
  if (name !== undefined && name.length > 0) return name;
  switch (node.kind) {
    case "raster":
      return "Image";
    case "vector":
      return shapeLabel(node);
    case "effect":
      return node.effect.type === "blur" ? "Blur" : "Highlight";
    case "group":
      return "Group";
  }
}

function iconForNode(node: BundleLayerNode): ReactElement {
  switch (node.kind) {
    case "raster":
      return IMAGE_ICON;
    case "vector":
      return node.shape.kind === "step"
        ? STEP_ICON
        : TOOL_ICON[node.shape.kind] ?? STEP_ICON;
    case "effect":
      return node.effect.type === "blur"
        ? TOOL_ICON.blur ?? STEP_ICON
        : TOOL_ICON.highlight ?? STEP_ICON;
    case "group":
      return STEP_ICON;
  }
}

/** A layer is selectable on the canvas only if it actually renders
 *  there (vector annotations except crop, and blur effects). Crop is a
 *  no-op composite, raster/group have no overlay glyph, and highlight
 *  effects aren't projected yet — clicking those rows shouldn't pretend
 *  to select something the canvas can't outline. */
function isSelectable(node: BundleLayerNode): boolean {
  if (node.kind === "vector") return node.shape.kind !== "crop";
  if (node.kind === "effect") return node.effect.type === "blur";
  return false;
}

function isCropLayer(node: BundleLayerNode): boolean {
  return node.kind === "vector" && node.shape.kind === "crop";
}

/** A crop layer whose rect EXPANDS (w > 1 or h > 1) isn't a real crop —
 *  it's the no-op "inverse crop" the dispatcher leaves behind when a
 *  crop is undone (crop-undo dispatches an expanding rect; the
 *  dispatcher always inserts a crop layer for it). A real user crop
 *  only ever reduces, so its rect stays within [0,1] on both axes.
 *  These artifacts are invisible in the composite, so we hide them
 *  from the panel — otherwise the user sees a phantom "Crop" row on an
 *  uncropped image, and clicking its trash would RE-crop. */
function isSpuriousCropArtifact(node: BundleLayerNode): boolean {
  if (node.kind !== "vector" || node.shape.kind !== "crop") return false;
  const { w, h } = node.shape.rect;
  return w > 1 || h > 1;
}

/** "Base" layers — the Source raster and the Crop viewport — have no
 *  meaningful stacking position: the raster always composites FIRST (every
 *  annotation paints on top of it) and crop is a no-op viewport. They're
 *  pinned at the bottom of the list and aren't reorderable; an annotation
 *  can never move "below" them (it would change the list order but not the
 *  actual render — a no-op the panel shouldn't offer). */
function isBaseLayer(node: BundleLayerNode): boolean {
  return node.kind === "raster" || isCropLayer(node);
}

/** Order within the pinned base group: Crop just above Source, so the
 *  Source image is the very bottom row (the foundation). */
function baseRank(node: BundleLayerNode): number {
  return isCropLayer(node) ? 0 : 1;
}

export function LayersPanel({
  captureId,
  selectedLayerIds,
  api
}: LayersPanelProps): ReactElement {
  const model = useCaptureModel(captureId);

  // Top-to-bottom = front-to-back: the topmost row paints last (highest
  // z_index). Groups are hidden — v2.0 only ever has the synthesized
  // root group, which isn't a user-facing layer. Annotations sort by
  // z_index DESC; the base layers (Source + Crop) are pinned at the
  // BOTTOM regardless of z_index so an annotation never appears below
  // them (which would be a no-op — see isBaseLayer).
  const rows = useMemo<BundleLayerNode[]>(() => {
    if (model.kind !== "loaded") return [];
    const all = model.layers.filter(
      (l) => l.kind !== "group" && !isSpuriousCropArtifact(l)
    );
    const annotations = all
      .filter((l) => !isBaseLayer(l))
      .sort((a, b) => b.z_index - a.z_index);
    const base = all
      .filter(isBaseLayer)
      .sort((a, b) => baseRank(a) - baseRank(b));
    return [...annotations, ...base];
  }, [model]);

  // Annotations occupy the first `annotationCount` rows; the base layers
  // follow. Used to disable the reorder arrows at the stack boundaries.
  const annotationCount = useMemo(
    () => rows.filter((n) => !isBaseLayer(n)).length,
    [rows]
  );

  if (model.kind === "loading") {
    return <div className="psl-layers__empty">Loading layers…</div>;
  }
  if (model.kind === "error") {
    return <div className="psl-layers__empty">Couldn’t load layers.</div>;
  }
  if (rows.length === 0) {
    return <div className="psl-layers__empty">No layers yet.</div>;
  }

  return (
    <div className="psl-layers" role="list" aria-label="Layers" data-testid="psl-layers">
      {rows.map((node, i) => {
        const id = node.id;
        const selected = selectedLayerIds.includes(id);
        const visible = node.visible !== false;
        const baseRaster = node.kind === "raster";
        const crop = isCropLayer(node);
        const base = isBaseLayer(node);
        const selectable = isSelectable(node);
        // Base layers can't be reordered; an annotation can't move above
        // the top of the stack or below the base group (the wall).
        const upDisabled = base || i === 0;
        const downDisabled = base || i === annotationCount - 1;
        return (
          <div
            key={id}
            role="listitem"
            data-testid={`layer-row-${id}`}
            data-kind={node.kind}
            data-selected={selected}
            data-base={base ? "true" : undefined}
            aria-selected={selected}
            className={[
              "psl-layers__row",
              selectable ? "is-selectable" : "",
              selected ? "is-selected" : "",
              base ? "is-base" : "",
              base && i === annotationCount ? "is-base-first" : "",
              visible ? "" : "is-hidden"
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={
              selectable
                ? (e): void => api?.selectLayers(id, e.metaKey || e.ctrlKey)
                : undefined
            }
          >
            <span className="psl-layers__icon" aria-hidden="true">
              {iconForNode(node)}
            </span>
            <span className="psl-layers__label" title={labelForNode(node)}>
              {labelForNode(node)}
            </span>
            <span className="psl-layers__actions">
              <button
                type="button"
                className="psl-layers__btn"
                data-testid={`layer-visibility-${id}`}
                aria-label={visible ? "Hide layer" : "Show layer"}
                aria-pressed={!visible}
                title={visible ? "Hide" : "Show"}
                onClick={(e): void => {
                  e.stopPropagation();
                  void api?.setLayerVisibility(id, !visible);
                }}
              >
                {visible ? EYE_ICON : EYE_OFF_ICON}
              </button>
              <button
                type="button"
                className="psl-layers__btn"
                data-testid={`layer-forward-${id}`}
                aria-label="Bring forward"
                title="Bring forward"
                disabled={upDisabled}
                onClick={(e): void => {
                  e.stopPropagation();
                  void api?.moveLayer(id, "forward");
                }}
              >
                {UP_ICON}
              </button>
              <button
                type="button"
                className="psl-layers__btn"
                data-testid={`layer-backward-${id}`}
                aria-label="Send backward"
                title="Send backward"
                disabled={downDisabled}
                onClick={(e): void => {
                  e.stopPropagation();
                  void api?.moveLayer(id, "backward");
                }}
              >
                {DOWN_ICON}
              </button>
              <button
                type="button"
                className="psl-layers__btn psl-layers__btn--danger"
                data-testid={`layer-delete-${id}`}
                aria-label={crop ? "Remove crop (restore full image)" : "Delete layer"}
                title={crop ? "Remove crop" : "Delete"}
                disabled={baseRaster}
                onClick={(e): void => {
                  e.stopPropagation();
                  if (crop) {
                    void api?.uncrop(id);
                  } else {
                    void api?.deleteLayer(id);
                  }
                }}
              >
                {TRASH_ICON}
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
