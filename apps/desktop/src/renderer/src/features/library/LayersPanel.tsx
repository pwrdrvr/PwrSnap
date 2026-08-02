// LayersPanel — the Library DetailRail "Layers" tab. Lists every layer
// in the selected image capture (top-to-bottom = front-to-back) and
// exposes per-row show/hide, reorder, delete, direct style comparison for
// placed annotation tools, and — for the crop row — a proper "uncrop" that
// keeps all other annotations correctly placed.
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from "react";
import type { ArrowToolStyle, BundleLayerNode } from "@pwrsnap/shared";
import {
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle
} from "@pwrsnap/shared";
import { useCaptureModel } from "../editor/useCaptureModel";
import type { LayersPanelApi } from "../editor/Editor";
import { isBaseLayer, isCropLayer, isSourceRaster } from "../editor/layer-roles";
import { selectBaseRaster } from "../editor/base-raster";
import { affineTransformsEqual } from "../editor/raster-resize";
import { TOOLS } from "../editor/editor-tools";
import { ToolStyleBody } from "../editor/ToolStylePopover";
import { styledLayerStyle } from "./styled-layer-style";
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

const GRIP_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.4" />
    <circle cx="15" cy="6" r="1.4" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
    <circle cx="9" cy="18" r="1.4" />
    <circle cx="15" cy="18" r="1.4" />
  </svg>
);

const TRASH_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7" />
  </svg>
);

// Counterclockwise circular arrow — "restore to original".
const RESET_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const CHEVRON_ICON: ReactElement = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m9 5 7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
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

function previewColor(color: string | undefined): string {
  return color === undefined || color === "auto" ? "var(--accent)" : color;
}

function previewStrokeWidth(thickness: ArrowToolStyle["thickness"] | undefined): number {
  switch (thickness) {
    case "small":
      return 1.25;
    case "medium":
      return 2;
    case "large":
      return 2.8;
    case "x-large":
      return 3.6;
    default:
      return 1.7;
  }
}

function previewId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function ArrowPreview({
  node
}: {
  readonly node: Extract<BundleLayerNode, { kind: "vector" }>;
}): ReactElement {
  const arrow = node.shape;
  if (arrow.kind !== "arrow") return IMAGE_ICON;
  const dx = arrow.to.x - arrow.from.x;
  const dy = arrow.to.y - arrow.from.y;
  // Scale the real direction vector into the 48×28 preview while
  // preserving horizontal / vertical arrows (a fixed diagonal glyph
  // would make two opposite callouts indistinguishable in a dense list).
  const scale = Math.max(Math.abs(dx) / 17, Math.abs(dy) / 9, 0.0001);
  const x1 = 24 - dx / scale;
  const y1 = 14 - dy / scale;
  const x2 = 24 + dx / scale;
  const y2 = 14 + dy / scale;
  const color = previewColor(arrow.color);
  const endStyle = readArrowEndStyle(arrow);
  const markerId = `layer-arrow-end-${previewId(node.id)}`;
  const dash =
    readArrowStemStyle(arrow) === "dashed"
      ? "4 2.5"
      : readArrowStemStyle(arrow) === "dotted"
        ? "1 2.5"
        : undefined;

  return (
    <svg viewBox="0 0 48 28" aria-hidden="true">
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          {endStyle === "filled-triangle" ? (
            <path d="M1 1 9 5 1 9Z" fill={color} />
          ) : endStyle === "open-triangle" ? (
            <path d="M1 1 9 5 1 9" fill="none" stroke={color} strokeWidth="1.5" />
          ) : endStyle === "dot" ? (
            <circle cx="5" cy="5" r="3" fill={color} />
          ) : (
            <path d="M6 1v8" fill="none" stroke={color} strokeWidth="1.5" />
          )}
        </marker>
      </defs>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={color}
        strokeWidth={previewStrokeWidth(arrow.thickness)}
        strokeLinecap="round"
        {...(dash !== undefined ? { strokeDasharray: dash } : {})}
        markerEnd={`url(#${markerId})`}
        {...(readArrowDoubleEnded(arrow)
          ? { markerStart: `url(#${markerId})` }
          : {})}
      />
    </svg>
  );
}

function ShapePreview({
  node
}: {
  readonly node: Extract<BundleLayerNode, { kind: "vector" }>;
}): ReactElement {
  const shape = node.shape;
  if (shape.kind !== "shape") return IMAGE_ICON;
  const color = previewColor(shape.color);
  const paint = {
    fill: shape.filled ? color : "none",
    fillOpacity: shape.filled ? 0.22 : undefined,
    stroke: color,
    strokeWidth: previewStrokeWidth(shape.thickness)
  };
  switch (shape.shape ?? "rect") {
    case "circle":
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <circle cx="24" cy="14" r="8" {...paint} />
        </svg>
      );
    case "oval":
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <ellipse cx="24" cy="14" rx="15" ry="8" {...paint} />
        </svg>
      );
    case "parallelogram":
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <polygon points="13,5 39,5 34,23 8,23" {...paint} />
        </svg>
      );
    case "square":
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <rect x="16" y="5" width="16" height="18" rx="1" {...paint} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <rect x="8" y="6" width="32" height="16" rx="1" {...paint} />
        </svg>
      );
  }
}

function previewForNode(node: BundleLayerNode): ReactElement {
  if (node.kind === "vector") {
    switch (node.shape.kind) {
      case "arrow":
        return <ArrowPreview node={node} />;
      case "shape":
        return <ShapePreview node={node} />;
      case "text":
        return (
          <svg viewBox="0 0 48 28" aria-hidden="true">
            <text
              x="24"
              y="20"
              textAnchor="middle"
              fill={previewColor(node.shape.color)}
              fontSize="17"
              fontWeight="700"
              fontFamily="var(--font-sans)"
            >
              T
            </text>
          </svg>
        );
      case "highlight":
        return (
          <svg viewBox="0 0 48 28" aria-hidden="true">
            <rect
              x="7"
              y="7"
              width="34"
              height="14"
              rx="2"
              fill={previewColor(node.shape.color)}
              fillOpacity={node.shape.opacity ?? 0.3}
            />
            <path d="M8 19 39 9" stroke="currentColor" strokeOpacity="0.35" />
          </svg>
        );
      case "blur":
        return (
          <svg viewBox="0 0 48 28" aria-hidden="true">
            <rect x="7" y="6" width="34" height="16" rx="3" fill="currentColor" opacity="0.18" />
            <circle cx="17" cy="13" r="5" fill="currentColor" opacity="0.35" />
            <circle cx="29" cy="16" r="6" fill="currentColor" opacity="0.2" />
          </svg>
        );
      case "crop":
        return (
          <svg viewBox="0 0 48 28" aria-hidden="true">
            <rect
              x="8"
              y="5"
              width="32"
              height="18"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeDasharray="3 2"
            />
          </svg>
        );
      case "step":
        return STEP_ICON;
    }
  }
  if (node.kind === "effect") {
    if (node.effect.type === "highlight") {
      return (
        <svg viewBox="0 0 48 28" aria-hidden="true">
          <rect
            x="7"
            y="7"
            width="34"
            height="14"
            rx="2"
            fill={node.effect.tint_hex}
            fillOpacity={node.effect.opacity}
          />
          <path d="M8 19 39 9" stroke="currentColor" strokeOpacity="0.35" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 48 28" aria-hidden="true">
        <rect x="7" y="6" width="34" height="16" rx="3" fill="currentColor" opacity="0.18" />
        <circle cx="17" cy="13" r="5" fill="currentColor" opacity="0.35" />
        <circle cx="29" cy="16" r="6" fill="currentColor" opacity="0.2" />
      </svg>
    );
  }
  return iconForNode(node);
}

function LayerPreview({ node }: { readonly node: BundleLayerNode }): ReactElement {
  return (
    <span
      className="psl-layers__preview"
      data-testid={`layer-preview-${node.id}`}
      role="img"
      aria-label={`${labelForNode(node)} layer preview`}
    >
      {previewForNode(node)}
    </span>
  );
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
  const listRef = useRef<HTMLDivElement | null>(null);
  // Annotation-row vertical midpoints, snapshotted once at grip-down. Rows
  // don't move during a drag (the dragged row only changes opacity and the
  // drop line is a ::before/::after pseudo), so each pointermove compares
  // against this cache instead of re-querying + re-measuring every row.
  const dragMidsRef = useRef<number[] | null>(null);
  // Active drag-reorder: the layer being dragged + the gap the drop line
  // shows at (0 = above the first annotation … annotationCount = just
  // above the pinned base group).
  const [drag, setDrag] = useState<{
    id: string;
    pointerId: number;
    overGap: number;
  } | null>(null);
  // Expansion is strictly manual: selection belongs to the canvas and
  // the Properties tab, while these chevrons are only for comparing two
  // nearby arrow styles inside the layer list.
  const [expandedLayerIds, setExpandedLayerIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // Layer ids are capture-local; never carry a manual comparison accordion
  // into the next capture when Focus/Reel navigation swaps `captureId`.
  useEffect(() => {
    setExpandedLayerIds(new Set());
  }, [captureId]);

  // Top-to-bottom = front-to-back: the topmost row paints last (highest
  // z_index). Groups are hidden — v2.0 only ever has the synthesized
  // root group, which isn't a user-facing layer. Annotations sort by
  // z_index DESC; the base layers (Source + Crop) are pinned at the
  // BOTTOM regardless of z_index so an annotation never appears below
  // them (which would be a no-op — see isBaseLayer).
  const { rows, annotationCount, sourceRasterId } = useMemo<{
    rows: BundleLayerNode[];
    annotationCount: number;
    sourceRasterId: string | null;
  }>(() => {
    if (model.kind !== "loaded") {
      return { rows: [], annotationCount: 0, sourceRasterId: null };
    }
    // Only the Source raster is pinned; pasted images + the captured
    // cursor are reorderable annotations like any vector.
    const srcId = selectBaseRaster(model.layers, model.record.sha256)?.id ?? null;
    const all = model.layers.filter(
      (l) => l.kind !== "group" && !isSpuriousCropArtifact(l)
    );
    const annotations = all
      .filter((l) => !isBaseLayer(l, srcId))
      .sort((a, b) => b.z_index - a.z_index);
    const base = all
      .filter((l) => isBaseLayer(l, srcId))
      .sort((a, b) => baseRank(a) - baseRank(b));
    // Annotations occupy the first `annotationCount` rows (display index
    // == annotation index); the pinned base layers follow.
    return {
      rows: [...annotations, ...base],
      annotationCount: annotations.length,
      sourceRasterId: srcId
    };
  }, [model]);
  // PageUp/PageDown jump — bigger over deep stacks.
  const pageStep = annotationCount > 100 ? 10 : 5;
  const toggleLayerInspector = useCallback((id: string): void => {
    setExpandedLayerIds((expanded) => {
      const next = new Set(expanded);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Measure the annotation rows' vertical midpoints — called once per
  // drag (at grip-down) and cached in `dragMidsRef`.
  const snapshotRowMids = useCallback((): number[] => {
    const list = listRef.current;
    if (list === null) return [];
    return Array.from(
      list.querySelectorAll<HTMLElement>('[data-annotation="true"]')
    ).map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
  }, []);

  // The gap (0..annotationCount) a pointer Y falls into — counts the cached
  // row midpoints above the cursor. No DOM access per pointermove.
  const gapFromPointerY = (clientY: number): number => {
    const mids = dragMidsRef.current ?? [];
    let gap = 0;
    for (const mid of mids) if (clientY > mid) gap += 1;
    return Math.max(0, Math.min(mids.length, gap));
  };

  const onGripMove = (e: ReactPointerEvent<HTMLElement>): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    const gap = gapFromPointerY(e.clientY);
    if (gap !== drag.overGap) setDrag({ ...drag, overGap: gap });
  };
  const onGripUp = (e: ReactPointerEvent<HTMLElement>): void => {
    if (drag === null || e.pointerId !== drag.pointerId) return;
    try {
      e.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // capture may already be lost — ignore
    }
    const from = rows.findIndex((n) => n.id === drag.id);
    // Removing the dragged row shifts everything below it up by one.
    let target = drag.overGap > from ? drag.overGap - 1 : drag.overGap;
    target = Math.max(0, Math.min(annotationCount - 1, target));
    setDrag(null);
    dragMidsRef.current = null;
    if (from !== -1 && target !== from) void api?.moveLayerToIndex(drag.id, target);
  };
  const endDrag = (): void => {
    dragMidsRef.current = null;
    setDrag(null);
  };

  const onRowKeyDown = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    id: string,
    index: number
  ): void => {
    let target: number | null = null;
    if (e.key === "ArrowUp") target = index - 1;
    else if (e.key === "ArrowDown") target = index + 1;
    else if (e.key === "PageUp") target = index - pageStep;
    else if (e.key === "PageDown") target = index + pageStep;
    else return;
    // Own the key so the editor's capture-phase pixel-nudge (and the
    // Library's reel navigation) don't ALSO fire. The editor already
    // bows out when `.psl-layers` is focused; stopPropagation keeps the
    // Library handler from seeing it on the way up.
    e.preventDefault();
    e.stopPropagation();
    void api?.moveLayerToIndex(id, target); // Editor clamps
  };

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
    <div
      className="psl-layers"
      data-testid="psl-layers"
    >
      <div ref={listRef} className="psl-layers__list" role="list" aria-label="Layers">
        {rows.map((node, i) => {
          const id = node.id;
          const selected = selectedLayerIds.includes(id);
          const visible = node.visible !== false;
          const sourceRaster = isSourceRaster(node, sourceRasterId);
          const crop = isCropLayer(node);
          const base = isBaseLayer(node, sourceRasterId);
          const selectable = isSelectable(node);
          const layerStyle = styledLayerStyle(node, {
            width: model.record.width_px,
            height: model.record.height_px
          });
          const inspectorExpanded = layerStyle !== null && expandedLayerIds.has(id);
          const inspectorDomId = `layer-inspector-${previewId(id)}`;
          // Non-base rasters (pasted image / captured cursor) with a stored
          // home transform get a Reset control — enabled once they've been
          // moved / resized away from it.
          const rasterHome =
            node.kind === "raster" && !base ? node.original_transform : undefined;
          const dragging = drag?.id === id;
          const dropBefore = drag !== null && !base && drag.overGap === i;
          const dropAfter =
            drag !== null &&
            !base &&
            i === annotationCount - 1 &&
            drag.overGap === annotationCount;
          return (
            <div key={id} className="psl-layers__item" role="presentation">
              <div
                role="listitem"
                tabIndex={base ? -1 : 0}
                data-testid={`layer-row-${id}`}
                data-kind={node.kind}
                data-selected={selected}
                data-base={base ? "true" : undefined}
                data-annotation={base ? undefined : "true"}
                aria-selected={selected}
                aria-roledescription={base ? undefined : "Reorderable layer"}
                className={[
                  "psl-layers__row",
                  selectable ? "is-selectable" : "",
                  selected ? "is-selected" : "",
                  base ? "is-base" : "",
                  base && i === annotationCount ? "is-base-first" : "",
                  dragging ? "is-dragging" : "",
                  dropBefore ? "is-drop-before" : "",
                  dropAfter ? "is-drop-after" : "",
                  visible ? "" : "is-hidden"
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={
                  selectable
                    ? (e): void => api?.selectLayers(id, e.metaKey || e.ctrlKey)
                    : undefined
                }
                onKeyDown={
                  base ? undefined : (e): void => onRowKeyDown(e, id, i)
                }
              >
                {base ? (
                  <span className="psl-layers__grip psl-layers__grip--spacer" aria-hidden="true" />
                ) : (
                  <span
                    className="psl-layers__grip"
                    data-testid={`layer-grip-${id}`}
                    aria-hidden="true"
                    title="Drag to reorder"
                    onClick={(e): void => e.stopPropagation()}
                    onPointerDown={(e): void => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      dragMidsRef.current = snapshotRowMids();
                      setDrag({ id, pointerId: e.pointerId, overGap: i });
                    }}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                    onPointerCancel={endDrag}
                  >
                    {GRIP_ICON}
                  </span>
                )}
                <LayerPreview node={node} />
                <span className="psl-layers__label" title={labelForNode(node)}>
                  {labelForNode(node)}
                </span>
                {layerStyle !== null && (
                  <button
                    type="button"
                    className={
                      "psl-layers__expand" + (inspectorExpanded ? " is-expanded" : "")
                    }
                    data-testid={`layer-inspector-toggle-${id}`}
                    aria-label={
                      inspectorExpanded
                        ? `Collapse ${layerStyle.label} properties`
                        : `Expand ${layerStyle.label} properties`
                    }
                    aria-controls={inspectorDomId}
                    aria-expanded={inspectorExpanded}
                    title={inspectorExpanded ? "Collapse properties" : "Expand properties"}
                    onClick={(e): void => {
                      e.stopPropagation();
                      toggleLayerInspector(id);
                    }}
                  >
                    {CHEVRON_ICON}
                  </button>
                )}
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
                  {rasterHome !== undefined && (
                    <button
                      type="button"
                      className="psl-layers__btn"
                      data-testid={`layer-reset-${id}`}
                      aria-label="Reset position and size"
                      title="Reset to original position & size"
                      disabled={affineTransformsEqual(node.transform, rasterHome)}
                      onClick={(e): void => {
                        e.stopPropagation();
                        void api?.resetRasterTransform(id);
                      }}
                    >
                      {RESET_ICON}
                    </button>
                  )}
                  <button
                    type="button"
                    className="psl-layers__btn psl-layers__btn--danger"
                    data-testid={`layer-delete-${id}`}
                    aria-label={crop ? "Remove crop (restore full image)" : "Delete layer"}
                    title={crop ? "Remove crop" : "Delete"}
                    disabled={sourceRaster}
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
              {layerStyle !== null && inspectorExpanded && (
                <section
                  id={inspectorDomId}
                  className="psl-layers__inspector"
                  data-testid={`layer-inspector-${id}`}
                  aria-label={`${layerStyle.label} properties`}
                >
                  <div className="psl-layers__inspector-heading">
                    {layerStyle.label} properties
                  </div>
                  <div className="psl-layers__inspector-body">
                    <ToolStyleBody
                      tool={layerStyle.tool}
                      style={layerStyle.style}
                      onStyleFieldChange={(field, value): void => {
                        api?.updateLayerStyle(id, field, value);
                      }}
                    />
                  </div>
                </section>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
