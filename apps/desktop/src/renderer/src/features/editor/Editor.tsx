// Phase 2 Editor — full tool palette + Phase 1 v2 editor refresh wiring.
//
// Tools (Slice B):
//   • Arrow      — drag from→to. Smart geometry shared with bake.
//   • Rect       — drag a rectangle. Stroked outline + white halo.
//   • Highlight  — drag a rectangle. Semi-transparent yellow fill.
//   • Blur       — drag a rectangle. Mask-style blur per region in bake.
//   • Text       — click to anchor; inline input; Enter commits.
//   • Crop       — Phase 1 v2 refresh: 8-handle crop overlay; ↵ commits.
//
// Coordinate system: every overlay's geometry is normalized to
// [0, 1]^2 fractions of the source image's W×H — independent of
// canvas display size. The same overlay record renders identically
// in the editor's live SVG and in the sharp bake (compose.ts).
//
// Smart-arrow geometry (computeArrowGeometry) is the shared math
// between live render and bake. Rect/highlight/blur are simpler:
// just a rect with normalized coords; the bake produces an SVG
// buffer at source-pixel resolution.
//
// Phase 1 v2 wiring (chrome === "full" only):
//   • useEditorToolState — owns active tool + per-tool style memory +
//     COLOR-slot fan-out + matching-text affordance lifecycle.
//   • EditorChrome — VS-Code-style activity bar + collapsible panel
//     that wraps the editor viewport in standalone-window mode only.
//   • ToolStylePopover — anchored to the toolbar's active tool button
//     via a caret. Double-tapping the tool's letter shortcut also
//     opens the popover.
//   • CropTool — rendered as an overlay when activeTool === "crop";
//     commits a CropOverlay via overlays:upsert and stays in crop
//     mode (sticky) until the user picks another tool.
//   • Matching-text affordance — small "+ Add label" button positioned
//     near the just-placed arrow's tail; click → flips to text tool
//     for one placement, then returns to arrow.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ArrowToolStyle,
  BlurStyle,
  BlurToolStyle,
  BundleLayerNode,
  CaptureRecord,
  HighlightToolStyle,
  Overlay,
  OverlayRow,
  PwrSnapError,
  Result,
  ShapeToolStyle,
  TextToolStyle,
  ToolSizePreset
} from "@pwrsnap/shared";
import {
  CURRENT_ARROW_STYLE_VERSION,
  DEFAULT_BLUR_STYLE,
  computeTextGlyphSize,
  matchBucket,
  readShapeFilled,
  readShapeKind,
  readShapeSkewDeg,
  readHighlightOpacity,
  readTextWeight,
  resolveCropViewport
} from "@pwrsnap/shared";
import { dispatch, captureSrcUrl } from "../../lib/pwrsnap";
import { selectBaseRaster } from "./base-raster";
import { findRootGroupId, overlayToBundleLayerNode } from "./overlayToLayer";
import { RasterLayers } from "./RasterLayers";
import { computeEditorImageStyle } from "./editor-image-style";
import { resolveToolColor } from "./resolveToolColor";
import { shapeStrokeGeometry } from "./shape-stroke-geometry";
import { TOOLS, type Tool } from "./editor-tools";
import { useZoomPan, type ZoomMode } from "./useZoomPan";
import { useUndoRedo, type InteractionToken, type RecordOptions } from "./useUndoRedo";
import { decideClickSelection } from "./decideClickSelection";
import { pruneLandedDraftGeometry } from "./draft-geometry";
import { isReorderableLayer } from "./layer-roles";
import { hitTestRasterLayers } from "./raster-hit-test";
import { forwardOpToStored, forwardGeometry } from "./crop-edit-space";
import {
  useCaptureModel,
  inverseCropRect,
  cropRectFromCanvas,
  type EditOpResult,
  type GeometryUpdate,
  type LayerEditOp
} from "./useCaptureModel";
import { OverlaySvg, TransformHandles, type DraftStyle } from "./OverlaySvg";
import { BlurOverlays } from "./BlurOverlays";
import { TextDraftInput } from "./TextDraftInput";
import { TextHtmlOverlays } from "./TextHtmlOverlays";
import { resolveTextDraftStyle } from "./text-draft-style";
import {
  TEXT_BBOX_CHAR_ADVANCE_HIT,
  TEXT_BBOX_HIT_WIDTH_SLOP
} from "./text-bbox-constants";
import { measureTextWidthPx } from "./text-measure";
import { getGlyphSize } from "./text-measure-registry";
import { LayerContextMenu } from "./LayerContextMenu";
import {
  buildLayerContextMenuItems,
  type LayerContextMenuItemId
} from "./buildLayerContextMenuItems";
import { ZoomMenu } from "./ZoomMenu";
import { CropTool } from "./CropTool";
import { EditorChrome } from "./EditorChrome";
import { ToolStylePopover, type StyledToolKind } from "./ToolStylePopover";
import { InfoPanel } from "./panels/InfoPanel";
import { ChatPanel } from "./panels/ChatPanel";
import { ToolConfigPanel } from "./panels/ToolConfigPanel";
import {
  useEditorToolState,
  type ActiveStyle,
  type StyledTool,
  type StyleFor,
  type UseEditorToolStateReturn
} from "./useEditorToolState";
import {
  MIN_DRAG_LENGTH,
  rectFromDrag,
  type Draft,
  type DraftArrow,
  type DraftShape,
  type DraftText
} from "./editor-types";
import type { PasteImagePosition } from "./usePasteImage";
import { useDropImage } from "./useDropImage";
import { computeNewOrder, diffChanges, moveToIndex } from "./z-order";
import {
  filterSelectionToAliveOrInFlight,
  pruneLandedInFlightSelectionIds
} from "./selection-cleanup";
import "./editor.css";

/** Three structural shapes for the editor:
 *
 *   • "full"       — full editor chrome: titlebar + bottom toolbar,
 *                    wrapped in <EditorChrome> (Phase 1 v2 refresh:
 *                    activity bar + collapsible right panel). Kept
 *                    for component-level coverage; production opens
 *                    captures through Library Focus.
 *   • "embedded"   — inline-in-Library mode (Phase 2 Slice C / Phase
 *                    A transitional): no titlebar, but keeps the
 *                    bottom toolbar. This branch was dropped in
 *                    Phase B and may be removed entirely in a
 *                    future cleanup.
 *   • "chromeless" — Library Focus + Reel modes: no titlebar, no
 *                    toolbar. The canvas + draft input only. The
 *                    floating EditToolbar lives at the Library level
 *                    and shares tool state via the controlled
 *                    `tool` / `onToolChange` props. */
export type EditorChromeKind = "full" | "embedded" | "chromeless";
/** Back-compat alias — callers import this name. */
export type { EditorChromeKind as EditorChrome };

export type { ZoomMode };

/** Reactive snapshot of the editor's zoom state, surfaced to parents
 *  that render zoom controls outside the editor (Library's floating
 *  EditToolbar). `null` means the editor has unmounted — clear any
 *  cached api. */
export type ZoomApi = {
  mode: ZoomMode;
  /** Current zoom % relative to "actual size" (image's natural CSS
   *  dimensions, accounting for devicePixelRatio). 100 = one image
   *  pixel per screen pixel. Null until the wrap is first measured. */
  displayPct: number | null;
  /** What displayPct would be at fit (scale=1). Used to render
   *  "Fit (XX%)" in the toolbar without flipping into fit mode. */
  fitPct: number | null;
  resetToFit: () => void;
  actualSize: () => void;
  /** Jump to a specific display percentage. */
  setCustomPct: (pct: number) => void;
  /** Multiply current scale by `factor` (e.g. 1.2 for +20%, 1/1.2
   *  for -20%). */
  zoomBy: (factor: number) => void;
} | null;

/** Imperative API the editor publishes so the Library's Layers panel —
 *  which lives in DetailRail, a sibling of the chromeless editor — can
 *  drive layer operations on the canvas: selection, visibility, delete,
 *  reorder, and uncrop. Published via the `onLayersApi` callback the
 *  same way `ZoomApi` rides `onZoomChange` (the editor publishes
 *  callbacks rather than exposing a `forwardRef`). The parent receives
 *  `null` on unmount so it can clear its cached handle. */
export type LayersPanelApi = {
  /** Replace (additive=false) or toggle (additive=true) the canvas
   *  selection. Pure state set — no IPC. Drives the selection outline +
   *  transform handles. Selecting a hidden layer won't persist (the
   *  stale-id cleanup drops ids absent from the rendered set) — that's
   *  the accepted "hide deselects" behavior. */
  selectLayers: (id: string, additive: boolean) => void;
  /** Flip a layer's `visible` flag via a full-node `layers:update`. */
  setLayerVisibility: (id: string, visible: boolean) => Promise<void>;
  /** Soft-delete a layer, recording undo when the layer projects to an
   *  OverlayRow. Callers must NOT pass the base raster (panel disables
   *  it) or a crop layer (panel routes crop to `uncrop`). */
  deleteLayer: (id: string) => Promise<void>;
  /** Move a layer to `toIndex` in the panel's TOP-DOWN annotation order
   *  (0 = topmost / front). Drives drag-and-drop and keyboard reorder.
   *  Computes over the reorderable annotation set (vector except crop,
   *  plus effect — incl. hidden) so the order is correct regardless of
   *  which layers are currently visible. `toIndex` is clamped. */
  moveLayerToIndex: (id: string, toIndex: number) => Promise<void>;
  /** Remove the crop while keeping every other annotation correctly
   *  positioned. Reuses the inverse-crop dispatch (which re-normalizes
   *  overlays + restores off-origin raster/effect transforms + grows
   *  the canvas back), then deletes the leftover crop layer that
   *  dispatch inserts. */
  uncrop: (cropLayerId: string) => Promise<void>;
};

const STYLED_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "arrow",
  "text",
  "shape",
  "blur",
  "highlight"
]);

function isStyledToolKind(tool: Tool): tool is StyledToolKind {
  return STYLED_TOOLS.has(tool);
}

/** Phase 3.3 — derive the OverlaySvg DraftStyle from the live active
 *  style. Each tool that paints in `OverlaySvg` (arrow / rect /
 *  highlight / text) contributes its picked color so the live drag
 *  preview matches what the commit will look like. Blur is rendered
 *  by `<BlurOverlays>` (HTML backdrop-filter), not OverlaySvg, so
 *  blur's mode/radius don't appear here. Returns undefined for tools
 *  whose draft has no styled-glyph component (pointer / crop). */
function resolveDraftStyleForActiveTool(
  activeStyle: ActiveStyle
): DraftStyle | undefined {
  switch (activeStyle.tool) {
    case "arrow":
      // Thread the user's picked endStyle / stemStyle / doubleEnded /
      // thickness through so the live drag preview matches what the
      // commit will produce. Without this the draft renders a filled-
      // triangle + solid stem + auto thickness regardless of the
      // popover pick, and only the committed overlay flips to the
      // right variant on mouseup.
      return {
        color: resolveToolColor(activeStyle.style.color),
        endStyle: activeStyle.style.endStyle,
        stemStyle: activeStyle.style.stemStyle,
        doubleEnded: activeStyle.style.doubleEnded,
        thickness: activeStyle.style.thickness
      };
    case "shape":
      return {
        color: resolveToolColor(activeStyle.style.color),
        thickness: activeStyle.style.thickness,
        filled: activeStyle.style.filled,
        shape: activeStyle.style.shape,
        skewDeg: activeStyle.style.skewDeg
      };
    case "highlight":
      return {
        color: resolveToolColor(activeStyle.style.color),
        highlightOpacity: activeStyle.style.opacity,
        highlightBlend: activeStyle.style.blend
      };
    case "text":
      return { color: resolveToolColor(activeStyle.style.color) };
    default:
      return undefined;
  }
}

/** Phase 3.5 — extract a GeometryUpdate from an overlay's `data`,
 *  used by the transform-handles flow to record the PRE-DRAG geometry
 *  on the undo stack. Returns null for kinds without drag-handle
 *  semantics in this slice (crop — has its own overlay tool). */
function overlayDataToGeometry(data: Overlay): GeometryUpdate | null {
  if (data.kind === "arrow") {
    return { kind: "arrow", from: data.from, to: data.to };
  }
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    return { kind: "rect", rect: data.rect };
  }
  if (data.kind === "text") {
    return { kind: "text", point: data.point };
  }
  if (data.kind === "step") {
    return { kind: "step", point: data.point };
  }
  return null;
}

/** Translate the full `data` payload of an overlay by a normalized
 *  delta. Used by the copy/paste/duplicate flow — preserves every
 *  non-geometry field (color, thickness, body, etc.) and shifts only
 *  the spatial anchors. Returns the original unchanged for kinds
 *  without geometry semantics (crop). */
export function translateOverlayData(
  data: Overlay,
  dxn: number,
  dyn: number
): Overlay {
  if (data.kind === "arrow") {
    return {
      ...data,
      from: { x: data.from.x + dxn, y: data.from.y + dyn },
      to: { x: data.to.x + dxn, y: data.to.y + dyn }
    };
  }
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    return {
      ...data,
      rect: {
        x: data.rect.x + dxn,
        y: data.rect.y + dyn,
        w: data.rect.w,
        h: data.rect.h
      }
    } as Overlay;
  }
  if (data.kind === "text") {
    return {
      ...data,
      point: { x: data.point.x + dxn, y: data.point.y + dyn }
    };
  }
  if (data.kind === "step") {
    return {
      ...data,
      point: { x: data.point.x + dxn, y: data.point.y + dyn }
    };
  }
  // crop — no anchor to translate; pass through unchanged. Crop is
  // never in the paste flow (it's its own canvas-side mutation) but
  // we'd rather no-op than throw.
  return data;
}

/** Translate an overlay's geometry by a normalized delta. Used by the
 *  arrow-key nudge flow — `dxn` / `dyn` are in [0,1]² space (a 1px
 *  step is `1 / canvas dim`). Returns the translated GeometryUpdate
 *  ready to feed into `dispatchEdit({ kind: 'updateGeometry', ... })`.
 *  Returns null for overlay kinds without geometry semantics (crop). */
export function translateOverlayGeometry(
  data: Overlay,
  dxn: number,
  dyn: number
): GeometryUpdate | null {
  if (data.kind === "arrow") {
    return {
      kind: "arrow",
      from: { x: data.from.x + dxn, y: data.from.y + dyn },
      to: { x: data.to.x + dxn, y: data.to.y + dyn }
    };
  }
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    return {
      kind: "rect",
      rect: {
        x: data.rect.x + dxn,
        y: data.rect.y + dyn,
        w: data.rect.w,
        h: data.rect.h
      }
    };
  }
  if (data.kind === "text") {
    return {
      kind: "text",
      point: { x: data.point.x + dxn, y: data.point.y + dyn }
    };
  }
  if (data.kind === "step") {
    return {
      kind: "step",
      point: { x: data.point.x + dxn, y: data.point.y + dyn }
    };
  }
  return null;
}

/** Phase 3.5 — derive the popover header text + the popover's
 *  styled-tool kind from a selected overlay. The mapping is direct
 *  (rect/highlight/blur all surface as their own tool kind in the
 *  popover); returns null when the selected overlay has no popover
 *  surface (e.g. crop / step). */
function selectedOverlayToStyledTool(
  data: Overlay
): { tool: StyledToolKind; label: string } | null {
  switch (data.kind) {
    case "arrow":
      return { tool: "arrow", label: "arrow" };
    case "shape": {
      // Label the popover header with the specific shape kind so the
      // user knows whether they're editing a rectangle vs an oval vs a
      // parallelogram. Fall back to "shape" if the row predates the
      // shape field (treated as rect via readShapeKind).
      const labels: Record<string, string> = {
        rect: "rectangle",
        square: "square",
        circle: "circle",
        oval: "oval",
        parallelogram: "parallelogram"
      };
      return { tool: "shape", label: labels[readShapeKind(data)] ?? "shape" };
    }
    case "highlight":
      return { tool: "highlight", label: "highlight" };
    case "blur":
      return { tool: "blur", label: "blur" };
    case "text":
      return { tool: "text", label: "text" };
    default:
      // step, crop — no popover surface in Phase 3.5.
      return null;
  }
}

/** Phase 3.5 — project the SELECTED overlay's `data` into the tool-
 *  style shape the popover reads. The overlay carries a SUBSET of
 *  the tool-style fields (e.g. arrow has color/endStyle/stemStyle/
 *  doubleEnded but no `thickness`; the v1 schema doesn't store
 *  thickness on the row). Defaults are filled in from the active-
 *  tool memory so the popover doesn't render with empty selections.
 *  Returns null when the overlay kind doesn't have a styled
 *  surface. */
function selectedOverlayToToolStyle(
  data: Overlay,
  defaults: {
    arrow: ArrowToolStyle;
    text: TextToolStyle;
    shape: ShapeToolStyle;
    blur: BlurToolStyle;
    highlight: HighlightToolStyle;
  }
):
  | { tool: "arrow"; style: ArrowToolStyle }
  | { tool: "text"; style: TextToolStyle }
  | { tool: "shape"; style: ShapeToolStyle }
  | { tool: "blur"; style: BlurToolStyle }
  | { tool: "highlight"; style: HighlightToolStyle }
  | null {
  if (data.kind === "arrow") {
    return {
      tool: "arrow",
      style: {
        ...defaults.arrow,
        color: data.color ?? defaults.arrow.color,
        endStyle: data.endStyle ?? defaults.arrow.endStyle,
        stemStyle: data.stemStyle ?? defaults.arrow.stemStyle,
        doubleEnded: data.doubleEnded ?? defaults.arrow.doubleEnded,
        thickness: data.thickness ?? defaults.arrow.thickness
      }
    };
  }
  if (data.kind === "shape") {
    return {
      tool: "shape",
      style: {
        ...defaults.shape,
        color: data.color ?? defaults.shape.color,
        thickness: data.thickness ?? defaults.shape.thickness,
        filled: data.filled ?? defaults.shape.filled,
        shape: readShapeKind(data),
        skewDeg:
          readShapeKind(data) === "parallelogram"
            ? readShapeSkewDeg(data)
            : defaults.shape.skewDeg
      }
    };
  }
  if (data.kind === "highlight") {
    return {
      tool: "highlight",
      style: {
        ...defaults.highlight,
        ...(data.color !== undefined ? { color: data.color } : {}),
        opacity: readHighlightOpacity(data),
        ...(data.blend !== undefined ? { blend: data.blend } : {})
      }
    };
  }
  if (data.kind === "blur") {
    return {
      tool: "blur",
      style: {
        ...defaults.blur,
        ...(data.style !== undefined ? { mode: data.style } : {}),
        ...(data.radiusPx !== undefined
          ? { radius: { mode: "px", value: data.radiusPx } }
          : {})
      }
    };
  }
  if (data.kind === "text") {
    return {
      tool: "text",
      style: {
        ...defaults.text,
        color: data.color ?? defaults.text.color
      }
    };
  }
  return null;
}

/** Map a text tool's `fontSize` preset (auto / small / medium / large)
 *  into the `TextOverlay.size` enum (small | medium | large). Three
 *  buckets with a ~1.7× ratio between each — the v1 schema originally
 *  only had small/large so "medium" silently collapsed to "large",
 *  making the popover's three sizes look identical. The schema now
 *  carries "medium" as a first-class bucket; this helper is the only
 *  place that maps the popover's "auto" sentinel — default goes to
 *  "medium" (the sweet spot for screenshot annotation) instead of the
 *  too-small "small" the v1 schema defaulted to. Numeric presets
 *  aren't reachable from the popover today but fall back to "medium"
 *  defensively. */
function resolveTextSize(
  fontSize: ToolSizePreset | number
): "small" | "medium" | "large" {
  if (typeof fontSize === "number") return "medium";
  if (fontSize === "large") return "large";
  // The text popover doesn't expose "x-large", but the type union
  // includes it (shared with arrow/rect thickness). Map it to
  // "large" defensively in case it ever arrives via persisted state
  // or AI-injected overlays. Three text buckets is enough; if we
  // want a true XL text someday we should add a 4th bucket to the
  // schema with its own font-size curve rather than overload the
  // thickness preset name.
  if (fontSize === "x-large") return "large";
  if (fontSize === "small") return "small";
  // "auto" and "medium" both resolve to medium.
  return "medium";
}

/** v2 → v1 read-only projection. The existing `OverlaySvg` and
 *  `BlurOverlays` components consume `OverlayRow[]`; for v2 captures we
 *  back-project layer nodes into the same shape so the renderers don't
 *  need to know about the format split during Phase 2 (Phase 4-5 swap
 *  the renderers to consume `LayerView` natively and this shim
 *  retires). Vector layers and rectangular effect layers project —
 *  groups and rasters are skipped (no Phase 1 renderer surface for
 *  them). */
/** Source dims for the v2 → v1 projection (Phase 3.3 fix). The
 *  caller is the EditorLoaded render which has the CaptureRecord in
 *  scope, so passing them in is cheap. Used to renormalize v2 effect
 *  layers' `clip_rect` (absolute canvas pixels per the v2 EffectLayer
 *  schema) back into v1's normalized [0,1] coords for BlurOverlays. */
interface ProjectionDims {
  widthPx: number;
  heightPx: number;
}

function projectV2LayersToOverlayRows(
  layers: BundleLayerNode[],
  captureId: string,
  dims: ProjectionDims
): OverlayRow[] {
  const rows: OverlayRow[] = [];
  for (const layer of layers) {
    // A layer toggled hidden via the Layers panel (`visible === false`)
    // must NOT render in the live canvas. The bake compositor already
    // honors `visible` (compose-tree.ts), but this live projection used
    // to render every layer regardless — so a hidden layer stayed
    // visible while editing until the next bake. Skip it here too.
    if (layer.visible === false) continue;
    if (layer.kind === "vector") {
      // v2 vector layers carry the v1 Overlay shape verbatim under
      // `shape`. The renderer only reads `id` + `data` so the projection
      // is direct.
      rows.push({
        id: layer.id,
        capture_id: captureId,
        data: layer.shape,
        schema_version: 1,
        source: layer.source,
        ai_run_id: layer.ai_run_id,
        z_index: layer.z_index,
        rejected_at: layer.rejected_at,
        applied_at: layer.applied_at,
        superseded_by: layer.superseded_by,
        created_at: layer.created_at
      });
      continue;
    }
    if (layer.kind === "effect" && (layer.effect.type === "blur" || layer.effect.type === "highlight")) {
      // v2 rectangular effects clip to a `clip_rect` in absolute canvas
      // pixels (per the v2 EffectLayer schema in
      // packages/shared/src/bundle-manifest-schema-v2.ts — CanvasRect
      // uses FiniteNumber, no [0,1] constraint). v1 blurs use
      // normalized [0,1] coords. Phase 2's first cut left this branch
      // "rarely exercised" so it shipped without the division below;
      // Phase 3's doctor changed that overnight by migrating any
      // capture the user opens to v2 — every blur on a doctored
      // capture started rendering off-canvas because BlurOverlays
      // treated the raw canvas-pixel values as percentages.
      //
      // Phase 3.3 fix: divide by source/canvas dims to renormalize.
      // Skip null clip_rect (no spatial extent → unrenderable).
      if (layer.clip_rect === null) continue;
      const rect = {
        x: layer.clip_rect.x / dims.widthPx,
        y: layer.clip_rect.y / dims.heightPx,
        w: layer.clip_rect.w / dims.widthPx,
        h: layer.clip_rect.h / dims.heightPx
      };
      rows.push({
        id: layer.id,
        capture_id: captureId,
        data:
          layer.effect.type === "blur"
            ? {
                kind: "blur",
                rect,
                // Phase 3.4: read the v2 BlurEffect's `style` field
                // (optional; older v2 bundles without it fall back to
                // DEFAULT_BLUR_STYLE — same gaussian default the
                // renderer always assumed).
                style: layer.effect.style ?? DEFAULT_BLUR_STYLE,
                radiusPx: layer.effect.radius_px,
                // Rotation lives on the effect spec (not on the layer's
                // transform matrix). Vector layers carry rotation inside
                // `shape.rotation`; effect layers can't (no `shape`) so
                // the field rides on `effect.rotation`. Legacy v2
                // bundles without it render unrotated (the field is
                // optional).
                ...(layer.effect.rotation !== undefined
                  ? { rotation: layer.effect.rotation }
                  : {})
              }
            : {
                kind: "highlight",
                rect,
                color: layer.effect.tint_hex,
                opacity: layer.effect.opacity,
                ...(layer.effect.blend !== undefined
                  ? { blend: layer.effect.blend }
                  : {}),
                ...(layer.effect.rotation !== undefined
                  ? { rotation: layer.effect.rotation }
                  : {})
              },
        schema_version: 1,
        source: layer.source,
        ai_run_id: layer.ai_run_id,
        z_index: layer.z_index,
        rejected_at: layer.rejected_at,
        applied_at: layer.applied_at,
        superseded_by: layer.superseded_by,
        created_at: layer.created_at
      });
    }
    // group + raster: no Phase 2 renderer surface.
    // Phase 4-5 LayerView rewrite covers them.
  }
  return rows;
}

/** Hit-test a normalized [0,1] point against a list of overlay rows.
 *  Walks rows in reverse z-order (last-painted = topmost = first
 *  candidate) so the visually-topmost overlay under the cursor wins
 *  ties. Returns the matching row id, or null if nothing under the
 *  point. Phase 3.2 minimal selection model; the threshold for
 *  arrow/text hits is generous (≈ stroke width) so the user doesn't
 *  have to pixel-hunt a 1px line.
 *
 *  Coordinate space: `xn`, `yn` are normalized [0,1]; rect overlays
 *  carry normalized {x,y,w,h}; arrow overlays carry normalized
 *  {from,to}. The threshold scales with the canvas's pixel extent
 *  (passed in) so the click radius is roughly constant in screen-
 *  px regardless of canvas size.
 *
 *  Rotation support: when `imageDims` is provided AND the overlay
 *  has a non-zero `rotation` field, the click point is rotated INTO
 *  the overlay's local (unrotated) frame before the bbox test so
 *  the hit follows the visible glyph. The pixel-space pivot matches
 *  what the renderer applies — `(rect.center * imageDims)` for
 *  rect/highlight/blur and `data.point * imageDims` for text. When
 *  `imageDims` is omitted (legacy call sites + most tests), every
 *  overlay is tested in its unrotated frame — the historical
 *  behavior. */
export function hitTestOverlays(
  overlays: OverlayRow[],
  xn: number,
  yn: number,
  canvasPxShortSide: number,
  /** Optional canvas + source pixel dims. Powers TWO improvements:
   *    • rect / highlight / blur: when present, click points are
   *      inverse-rotated into the layer's local frame before bbox
   *      testing so rotated shapes are selectable under their visible
   *      glyph (not just the original axis-aligned bbox).
   *    • text: when present, the hit-test uses the full bounding
   *      rectangle of the rendered glyph instead of a tiny point-
   *      radius. Matches the HTML wrapper's actual on-screen extent.
   *  When omitted (older test call sites), rotated rects fall back
   *  to AABB hit-test + text falls back to point-radius — keeps the
   *  existing hitTestOverlays.test.ts that doesn't thread dims
   *  compatible without forcing every test to inflate its args. */
  textDims?: {
    canvasWidthPx: number;
    canvasHeightPx: number;
    sourceWidthPx: number;
    sourceHeightPx: number;
  }
): string | null {
  const imageDims =
    textDims !== undefined
      ? { widthPx: textDims.canvasWidthPx, heightPx: textDims.canvasHeightPx }
      : undefined;
  // ~10px hit radius on a 1000px short-side canvas → 0.01 in
  // normalized coords. Scales inversely with size for a roughly
  // constant pixel tolerance.
  const hitRadiusN = Math.max(0.008, 10 / Math.max(1, canvasPxShortSide));
  /** Apply the INVERSE of an overlay's rotation to (xn, yn), pivoting
   *  on (pivotXn, pivotYn). Returns the click point in the overlay's
   *  local (unrotated) frame so a bbox test "just works" against the
   *  unrotated rect coords. Rotation around 0 short-circuits.
   *
   *  We rotate in PIXEL space (multiplied through imageDims) so the
   *  result matches what the renderer's `<g transform="rotate(deg cx
   *  cy)">` produces visually. Doing it directly in normalized space
   *  would skew the angle on non-square images (a "90°" rotation
   *  takes the visible top-right to the BOTTOM-right on a portrait
   *  canvas because the normalized y-axis is stretched). */
  const inverseRotateNormalized = (
    px: number,
    py: number,
    pivotXn: number,
    pivotYn: number,
    rotation: number
  ): { xn: number; yn: number } => {
    if (rotation === 0 || imageDims === undefined) {
      return { xn: px, yn: py };
    }
    const W = imageDims.widthPx;
    const H = imageDims.heightPx;
    // Pixel-space deltas from pivot.
    const dxPx = (px - pivotXn) * W;
    const dyPx = (py - pivotYn) * H;
    // Counter-rotate by `-rotation` (the renderer rotated by
    // `+rotation`; the inverse undoes that).
    const cos = Math.cos(-rotation);
    const sin = Math.sin(-rotation);
    const rotatedDxPx = dxPx * cos - dyPx * sin;
    const rotatedDyPx = dxPx * sin + dyPx * cos;
    return {
      xn: pivotXn + rotatedDxPx / W,
      yn: pivotYn + rotatedDyPx / H
    };
  };
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const row = overlays[i];
    if (row === undefined) continue;
    const o = row.data;
    if (o.kind === "shape" || o.kind === "highlight" || o.kind === "blur") {
      // Inverse-rotate the click point into the shape's local frame
      // before the per-shape hit test. Rotation === 0 (and the legacy
      // no-imageDims caller) short-circuits the rotation and falls
      // through to the historical axis-aligned bbox check for rect-
      // shaped kinds.
      const rotation = o.rotation ?? 0;
      const pivotXn = o.rect.x + o.rect.w / 2;
      const pivotYn = o.rect.y + o.rect.h / 2;
      const { xn: tx, yn: ty } = inverseRotateNormalized(
        xn,
        yn,
        pivotXn,
        pivotYn,
        rotation
      );
      // For highlight + blur (always box-shaped) and rect/square shape
      // overlays, use the axis-aligned bbox test. For circle / oval,
      // use the inscribed-ellipse test. For parallelogram, inverse-
      // shear the point back into the un-skewed bbox and bbox-test.
      const shapeKind = o.kind === "shape" ? readShapeKind(o) : "rect";
      const cxn = pivotXn;
      const cyn = pivotYn;
      const halfWn = o.rect.w / 2;
      const halfHn = o.rect.h / 2;
      const localX = tx - cxn;
      const localY = ty - cyn;
      // Outward padding so the user can grab the VISIBLE LINE — not
      // just the path-rect interior. A stroked shape renders with
      // `fill="none"` and a stroke CENTERED on the path (plus a halo
      // extending further out), so the historical path-rect test left
      // the outer ~⅔ of the line dead. We pad by the stroke's outer
      // reach (tracks the painted pixels) PLUS `hitRadiusN` of
      // forgiveness (the same Skitch/CleanShot-style slop arrows and
      // text already get). Reach needs the viewBox dims — when they're
      // absent (legacy callers) we still apply the forgiveness pad so
      // selection stays generous. Highlight / blur (and FILLED shapes,
      // which paint a solid body with no stroke line) have no outer
      // stroke to reach for, so they get the forgiveness pad only.
      const hasStrokeLine = o.kind === "shape" && !readShapeFilled(o);
      const strokeReachPx =
        hasStrokeLine && imageDims !== undefined
          ? shapeStrokeGeometry(
              o.thickness,
              Math.min(imageDims.widthPx, imageDims.heightPx)
            ).outerReachPx
          : 0;
      const padXN =
        (imageDims !== undefined ? strokeReachPx / imageDims.widthPx : 0) +
        hitRadiusN;
      const padYN =
        (imageDims !== undefined ? strokeReachPx / imageDims.heightPx : 0) +
        hitRadiusN;
      if (shapeKind === "circle" || shapeKind === "oval") {
        const rxN = halfWn + padXN;
        const ryN = halfHn + padYN;
        if (rxN <= 0 || ryN <= 0) {
          continue;
        }
        const ndx = localX / rxN;
        const ndy = localY / ryN;
        if (ndx * ndx + ndy * ndy <= 1) return row.id;
        continue;
      }
      if (shapeKind === "parallelogram" && o.kind === "shape") {
        // Reverse the horizontal shear that the renderer applies
        // (per row's skewDeg, falling back to the default for legacy
        // rows). After unshearing, the shape collapses back to the
        // rect bbox; bbox-test that.
        //
        // SIGN + ASPECT derivation (see [docs/solutions] if extracted):
        //
        //   In PIXEL space the polygon's top edge sits at
        //   x = bboxLeft + shearPx, the bottom at x = bboxLeft - shearPx,
        //   where shearPx = (rh_px / 2) · tan(skew). Linear in Yp:
        //     shift(Yp) = -tan(skew) · Yp     (Yp = pixel offset from
        //                                      bbox center, negative
        //                                      above center)
        //   Forward map (interior → drawn): drawnX = origX + shift(Yp)
        //                                          = origX - tan(skew)·Yp
        //   Inverse map: origX = drawnX + tan(skew) · Yp
        //
        //   In NORMALIZED space the shift's units change because the
        //   pixel shift is in canvas-WIDTH pixels while Yp is in
        //   canvas-HEIGHT pixels. Converting through canvas aspect:
        //     shift_norm(Y_norm) = -tan(skew) · Y_norm · (H/W)
        //                       = -tan(skew) · Y_norm / aspect
        //   So:
        //     unshearedX_norm = drawnX_norm + tan(skew) · Y_norm / aspect
        //
        //   When `imageDims` is undefined (legacy test call sites that
        //   skip dims), fall back to aspect = 1 — slightly mis-shaped
        //   hit area but still covers the polygon for square-ish
        //   canvases.
        const skewDeg = readShapeSkewDeg(o);
        const skewRad = (skewDeg * Math.PI) / 180;
        const tanS = Math.tan(skewRad);
        const aspect =
          imageDims !== undefined && imageDims.heightPx > 0
            ? imageDims.widthPx / imageDims.heightPx
            : 1;
        const unshearedX = localX + (localY * tanS) / aspect;
        if (
          unshearedX >= -halfWn - padXN &&
          unshearedX <= halfWn + padXN &&
          localY >= -halfHn - padYN &&
          localY <= halfHn + padYN
        ) {
          return row.id;
        }
        continue;
      }
      // rect / square (and highlight / blur) — axis-aligned bbox,
      // grown outward by the stroke + forgiveness pad.
      if (
        tx >= o.rect.x - padXN &&
        tx <= o.rect.x + o.rect.w + padXN &&
        ty >= o.rect.y - padYN &&
        ty <= o.rect.y + o.rect.h + padYN
      ) {
        return row.id;
      }
      continue;
    }
    if (o.kind === "arrow") {
      // Point-to-segment distance in normalized space.
      const ax = o.from.x;
      const ay = o.from.y;
      const bx = o.to.x;
      const by = o.to.y;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-9) continue;
      let t = ((xn - ax) * dx + (yn - ay) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const distN = Math.hypot(xn - px, yn - py);
      if (distN <= hitRadiusN) return row.id;
      continue;
    }
    if (o.kind === "text") {
      // Full bounding-rect hit so the user can click ANYWHERE inside
      // the text's visible extent — not just the glyph strokes. Pre-
      // fix this used a tiny `hitRadiusN * 4` circle around the
      // anchor point, which meant tiny text (small bucket) had a
      // ~10px-square click target stuck right in the middle of the
      // first line. Users reported having to pixel-hunt the strokes.
      //
      // Box dimensions mirror what `textBoundsBox` in OverlaySvg.tsx
      // computes for the selection outline (after the HTML-text
      // unification: `height = lineCount * fontSize` with
      // `translateY(-50%)` centering on the anchor). Width uses a
      // GENEROUS per-character advance (0.65) plus a small padding
      // so trailing characters and inter-line gaps don't fall just
      // outside the box.
      //
      // Falls back to the pre-fix point-radius when `textDims` isn't
      // threaded — keeps the existing hitTestOverlays.test.ts
      // compatible without forcing every test to inflate its args.
      if (textDims === undefined) {
        const distN = Math.hypot(xn - o.point.x, yn - o.point.y);
        if (distN <= hitRadiusN * 4) return row.id;
        continue;
      }
      const { canvasWidthPx, canvasHeightPx, sourceWidthPx, sourceHeightPx } =
        textDims;
      // sizePx in canvas/source pixel space — same precedence as
      // every other text-sizing call site (storedSizePx wins, then
      // bucket × source-shortSide). Inlined here so we don't have to
      // import @pwrsnap/shared into hitTestOverlays (the helper
      // requires more args than the rest of this function uses).
      const sourceShort = Math.max(
        1,
        Math.min(sourceWidthPx, sourceHeightPx)
      );
      const bucketSizePx =
        o.size === "large"
          ? sourceShort / 18
          : o.size === "medium"
            ? sourceShort / 30
            : sourceShort / 50;
      const sizePx =
        o.sizePx !== undefined &&
        Number.isFinite(o.sizePx) &&
        o.sizePx > 0
          ? o.sizePx
          : bucketSizePx;
      const lines = o.body.split("\n");
      const lineCount = Math.max(1, lines.length);
      const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 1);
      // Preferred path: the glyph's REAL measured box (canvas px),
      // published by TextHtml — the same source the selection outline
      // reads, so the click target covers exactly what the user sees.
      // The width still gets TEXT_BBOX_HIT_WIDTH_SLOP for the same
      // forgiveness as before (clicks just past the right edge register).
      // Falls back to the canvas/char measurement below before the first
      // measurement lands or in jsdom (no live DOM). See
      // text-measure-registry.ts.
      const glyphMeasured = getGlyphSize(row.id);
      let naturalWidthPx: number;
      let naturalHeightPx: number;
      if (
        glyphMeasured !== undefined &&
        glyphMeasured.widthImagePx > 0 &&
        glyphMeasured.heightImagePx > 0
      ) {
        naturalWidthPx = glyphMeasured.widthImagePx * TEXT_BBOX_HIT_WIDTH_SLOP;
        naturalHeightPx = glyphMeasured.heightImagePx;
      } else {
        // Measure the REAL advance width (same metric the selection
        // outline uses) so the click target tracks the glyph extent
        // instead of a char-count guess that mis-sized wide-cap text like
        // `Hi MOm`. Falls back to the char-count advance where a 2D
        // canvas is unavailable (jsdom unit tests). Width floors at 1×
        // fontSize so a 1-char line still has a reasonable click target.
        const measuredWidthPx = measureTextWidthPx(
          o.body,
          sizePx,
          readTextWeight(o)
        );
        naturalWidthPx =
          measuredWidthPx !== null
            ? Math.max(sizePx, measuredWidthPx * TEXT_BBOX_HIT_WIDTH_SLOP)
            : Math.max(sizePx, maxChars * sizePx * TEXT_BBOX_CHAR_ADVANCE_HIT);
        naturalHeightPx = sizePx * lineCount;
      }
      // Box centered vertically on the anchor (matches the HTML
      // wrapper's `translateY(-50%)` layout); left edge at anchor.x.
      const boxXn = o.point.x;
      const boxYn = o.point.y - naturalHeightPx / 2 / canvasHeightPx;
      const boxWn = naturalWidthPx / canvasWidthPx;
      const boxHn = naturalHeightPx / canvasHeightPx;
      // Inverse-rotate the click into the text's local frame so the
      // bbox test "just works" against the unrotated box coords —
      // same pattern as the rect/highlight/blur branch above. Pivot
      // is the BODY-BOX center (same as TextHtml + SelectionOutline
      // + compose.ts use); inverse-rotating in pixel space keeps the
      // angle visually correct on non-square canvases (a "90°"
      // rotation visually drops the top edge to the right edge on a
      // wide canvas; normalized-space rotation would skew the angle
      // because the y-axis is stretched).
      const textRotation = o.rotation ?? 0;
      const textPivotXn = boxXn + boxWn / 2;
      const textPivotYn = boxYn + boxHn / 2;
      const { xn: tx, yn: ty } = inverseRotateNormalized(
        xn,
        yn,
        textPivotXn,
        textPivotYn,
        textRotation
      );
      // Add a small padding (half a hitRadius) on every edge so the
      // user can click slightly past the rendered glyph and still
      // land on the layer. Matches the affordance Cleanshot / Skitch
      // ship for text annotations.
      const padN = hitRadiusN * 0.5;
      if (
        tx >= boxXn - padN &&
        tx <= boxXn + boxWn + padN &&
        ty >= boxYn - padN &&
        ty <= boxYn + boxHn + padN
      ) {
        return row.id;
      }
      continue;
    }
    // crop / step: not user-selectable in Phase 3.2 (crop is a
    // canvas-side mutation, not a layer; step is legacy).
  }
  return null;
}

export function Editor({
  captureId,
  chrome = "full",
  tool: toolProp,
  onToolChange,
  toolState: toolStateProp,
  blurStyle: blurStyleProp,
  onZoomChange,
  onSelectionChange,
  onLayersApi
}: {
  captureId: string;
  /** Chrome shape — see `EditorChromeKind` above. Defaults to `"full"`. */
  chrome?: EditorChromeKind;
  /** Optional controlled tool state. If both `tool` and `onToolChange`
   *  are passed, Editor is fully controlled — Library owns the tool
   *  state and drives the floating EditToolbar. If neither is passed,
   *  Editor falls back to internal state (the standalone window uses
   *  `useEditorToolState` in that branch; the embedded fallback uses a
   *  plain useState). Mixed (one without the other) is not supported
   *  and will fall back to internal state. */
  tool?: Tool;
  onToolChange?: (tool: Tool) => void;
  /** Optional controlled tool-state surface — Phase 3.2 lift. When
   *  provided (Library Focus path), Editor reads `activeStyle` /
   *  `onAnnotationPlaced` from this shared hook instance instead of
   *  its own dormant copy. The lift fixes the long-standing "popover
   *  picks land in EditToolbar's hook, persistOverlay reads from
   *  Editor's hook, so style choices don't stick" bug. Full editor
   *  chrome leaves this undefined and keeps owning its own hook. */
  toolState?: UseEditorToolStateReturn;
  /** Optional controlled blur-style state. When provided (Library
   *  mode), Library owns the v1-string-shaped blur mode and writes
   *  it back via the EditToolbar's hook-mirror effect (post-
   *  BlurMenu-fold the picker UI lives in the unified
   *  ToolStylePopover). When omitted, the editor falls back to the
   *  `useEditorToolState` blur tool style block. */
  blurStyle?: BlurStyle;
  /** Called whenever the editor's zoom state changes. Library uses
   *  this to render the zoom indicator in the floating EditToolbar
   *  (so the indicator doesn't float over the image). Called with
   *  `null` on unmount so the parent can clear its cached api. */
  onZoomChange?: (api: ZoomApi) => void;
  /** Called whenever the canvas selection changes (canvas → panel).
   *  Library mirrors this into state so the Layers panel can highlight
   *  the selected rows. The editor remains the single source of truth
   *  for selection — this only reports it upward. */
  onSelectionChange?: (ids: readonly string[]) => void;
  /** Publishes the imperative Layers-panel API (panel → canvas), same
   *  callback pattern as `onZoomChange`. `null` on unmount. */
  onLayersApi?: (api: LayersPanelApi | null) => void;
}) {
  // ----- Capture data ---------------------------------------------
  //
  // Phase 2 v2 editor refresh — single hook owns both v1 and v2 reads
  // plus the cancel-safety dance + broadcast-driven refetch. The hook
  // returns a discriminated union (loading / loaded-v1 / loaded-v2 /
  // error); we project v2 layers back to OverlayRow[] for the existing
  // OverlaySvg / BlurOverlays render path (read-only — write paths
  // still go through overlays:upsert for v1; v2 writes are Phase 4-5).
  const rawModel = useCaptureModel(captureId);

  // ----- Hidden-crop "show the full image" viewport ----------------
  //
  // When the lone crop layer is HIDDEN (eye toggled off in the Layers
  // panel), resolveCropViewport projects the layer tree into the full
  // source image's space at its natural dims. We feed that VIRTUAL model
  // to the entire editor below — so the canvas, hit-test, projection,
  // and placement all render/operate on the full image with ZERO
  // per-seam changes — and wrap dispatchEdit so any draw/move the user
  // makes on the uncropped view is mapped back into stored (cropped)
  // coords before it persists. The projection is pure (reads only frozen
  // storage), so toggling the crop on/off is bit-stable; nothing is ever
  // re-normalized into storage, so annotations never walk.
  //
  // Two ops stay on the RAW model: the Layers panel's `uncrop` (needs
  // the real cropped dims to compute the inverse — see EditorLoaded) and
  // re-cropping while uncropped (guarded off in onCropCommit). Both are
  // handled explicitly below; everything else flows through the wrapper.
  const loadedRaw = rawModel.kind === "loaded" ? rawModel : null;
  const cropViewport = useMemo(
    () =>
      loadedRaw === null
        ? null
        : resolveCropViewport({
            layers: loadedRaw.layers,
            canvasWidthPx: loadedRaw.record.width_px,
            canvasHeightPx: loadedRaw.record.height_px
          }),
    [loadedRaw]
  );
  const isUncroppedView = cropViewport?.uncropped === true;
  // Primitive deps keep the wrapped dispatch reference-stable across
  // plain refetches — only an actual crop change moves these.
  const vpRectX = isUncroppedView ? cropViewport!.rect!.x : 0;
  const vpRectY = isUncroppedView ? cropViewport!.rect!.y : 0;
  const vpRectW = isUncroppedView ? cropViewport!.rect!.w : 1;
  const vpRectH = isUncroppedView ? cropViewport!.rect!.h : 1;
  const vpNaturalW = isUncroppedView ? cropViewport!.widthPx : 0;
  const vpNaturalH = isUncroppedView ? cropViewport!.heightPx : 0;
  const rawDispatch = loadedRaw?.dispatchEdit;
  const displayDispatch = useMemo(() => {
    if (!isUncroppedView || rawDispatch === undefined) return rawDispatch;
    const rect = { x: vpRectX, y: vpRectY, w: vpRectW, h: vpRectH };
    return (op: LayerEditOp) =>
      rawDispatch(forwardOpToStored(op, rect, vpNaturalW, vpNaturalH));
  }, [isUncroppedView, rawDispatch, vpRectX, vpRectY, vpRectW, vpRectH, vpNaturalW, vpNaturalH]);

  const model = useMemo(() => {
    if (
      loadedRaw === null ||
      cropViewport === null ||
      !cropViewport.uncropped ||
      displayDispatch === undefined
    ) {
      return rawModel;
    }
    return {
      ...loadedRaw,
      record: {
        ...loadedRaw.record,
        width_px: cropViewport.widthPx,
        height_px: cropViewport.heightPx
      },
      layers: cropViewport.layers,
      dispatchEdit: displayDispatch
    };
  }, [rawModel, loadedRaw, cropViewport, displayDispatch]);

  // Map a geometry from displayed (source) space into STORED space for
  // UNDO RECORDING. Undo/redo replays through the RAW dispatcher
  // (rawDispatchEdit), so every recorded artifact must be in stored
  // (cropped) space; recording the display-space geometry would mis-
  // position the layer on undo while a crop is hidden. Identity when the
  // crop is visible. Applied ONLY to the recorded copy — the DISPATCHED
  // geometry stays in display space (the wrapper maps that one).
  const toStoredGeometry = useCallback(
    (g: GeometryUpdate): GeometryUpdate =>
      isUncroppedView
        ? forwardGeometry(g, { x: vpRectX, y: vpRectY, w: vpRectW, h: vpRectH })
        : g,
    [isUncroppedView, vpRectX, vpRectY, vpRectW, vpRectH]
  );

  // ----- Tool + style state ---------------------------------------
  //
  // Two-mode source-of-truth:
  //
  //   • Controlled (Library Focus): `tool` + `onToolChange` props are
  //     both passed. Library is the single owner; per-tool style memory
  //     lives in the floating EditToolbar's own hook in task #10.
  //   • Full editor chrome (chrome === "full"): we own the hook here.
  //     Active tool + per-tool style memory + matching-text affordance
  //     all live in `useEditorToolState`.
  //
  // The hook is ALWAYS instantiated (hooks rules) but its result is only
  // consumed when not in controlled mode. The controlled branch keeps
  // the hook in a stable state — its tool stays "pointer" because
  // controlled paths never call setActiveTool.
  const isControlled = toolProp !== undefined && onToolChange !== undefined;
  // Phase 3.2 lift: in Library Focus, the parent owns ONE hook instance
  // that's also threaded into EditToolbar — so popover style picks land
  // in the same `activeStyle` that `persistOverlay` reads here. When
  // not lifted, instantiate our own hook.
  // We always call the hook (rules of hooks), then pick whichever source
  // is active. `effectiveToolState` is what every downstream read uses.
  const ownToolState = useEditorToolState({ captureId });
  const effectiveToolState: UseEditorToolStateReturn =
    toolStateProp ?? ownToolState;
  const tool: Tool = isControlled ? toolProp : effectiveToolState.activeTool;
  // `options.singleShot` is the ⌥-click escape hatch: place ONE
  // annotation, then return to Pointer. The hook honors the flag by
  // routing `onAnnotationPlaced` through a single-shot reset; the
  // controlled (Library Focus) path doesn't see this — it has its own
  // mirror in features/library/EditToolbar.tsx that wires the same
  // semantic through the hook instantiated there.
  const setTool = useCallback(
    (next: Tool, options?: { singleShot?: boolean }): void => {
      if (isControlled) {
        onToolChange(next);
      } else {
        effectiveToolState.setActiveTool(next, options);
      }
    },
    [isControlled, onToolChange, effectiveToolState]
  );

  // Blur style for the commit pipeline:
  //   • Library (controlled) → use the `blurStyle` prop the parent
  //     threads in (EditToolbar mirrors `toolState.activeStyle.style.
  //     mode` back into Library's state via a sync effect).
  //   • Standalone → take the live blur-tool-style mode from the hook,
  //     falling back to the default until settings resolve.
  const blurStyle: BlurStyle = useMemo(() => {
    if (blurStyleProp !== undefined) return blurStyleProp;
    if (effectiveToolState.activeStyle.tool === "blur") {
      return effectiveToolState.activeStyle.style.mode;
    }
    // For non-blur active tools in standalone mode, we still need a
    // mode for the rare ad-hoc shortcut commit. Read the blur block
    // through a temporary tool switch is overkill — the hook's
    // activeStyle only carries the active tool's block. Fall back to
    // the persisted default; the popover/panel writes will update this
    // path on the next blur-tool selection.
    return DEFAULT_BLUR_STYLE;
  }, [blurStyleProp, effectiveToolState.activeStyle]);

  const blurRadiusPx: number | undefined = useMemo(() => {
    if (
      effectiveToolState.activeStyle.tool === "blur" &&
      effectiveToolState.activeStyle.style.radius.mode === "px"
    ) {
      return effectiveToolState.activeStyle.style.radius.value;
    }
    return undefined;
  }, [effectiveToolState.activeStyle]);

  const [draft, setDraft] = useState<Draft | null>(null);
  // Multi-select model. Tracks the ids of all currently-selected
  // overlays/layers; empty array means nothing selected.
  //
  // Selection gestures:
  //   • Plain click on a layer → replaces selection with [hit]
  //   • Cmd/Ctrl-click on a layer → toggles membership of hit
  //   • Click on empty canvas → clears
  //   • Cmd+A → select all
  //   • Escape → clears
  //
  // Operations on selection:
  //   • Delete / Backspace → delete every selected layer
  //   • Arrow keys → nudge every selected by 1px (Shift = 10px)
  //   • Cmd+C / Cmd+V / Cmd+D → copy / paste / duplicate selected
  //   • Cmd+] / Cmd+[ → bring forward / send backward
  //   • Cmd+Shift+] / Cmd+Shift+[ → bring to front / send to back
  //
  // Single-selection-only features (TransformHandles, popover-
  // switches-to-selected-style) read `primarySelectedLayerId` below
  // — they render only when exactly one layer is selected. Resize +
  // per-layer style edits still require single-select; everything
  // else honours the full selection.
  const [selectedLayerIds, setSelectedLayerIds] = useState<readonly string[]>([]);
  // IDs that we just set via `setSelectionTrustingDispatch` (nudge,
  // paste, duplicate, create) but that may not yet have landed in
  // `overlaysForRender` because the events:overlays:changed broadcast
  // → refetch round-trip hadn't finished by the next render. The
  // stale-id cleanup below skips removal of any id in this set so the
  // selection isn't wiped between the dispatch resolving and the
  // broadcast arriving. Each id is dropped from the set as soon as it
  // appears in `alive` (= broadcast caught up).
  //
  // Without this, nudge looked broken: arrow-key dispatched, row id
  // changed to a NEW value, setSelectedLayerIds([newId]) ran, render
  // ran with overlaysForRender STILL pointing at the old row → the
  // cleanup saw [newId] absent from alive → wiped the selection →
  // the user saw the layer move 1px and the grippers vanish.
  // Subsequent arrow keys fell through to the Library reel.
  const inFlightSelectionIdsRef = useRef<Set<string>>(new Set());
  /** Replace selection with ids that just came back from a successful
   *  dispatch. The ids exist in the DB but may not be in
   *  `overlaysForRender` yet — the in-flight set keeps the cleanup
   *  honest until the broadcast lands. */
  const setSelectionTrustingDispatch = (newIds: readonly string[]): void => {
    if (newIds.length > 0) {
      const next = new Set(inFlightSelectionIdsRef.current);
      for (const id of newIds) next.add(id);
      inFlightSelectionIdsRef.current = next;
    }
    setSelectedLayerIds(newIds);
  };
  // Convenience helpers for callers that don't want to manage the
  // readonly-array dance. Stable identity isn't required since they
  // call setState directly.
  const replaceSelection = (id: string | null): void => {
    setSelectedLayerIds(id === null ? [] : [id]);
  };
  const toggleSelection = (id: string): void => {
    setSelectedLayerIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };
  const clearSelection = (): void => setSelectedLayerIds([]);
  // Primary id for single-selection-only features. Null when nothing
  // is selected OR when multiple are selected — both cases hide the
  // transform handles and the per-layer style popover surface.
  const primarySelectedLayerId: string | null =
    selectedLayerIds.length === 1 ? (selectedLayerIds[0] ?? null) : null;
  // Mirror of the resolved overlay list, kept in a ref so
  // onPointerDown's hit-test reads the latest value without bouncing
  // through state. The list itself lives in the EditorLoaded child
  // (after the model resolves); we project a v1-shaped view of it
  // here for the synchronous click handler.
  const overlaysRef = useRef<OverlayRow[]>([]);
  // Non-source raster layers (pasted images, captured cursor) — outside
  // the OverlayRow system, so the pointerdown raster hit-test + Cmd+A +
  // delete read them from here (synced in render, same pattern as
  // overlaysRef).
  const rastersRef = useRef<readonly Extract<BundleLayerNode, { kind: "raster" }>[]>([]);
  // The base Source raster id. Cmd+A includes it so "select all → copy"
  // grabs the whole image (base + annotations), not just the overlays.
  // Kept out of `rastersRef` (the hit-test + delete sets) so the Source
  // stays non-clickable + non-deletable; it's only ever added to the
  // select-all set for copy.
  const sourceRasterIdRef = useRef<string | null>(null);
  // Multi-select drag state. Populated by `onPointerDown` when the
  // user clicks a layer already in a multi-selection (= the
  // `decideClickSelection` "keep" action with selection size > 1).
  // Holds the pre-drag pointer position plus per-layer geometry
  // snapshots; `onPointerUp` reads it back to compute the cursor
  // delta and dispatch one updateGeometry per layer. Cleared on
  // pointerup OR if the user releases outside the canvas. No live
  // preview during the drag for v1 — the layers jump to the final
  // position on pointerup; a follow-up can add a multi-id
  // liveOverride for the in-flight preview if desired.
  const multiDragStartRef = useRef<{
    startXn: number;
    startYn: number;
    pointerId: number;
    snapshots: { id: string; data: OverlayRow["data"] }[];
  } | null>(null);
  // EditorLoaded populates this with a closure over `dispatchEdit` +
  // `undo` so the outer onPointerUp (which doesn't have direct access
  // to either) can commit the multi-drag. Same ref pattern as
  // `deleteSelectedRef` / `nudgeSelectedRef`.
  const commitMultiDragRef = useRef<
    | ((
        snapshots: readonly { id: string; data: OverlayRow["data"] }[],
        dxn: number,
        dyn: number
      ) => Promise<void>)
    | null
  >(null);
  // Live-drag preview: a map of layer id → in-progress geometry that
  // every overlay renderer (OverlaySvg / BlurOverlays /
  // TextHtmlOverlays) projects onto the matching row so the painted
  // glyph follows the user's cursor in real time. Lives at the outer
  // Editor scope (rather than inside EditorLoaded where the
  // renderers themselves live) because the multi-drag gesture's
  // pointermove / cancel / up handlers — defined HERE in the outer
  // function — set it. EditorLoaded receives both halves via props
  // and threads `draftGeometry` down to the three renderers as
  // `liveOverride`.
  //
  // Map shape (vs the previous single-id `{ layerId, geometry }`)
  // because multi-drag needs N concurrent overrides — one per
  // selected layer. Single-select drags emit a 1-entry map through
  // the same path so both gestures share one renderer contract.
  const [draftGeometry, setDraftGeometry] = useState<
    ReadonlyMap<string, GeometryUpdate> | null
  >(null);
  // Right-click context menu state. Lives at the outer Editor scope
  // (same rationale as `draftGeometry`): the `onContextMenu` handler
  // that opens it is defined HERE so it can call into outer-scope
  // helpers like `hitTestOverlays` + the selection mutators
  // (`replaceSelection` / `toggleSelection`), and EditorLoaded
  // receives `contextMenuState` + `setContextMenuState` as props so
  // it can render the `<LayerContextMenu>` over the canvas and
  // route item clicks back into its own scope's handlers
  // (`copySelected` / `pasteFromClipboard` / `deleteSelectedRef`
  // etc.).
  //
  // `selectedIdsAtOpen` is captured so the close-on-selection-change
  // useEffect can distinguish "the open itself changed selection"
  // (don't close) from "a later selection-change closed the menu"
  // (do close). Without this, the menu would self-close on the same
  // render it opened.
  const [contextMenuState, setContextMenuState] = useState<{
    anchorPx: { x: number; y: number };
    selectedIdsAtOpen: readonly string[];
  } | null>(null);
  // Canvas + source dims read by `hitTestOverlays` so text overlays
  // get a FULL bounding-rect hit target (matches the on-screen
  // rendered glyph extent), not a tiny radius around the anchor.
  // EditorLoaded populates this ref each render — same pattern as
  // `overlaysRef`. Null until the model resolves.
  const textHitDimsRef = useRef<{
    canvasWidthPx: number;
    canvasHeightPx: number;
    sourceWidthPx: number;
    sourceHeightPx: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  // Edit-mode keystroke sink — an invisible (color: transparent)
  // textarea that overlays a visible display div in TextDraftInput.
  // The visible text is NEVER rendered by an editable element, so
  // contentEditable rendering quirks (missing text-stroke, line-
  // height drift, DOM normalization) cannot cause display-vs-edit
  // visual deltas by construction.
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  // True while undo/redo is replaying an op via the IPC. The
  // events:overlays:changed broadcast will fire and refetch; we
  // don't want that refetch to re-record a new EditOp.
  const undoApplyingRef = useRef<boolean>(false);
  // Hook-owned recorder, populated by EditorLoaded once the record
  // resolves. persistOverlay needs to call it; the hook lives in the
  // child so it can depend on the loaded record's id.
  //
  // The optional `node` arg is the freshly-inserted v2 BundleLayerNode
  // — required for undo of a v2 create (the redo path needs to
  // `layers:upsert` with the original layer shape, not just the v1
  // overlay data).
  const recordCreateRef = useRef<
    | ((
        row: OverlayRow,
        opts?: { node?: BundleLayerNode | null }
      ) => void)
    | null
  >(null);
  // Crop-specific recorder. Populated by EditorLoaded alongside
  // recordCreateRef. Receives both the original normalized rect and
  // the previous + new canvas dims (for v2 undo via
  // bundle:updateCanvasDimensions).
  const recordCropRef = useRef<
    | ((entry: {
        rect: { x: number; y: number; w: number; h: number };
        previousWidthPx: number;
        previousHeightPx: number;
        newWidthPx: number;
        newHeightPx: number;
      }) => void)
    | null
  >(null);
  // Style/body recorder. Populated by EditorLoaded alongside
  // recordCreateRef. commitText's text re-edit path reads it to push a
  // style op onto the undo stack so ⌘Z reverts a body change
  // ("Hi Mommy" → "Hi Mom") instead of falling through to the previous
  // create. `currentIdRef` follows the layer's id across undo/redo
  // cycles (a no-op now that updateOverlay preserves the id, but the
  // shape stays honest for any future churn).
  const recordStyleRef = useRef<
    | ((entry: {
        currentIdRef: { current: string };
        previousPatch: Partial<Overlay>;
        nextPatch: Partial<Overlay>;
      }) => void)
    | null
  >(null);
  // Coalescing bracket refs (Phase 2 task #14, plan Alt 5). pointerdown
  // opens a "drag" interaction; pointerup closes it. Current Phase 2
  // editor flows commit exactly one recordCreate per drag at pointerup,
  // so the bracket is a no-op for now — the API is exercised here so
  // Phase 4+ drag-existing-overlay paths pick up the coalescing
  // automatically without touching pointer handlers.
  const beginInteractionRef = useRef<
    ((opKind: string, layerId: string) => InteractionToken) | null
  >(null);
  const endInteractionRef = useRef<((token: InteractionToken) => void) | null>(
    null
  );
  const activeInteractionTokenRef = useRef<InteractionToken | null>(null);

  // Auto-focus the text input when entering text-draft state.
  useEffect(() => {
    if (draft?.kind === "text") {
      textInputRef.current?.focus();
    }
  }, [draft]);

  // Close the context menu when ANYTHING that should invalidate it
  // changes: selection changes after open (e.g. broadcast refetch
  // landed a delete from another window), tool changes (different
  // tool = different valid menu), or the draft input opens (the
  // text-edit gesture and the context menu shouldn't both be live).
  // The capture-switch case is handled by React unmount.
  //
  // selectedIdsAtOpen captured at open distinguishes "the open
  // itself changed selection" (don't close the freshly-opened menu)
  // from "a later change happened" (close).
  useEffect(() => {
    if (contextMenuState === null) return;
    const opened = contextMenuState.selectedIdsAtOpen;
    const sameSelection =
      opened.length === selectedLayerIds.length &&
      opened.every((id, i) => id === selectedLayerIds[i]);
    if (!sameSelection) {
      setContextMenuState(null);
    }
  }, [selectedLayerIds, contextMenuState]);
  useEffect(() => {
    if (contextMenuState !== null) {
      setContextMenuState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  useEffect(() => {
    if (draft !== null && contextMenuState !== null) {
      setContextMenuState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function clientToNormalized(
    clientX: number,
    clientY: number
  ): { xn: number; yn: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const xn = (clientX - rect.left) / rect.width;
    const yn = (clientY - rect.top) / rect.height;
    if (xn < 0 || xn > 1 || yn < 0 || yn > 1) return null;
    return { xn, yn };
  }

  /** Like `clientToNormalized` but WITHOUT the in-bounds null check — a
   *  multi-drag IN PROGRESS must keep tracking (and ultimately commit)
   *  the cursor even when it leaves the canvas, because annotations are
   *  allowed to sit partially/fully off the (cropped) viewport. Using the
   *  clamped variant here froze the live preview at the edge and, worse,
   *  made `onPointerUp` skip the commit when the cursor was released
   *  outside the canvas — leaving a stale live-drag override that painted
   *  the layer off-canvas, never clipped, and masked undo. Returns null
   *  only when the canvas isn't mounted. */
  function clientToNormalizedUnclamped(
    clientX: number,
    clientY: number
  ): { xn: number; yn: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      xn: (clientX - rect.left) / rect.width,
      yn: (clientY - rect.top) / rect.height
    };
  }

  /** Translate normalized [0,1] coords back to canvas-pixel coords —
   *  used to anchor the matching-text affordance at the arrow's tail
   *  in the same coordinate space the canvas overlay renders in. */
  function normalizedToCanvasPx(
    xn: number,
    yn: number
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: xn * rect.width, y: yn * rect.height };
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    // Defensive clear of any stale multi-drag state. The arming path
    // below stores snapshots in `multiDragStartRef.current` and
    // relies on `onPointerUp` / `onPointerCancel` to clear it; if
    // either of those was skipped (OS cancellation, window blur
    // mid-drag, hot-reload during dev) the next pointerdown would
    // see a stale ref. Without this reset, the next pointerup would
    // commit a translation against the OLD snapshots using the NEW
    // cursor delta — totally unrelated layers would jump. Cheap
    // unconditional reset is the right discipline.
    multiDragStartRef.current = null;
    // Phase 3.2 selection: pointer tool clicks hit-test against
    // existing overlays. Hit → select that overlay. Miss → clear.
    // The hit-test runs against `overlaysRef.current` which the
    // EditorLoaded child keeps in sync (the overlay list lives on
    // that branch). Crop still owns its own canvas via its overlay
    // element; pointer-mode only ever sees pointerdown when the
    // user actually clicks on `.editor-canvas`.
    if (tool === "pointer") {
      const start = clientToNormalized(event.clientX, event.clientY);
      if (start === null) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      const shortSide =
        rect === undefined ? 1000 : Math.min(rect.width, rect.height);
      const overlays = overlaysRef.current;
      // textHitDimsRef carries canvas + source dims for the hit-test:
      //   • text overlays get full bounding-rect hit (vs point-radius)
      //   • rect / highlight / blur with rotation get inverse-rotated
      //     into local frame before bbox testing so the visible
      //     rotated glyph is what's selectable.
      const overlayHit = hitTestOverlays(
        overlays,
        start.xn,
        start.yn,
        shortSide,
        textHitDimsRef.current ?? undefined
      );
      // Non-source raster layers live outside the OverlayRow system, so
      // hit-test them separately and pick the topmost (higher z_index
      // wins; a tie favors the raster). Same canvas-normalized space as
      // the pointer + the overlay hit-test.
      const dimsForHit = textHitDimsRef.current;
      const rasterHit =
        dimsForHit === null
          ? null
          : hitTestRasterLayers(
              rastersRef.current,
              start.xn,
              start.yn,
              dimsForHit.canvasWidthPx,
              dimsForHit.canvasHeightPx,
              0.006
            );
      let hit = overlayHit;
      if (rasterHit !== null) {
        const overlayZ =
          overlayHit === null
            ? Number.NEGATIVE_INFINITY
            : overlays.find((o) => o.id === overlayHit)?.z_index ?? Number.NEGATIVE_INFINITY;
        if (overlayHit === null || rasterHit.zIndex >= overlayZ) hit = rasterHit.id;
      }
      // Decision matrix lives in `decideClickSelection` so both the
      // pointer-tool and drawing-tool branches share one source of
      // truth (and one regression-tested module). The `keep` action
      // is the load-bearing addition for multi-select drag: plain
      // click on a layer ALREADY in the selection preserves the
      // group instead of collapsing it to a singleton, so the user
      // can drag the whole group together.
      const additive = event.metaKey || event.ctrlKey;
      const action = decideClickSelection({
        hit,
        currentSelection: selectedLayerIds,
        additive
      });
      if (action.type === "replace") replaceSelection(action.id);
      else if (action.type === "toggle") toggleSelection(action.id);
      else if (action.type === "clear") clearSelection();
      // `keep` = selection unchanged.
      // If the click landed on a layer already in a MULTI-selection
      // (selection size > 1) — initiate a group drag-to-move.
      // Single-selected drags still go through TransformHandles'
      // body-hit rect (which catches the pointerdown before this
      // code runs), so we only kick off the multi-drag when the
      // selection actually has >1 member.
      if (
        action.type === "keep" &&
        hit !== null &&
        selectedLayerIds.length > 1 &&
        selectedLayerIds.includes(hit)
      ) {
        const snapshots = selectedLayerIds
          .map((id) => {
            const row = overlays.find((o) => o.id === id);
            return row !== undefined ? { id, data: row.data } : null;
          })
          .filter((s): s is { id: string; data: OverlayRow["data"] } => s !== null);
        if (snapshots.length > 0) {
          multiDragStartRef.current = {
            startXn: start.xn,
            startYn: start.yn,
            pointerId: event.pointerId,
            snapshots
          };
          (event.target as HTMLElement).setPointerCapture(event.pointerId);
        }
      }
      return;
    }
    if (tool === "crop") return;
    // If we're mid-text and the user clicks elsewhere, commit/cancel
    // the text first (the input's blur handler will fire).
    if (draft?.kind === "text") return;

    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;

    // Drawing tools (arrow / rect / highlight / blur / text) hit-test
    // existing layers BEFORE starting a new draft. A click that lands
    // on an existing overlay should select it (so TransformHandles
    // renders and the user can move/resize/delete via handles or
    // Delete-key), NOT silently draw a fresh layer on top — the user
    // typically wants to edit the thing they clicked, not stack
    // another one over it. Miss → fall through to the drawing-tool
    // branches below.
    {
      const rect = canvasRef.current?.getBoundingClientRect();
      const shortSide =
        rect === undefined ? 1000 : Math.min(rect.width, rect.height);
      const overlays = overlaysRef.current;
      // textHitDimsRef carries canvas + source dims — same
      // rationale as the pointer-tool branch above.
      const hit = hitTestOverlays(
        overlays,
        start.xn,
        start.yn,
        shortSide,
        textHitDimsRef.current ?? undefined
      );
      if (hit !== null) {
        // Same decision logic as the pointer-tool branch above.
        // Drawing-tool clicks that land on an existing overlay
        // route through the same selection model so the multi-
        // select drag-to-move gesture works whether the user is on
        // the pointer tool or any drawing tool.
        const additive = event.metaKey || event.ctrlKey;
        const action = decideClickSelection({
          hit,
          currentSelection: selectedLayerIds,
          additive
        });
        if (action.type === "replace") replaceSelection(action.id);
        else if (action.type === "toggle") toggleSelection(action.id);
        else if (action.type === "clear") clearSelection();
        // Multi-drag init — mirror of the pointer-tool branch.
        if (
          action.type === "keep" &&
          selectedLayerIds.length > 1 &&
          selectedLayerIds.includes(hit)
        ) {
          const snapshots = selectedLayerIds
            .map((id) => {
              const row = overlays.find((o) => o.id === id);
              return row !== undefined ? { id, data: row.data } : null;
            })
            .filter(
              (s): s is { id: string; data: OverlayRow["data"] } => s !== null
            );
          if (snapshots.length > 0) {
            multiDragStartRef.current = {
              startXn: start.xn,
              startYn: start.yn,
              pointerId: event.pointerId,
              snapshots
            };
            (event.target as HTMLElement).setPointerCapture(event.pointerId);
          }
        }
        return;
      }
    }
    // Drawing a new annotation on empty canvas deselects any previous
    // selection so the outline doesn't linger on top of the new draft.
    if (selectedLayerIds.length > 0) clearSelection();
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);

    // Open a coalescing bracket for the drag. layerId uses the tool
    // name as a sentinel since the actual layer doesn't exist yet
    // (it's created at pointerup via persistOverlay). For Phase 2's
    // one-write-per-drag flow this bracket is a no-op for coalescing;
    // it's wired here so Phase 4+'s drag-existing-overlay path
    // automatically picks up the coalescing semantics.
    if (tool !== "text" && beginInteractionRef.current !== null) {
      activeInteractionTokenRef.current = beginInteractionRef.current(
        "drag",
        `draft-${tool}`
      );
    }

    if (tool === "arrow") {
      setDraft({
        kind: "arrow",
        fromXn: start.xn,
        fromYn: start.yn,
        toXn: start.xn,
        toYn: start.yn
      });
      return;
    }
    if (tool === "shape" || tool === "highlight" || tool === "blur") {
      // For the Shape tool, capture which shape kind the popover is
      // currently set to so the draft renders the right primitive in
      // the live preview AND rectFromDrag applies the 1:1 lock for
      // square/circle. Highlight + blur don't carry a shape kind.
      const shapeKind =
        tool === "shape" &&
        effectiveToolState.activeStyle.tool === "shape"
          ? effectiveToolState.activeStyle.style.shape
          : undefined;
      setDraft({
        kind: "shape-drag",
        tool,
        startXn: start.xn,
        startYn: start.yn,
        curXn: start.xn,
        curYn: start.yn,
        ...(shapeKind !== undefined ? { shape: shapeKind } : {})
      });
      return;
    }
    if (tool === "text") {
      // Click-to-place anchors a text input at the cursor. The input
      // captures keystrokes; Enter commits.
      setDraft({ kind: "text", xn: start.xn, yn: start.yn, body: "" });
      return;
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    // Multi-select drag live preview. While the user is dragging a
    // multi-selection (armed by `onPointerDown` when they clicked an
    // already-selected layer), every pointermove translates each
    // selected layer's pre-drag snapshot by the cursor delta and
    // stashes the result in `draftGeometry` as a Map<id, geometry>.
    // OverlaySvg / BlurOverlays / TextHtmlOverlays all consume that
    // map and paint each entry's row at its overridden geometry.
    // pointerup commits the same delta via dispatchEdit and clears
    // the override.
    //
    // Runs BEFORE the draft branch — the multi-drag gesture is
    // unrelated to drafts (which only fire when a drawing tool was
    // selected and the user is mid-shape).
    const multiDrag = multiDragStartRef.current;
    if (multiDrag !== null) {
      // Unclamped: the preview must follow the cursor past the canvas
      // edge so the user can drag a layer (partially) off the viewport.
      const cur = clientToNormalizedUnclamped(event.clientX, event.clientY);
      if (cur === null) return;
      const dxn = cur.xn - multiDrag.startXn;
      const dyn = cur.yn - multiDrag.startYn;
      // Don't paint a preview until the user has moved past the
      // no-drag threshold. Below that, the gesture is still
      // ambiguous (click-without-drag) and showing a 0-delta
      // override would just rebuild the Map for nothing. Same
      // threshold the commit path uses.
      const MIN_MULTI_DRAG_N = 0.002;
      if (Math.hypot(dxn, dyn) < MIN_MULTI_DRAG_N) return;
      // Build the per-layer override map. translateOverlayGeometry
      // returns null for layer kinds with no geometry (crop) — skip
      // those entries (the unrelated bbox of the on-canvas crop tool
      // shouldn't follow a drag of arrows).
      const next = new Map<string, GeometryUpdate>();
      for (const snapshot of multiDrag.snapshots) {
        const geom = translateOverlayGeometry(snapshot.data, dxn, dyn);
        if (geom !== null) next.set(snapshot.id, geom);
      }
      setDraftGeometry(next.size > 0 ? next : null);
      return;
    }
    if (draft === null) return;
    if (draft.kind === "text") return;
    const cur = clientToNormalized(event.clientX, event.clientY);
    if (cur === null) return;
    if (draft.kind === "arrow") {
      setDraft({ ...draft, toXn: cur.xn, toYn: cur.yn });
      return;
    }
    if (draft.kind === "shape-drag") {
      setDraft({ ...draft, curXn: cur.xn, curYn: cur.yn });
      return;
    }
  }

  function onContextMenu(event: React.MouseEvent<HTMLDivElement>): void {
    // Right-click on the canvas: select-under-cursor (replace OR
    // extend if Cmd-held) and open the layer context menu at the
    // click anchor. preventDefault to suppress the native OS menu —
    // Electron would otherwise show its default "Reload / Inspect
    // Element" menu over the editor.
    //
    // The handler runs in the OUTER Editor function so it can call
    // outer-scope helpers (`hitTestOverlays`, `replaceSelection`,
    // `toggleSelection`); EditorLoaded picks up `contextMenuState`
    // via props and renders the menu inside the canvas.
    event.preventDefault();
    const start = clientToNormalized(event.clientX, event.clientY);
    if (start === null) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    const shortSide =
      rect === undefined ? 1000 : Math.min(rect.width, rect.height);
    const overlays = overlaysRef.current;
    const hit = hitTestOverlays(
      overlays,
      start.xn,
      start.yn,
      shortSide,
      textHitDimsRef.current ?? undefined
    );
    // Selection-update rule (per issue #134 + Photoshop / Figma
    // convention):
    //   - hit + not already selected + no Cmd → REPLACE selection
    //   - hit + Cmd-held → toggle (extend / remove)
    //   - hit + already in selection + no Cmd → keep selection
    //     (right-clicking an already-selected member of a group
    //     shouldn't collapse the group; the menu acts on the whole
    //     group)
    //   - miss → keep selection unchanged (the menu still opens
    //     with Paste enabled etc.; closing nothing reads as "the
    //     menu opened over empty canvas, here are the things I
    //     can do without a selection")
    const additive = event.metaKey || event.ctrlKey;
    let nextSelection: readonly string[] = selectedLayerIds;
    if (hit !== null) {
      if (additive) {
        nextSelection = selectedLayerIds.includes(hit)
          ? selectedLayerIds.filter((id) => id !== hit)
          : [...selectedLayerIds, hit];
        setSelectedLayerIds(nextSelection);
      } else if (!selectedLayerIds.includes(hit)) {
        nextSelection = [hit];
        setSelectedLayerIds(nextSelection);
      }
    }
    // Anchor the menu at the click position in CANVAS-WRAP-LOCAL
    // CSS pixels. The menu's offsetParent is the canvas wrap (the
    // closest positioned ancestor), so subtracting the wrap's
    // boundingClientRect gives us the right local coords.
    const wrap = canvasWrapRef.current;
    const wrapRect = wrap?.getBoundingClientRect();
    const anchorPx = {
      x: wrapRect === undefined ? event.clientX : event.clientX - wrapRect.left,
      y: wrapRect === undefined ? event.clientY : event.clientY - wrapRect.top
    };
    setContextMenuState({
      anchorPx,
      selectedIdsAtOpen: nextSelection
    });
  }

  function onPointerCancel(event: React.PointerEvent<HTMLDivElement>): void {
    // OS-level pointer cancellation (window blur during a drag,
    // Mission Control, three-finger swipe, etc.) — drop any armed
    // multi-drag state so the next pointerdown doesn't see stale
    // snapshots. The pointerup path also does this in its `try/finally`
    // shape, but pointerup never fires if the OS cancels first, so
    // this handler is the second leg of the cleanup pair. Releasing
    // capture is a no-op if it was already released by the cancel
    // itself; wrap in try/catch defensively.
    const multiDrag = multiDragStartRef.current;
    if (multiDrag !== null) {
      multiDragStartRef.current = null;
      try {
        (event.target as HTMLElement).releasePointerCapture(multiDrag.pointerId);
      } catch {
        // Best-effort release; capture may already be gone.
      }
      // Clear any in-flight live preview so layers snap back to their
      // persisted positions (the cancel means "no commit", so the
      // override should evaporate immediately). Cleared only when WE
      // armed the override via multi-drag — leaving a single-select
      // drag's override alone (TransformHandles owns that lifecycle
      // and may still be mid-drag through its own capture).
      setDraftGeometry(null);
    }
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>): Promise<void> {
    // Multi-select drag commit runs BEFORE the draft branch. If
    // `multiDragStartRef` is set the user dragged a group; compute
    // the cursor delta in normalized coords and call into the
    // EditorLoaded-populated `commitMultiDragRef` to translate every
    // selected layer by that delta in one coalesced undo entry.
    const multiDrag = multiDragStartRef.current;
    if (multiDrag !== null) {
      multiDragStartRef.current = null;
      try {
        (event.target as HTMLElement).releasePointerCapture(multiDrag.pointerId);
      } catch {
        // Capture may have already been lost (window blur, etc.) —
        // best-effort release.
      }
      // Unclamped so a release OUTSIDE the canvas (the natural end of a
      // drag-off-the-viewport gesture) still computes a delta and
      // commits. With the clamped variant this returned null → the
      // commit was skipped AND the override was left in place, stranding
      // a ghost copy off-canvas that never clipped and masked undo.
      const endPt = clientToNormalizedUnclamped(event.clientX, event.clientY);
      if (endPt === null) {
        // Canvas unmounted mid-drag — nothing to commit; drop the
        // preview so we never strand a stale override.
        setDraftGeometry(null);
        return;
      }
      const dxn = endPt.xn - multiDrag.startXn;
      const dyn = endPt.yn - multiDrag.startYn;
      // No-drag threshold: a click without movement on a selected
      // group should NOT commit a no-op translation onto every layer
      // (which would push a noisy "moved by 0" undo entry and bump every
      // row id via the supersede chain for nothing). Matches
      // TransformHandles' MIN_DRAG_LENGTH-ish budget but in normalized
      // coords so the threshold scales with canvas size. 0.002 ≈ 2px on
      // a 1000px short-side canvas — tight enough that a deliberate drag
      // always trips it.
      const MIN_MULTI_DRAG_N = 0.002;
      if (Math.hypot(dxn, dyn) >= MIN_MULTI_DRAG_N) {
        const commit = commitMultiDragRef.current;
        if (commit !== null) {
          // Above threshold: commit, then LEAVE draftGeometry in place —
          // the cleanup effect drops it once the persisted geometry
          // catches up to the override (the broadcast refetch lands).
          // Note v2 `updateGeometry` PRESERVES the layer id, so the
          // cleanup keys on geometry match, NOT on the id disappearing —
          // see pruneLandedDraftGeometry. Zero-flash pointerup →
          // persisted state, same discipline as single-select drag's
          // onHandleGeometryChange.
          await commit(multiDrag.snapshots, dxn, dyn);
        } else {
          setDraftGeometry(null);
        }
      } else {
        // Under threshold — no commit. The user may have moved PAST the
        // threshold during the drag (setting the override) and then back
        // UNDER it before releasing; clear the override so the layers
        // snap to their persisted positions.
        setDraftGeometry(null);
      }
      return;
    }
    if (draft === null) return;
    if (draft.kind === "text") return;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);

    // Grab the coalescing bracket token. We close it AFTER persistOverlay
    // resolves so the recordCreate fires inside the bracket — that way
    // Phase 4+ drag-existing-overlay flows that emit multiple intermediate
    // writes will coalesce correctly. endInteraction tolerates mismatched
    // / null tokens silently.
    const interactionToken = activeInteractionTokenRef.current;
    activeInteractionTokenRef.current = null;
    const closeInteraction = (): void => {
      if (interactionToken !== null && endInteractionRef.current !== null) {
        endInteractionRef.current(interactionToken);
      }
    };

    if (draft.kind === "arrow") {
      const dx = draft.toXn - draft.fromXn;
      const dy = draft.toYn - draft.fromYn;
      if (Math.hypot(dx, dy) < MIN_DRAG_LENGTH) {
        setDraft(null);
        closeInteraction();
        return;
      }
      // Phase 3.1 fix #2/#4 + Phase 3.2 lift: thread the active arrow
      // style (color + endStyle + stemStyle + doubleEnded) into the
      // overlay shape so the popover's choices actually stick. The
      // pre-3.2 guard `!isControlled` skipped style reads in Library
      // Focus because there was no shared hook to read from; the 3.2
      // lift gives us one (toolStateProp), so we can now read
      // activeStyle in BOTH paths. `effectiveToolState` is the lifted
      // hook in Library Focus and our own hook in standalone — both
      // reflect the popover picks live.
      const arrowStyleSrc =
        effectiveToolState.activeStyle.tool === "arrow"
          ? effectiveToolState.activeStyle.style
          : null;
      const arrowOverlay: Extract<Overlay, { kind: "arrow" }> = {
        kind: "arrow",
        from: { x: draft.fromXn, y: draft.fromYn },
        to: { x: draft.toXn, y: draft.toYn },
        color:
          arrowStyleSrc !== null
            ? resolveToolColor(arrowStyleSrc.color)
            : "auto",
        // Pin the style version at commit time so future tweaks to
        // head proportions / stroke clamps don't retroactively rewrite
        // this row. See `ARROW_STYLE_VERSIONS` in
        // `packages/shared/src/arrow.ts` for the recipe per version.
        styleVersion: CURRENT_ARROW_STYLE_VERSION
      };
      if (arrowStyleSrc !== null) {
        arrowOverlay.endStyle = arrowStyleSrc.endStyle;
        arrowOverlay.stemStyle = arrowStyleSrc.stemStyle;
        arrowOverlay.doubleEnded = arrowStyleSrc.doubleEnded;
        arrowOverlay.thickness = arrowStyleSrc.thickness;
      }
      // Capture the arrow tail in canvas-px so the matching-text
      // affordance can position itself; this lookup needs the live
      // canvas rect, so do it BEFORE the await.
      const tailCanvasPx = normalizedToCanvasPx(draft.toXn, draft.toYn);
      setDraft(null);
      const wrote = await persistOverlay(arrowOverlay);
      closeInteraction();
      if (wrote.ok && !isControlled) {
        // Standalone Editor: the canvas-side affordance reads
        // anchorPoint in canvas-px from this same hook instance, so
        // post directly.
        effectiveToolState.onAnnotationPlaced(
          tailCanvasPx !== null
            ? { tool: "arrow", anchorPoint: tailCanvasPx }
            : { tool: "arrow" }
        );
      }
      // Library Focus path uses the EditToolbar's broadcast-driven
      // diff to call onAnnotationPlaced (see EditToolbar.tsx,
      // describePlacement). We intentionally don't double-fire here.
      return;
    }

    if (draft.kind === "shape-drag") {
      // Compute canvas aspect from the live canvas element's bounding
      // rect so rectFromDrag's 1:1 lock (square / circle) produces a
      // pixel-square box rather than a canvas-aspect-shaped one. The
      // canvas DOM size mirrors the source image's aspect (the editor
      // uses CSS aspect-ratio), so this matches the bake's notion of
      // a "square" without needing the image-dims state in scope.
      // Falls back to 1 when the canvas hasn't measured yet.
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const canvasAspect =
        canvasRect !== undefined && canvasRect.height > 0
          ? canvasRect.width / canvasRect.height
          : 1;
      const rect = rectFromDrag(draft, canvasAspect);
      if (rect === null) {
        setDraft(null);
        closeInteraction();
        return;
      }
      const placedKind = draft.tool;
      // Phase 3.1 fix #2: thread the active style into shape / highlight
      // / blur overlays. Pre-fix, shape + highlight dropped everything
      // to defaults regardless of popover choices.
      let overlay: Overlay;
      if (placedKind === "shape") {
        const shapeStyleSrc =
          effectiveToolState.activeStyle.tool === "shape"
            ? effectiveToolState.activeStyle.style
            : null;
        const shapeOverlay: Extract<Overlay, { kind: "shape" }> = {
          kind: "shape",
          rect,
          color:
            shapeStyleSrc !== null
              ? resolveToolColor(shapeStyleSrc.color)
              : "auto"
        };
        if (shapeStyleSrc !== null) {
          shapeOverlay.thickness = shapeStyleSrc.thickness;
          shapeOverlay.filled = shapeStyleSrc.filled;
          shapeOverlay.shape = shapeStyleSrc.shape;
          // Persist skewDeg only for parallelogram so we don't carry
          // dead state on every other shape's row.
          if (shapeStyleSrc.shape === "parallelogram") {
            shapeOverlay.skewDeg = shapeStyleSrc.skewDeg;
          }
        }
        overlay = shapeOverlay;
      } else if (placedKind === "highlight") {
        const hlStyleSrc =
          effectiveToolState.activeStyle.tool === "highlight"
            ? effectiveToolState.activeStyle.style
            : null;
        const hlOverlay: Extract<Overlay, { kind: "highlight" }> = {
          kind: "highlight",
          rect
        };
        if (hlStyleSrc !== null) {
          const resolved = resolveToolColor(hlStyleSrc.color);
          hlOverlay.color = resolved;
          hlOverlay.opacity = hlStyleSrc.opacity;
          hlOverlay.blend = hlStyleSrc.blend;
        }
        overlay = hlOverlay;
      } else {
        // blur — thread both mode and optional custom radius through
        // the committed overlay so the v2 EffectLayer doesn't silently
        // fall back to auto radius.
        overlay = {
          kind: "blur",
          rect,
          style: blurStyle,
          ...(blurRadiusPx !== undefined ? { radiusPx: blurRadiusPx } : {})
        };
      }
      setDraft(null);
      const wrote = await persistOverlay(overlay);
      closeInteraction();
      if (wrote.ok && !isControlled) {
        effectiveToolState.onAnnotationPlaced({ tool: placedKind });
      }
      return;
    }
    // Fallthrough: close interaction even if no draft branch matched.
    closeInteraction();
  }

  /**
   * Returns true if the overlay was written successfully.
   *
   * Routes through `model.dispatchEdit`. `overlayToBundleLayerNode`
   * projects the renderer's drawn Overlay shape into a BundleLayerNode,
   * then dispatchEdit's `{ kind: "upsert", node }` op writes it via
   * `layers:upsert`. Undo records through the same dispatcher so the
   * inverse (`layers:delete` / `layers:upsert`) lands consistently.
   */
  async function persistOverlay(
    overlay: Overlay,
    /** Optional coalescing tags forwarded to `recordCreate` via the
     *  auto-bridge. Multi-create bursts (paste, duplicate, future
     *  multi-* flows) pass `{ opKind, layerId, mergeMode: "append" }`
     *  so push() accumulates every newly-inserted row into a single
     *  undo entry's items[] array. Single-shot callers (drawing-tool
     *  pointerup, text commit) omit it and keep their existing
     *  standalone-entry behavior. */
    recordOpts?: RecordOptions
  ): Promise<{ ok: true; newId: string } | { ok: false }> {
    // Snapshot the model at call time. The model branch is the only
    // thing we read; subsequent state changes (e.g. a captures:changed
    // broadcast) re-render but don't race this in-flight write — the
    // result is recorded on the same model.
    if (model.kind !== "loaded") {
      // No record yet — drop the write. Shouldn't happen since the
      // editor wraps EditorLoaded inside a model.kind === "loaded"
      // guard, but be defensive.
      return { ok: false };
    }
    // Adapt the Overlay → BundleLayerNode + route through dispatchEdit.
    // The adapter refuses crop here — crop takes the dispatchEdit
    // `{ kind: "crop" }` path via onCropCommit, not persistOverlay.
    const adapted = overlayToBundleLayerNode(
      overlay,
      { width: model.record.width_px, height: model.record.height_px },
      findRootGroupId(model.layers)
    );
    if (!adapted.ok) {
      // eslint-disable-next-line no-console
      console.error("overlayToBundleLayerNode failed", adapted.error);
      return { ok: false };
    }
    const result = await model.dispatchEdit({
      kind: "upsert",
      node: adapted.layer,
      // Fresh-draw commit — land at the top of the stack. Without
      // this, the layers-repo (preserve `node.z_index` verbatim when
      // bumpZIndexToMax isn't passed) would freeze every new draw at
      // z_index = 0, colliding with existing layers. See
      // LayerEditOp.upsert doc-block for the contract.
      bumpZIndexToMax: true
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("layers:upsert via dispatchEdit failed", result.error);
      return { ok: false };
    }
    let newId = "";
    if (result.value.kind === "upsert") {
      const artifact = result.value.artifact;
      newId = artifact.node.id;
      if (!undoApplyingRef.current) {
        // Pass the inserted layer node so undo→redo can re-insert
        // the structurally-identical layer via layers:upsert. The
        // synthetic OverlayRow gives the recorder a working .id for
        // the delete-side of undo (matches the layer's id since the
        // v2-to-row projection in projectV2LayersToOverlayRows uses
        // layer.id as row.id).
        const syntheticRow: OverlayRow = {
          id: artifact.node.id,
          capture_id: captureId,
          data: overlay,
          schema_version: 1,
          source: artifact.node.source,
          ai_run_id: artifact.node.ai_run_id,
          z_index: artifact.node.z_index,
          rejected_at: artifact.node.rejected_at,
          applied_at: artifact.node.applied_at,
          superseded_by: artifact.node.superseded_by,
          created_at: artifact.node.created_at
        };
        recordCreateRef.current?.(syntheticRow, {
          node: artifact.node,
          ...(recordOpts ?? {})
        });
      }
    }
    return { ok: true, newId };
  }

  async function commitText(): Promise<void> {
    if (draft?.kind !== "text") return;
    const body = draft.body.trim();
    if (body.length === 0) {
      setDraft(null);
      return;
    }
    // Defensive: commitText only fires from a focused canvas under a
    // loaded model. Re-check so the TS narrowing below holds without
    // a non-null assertion.
    if (model.kind !== "loaded") return;
    // Phase 3.1 fix #2 + Phase 3.2 lift: thread the active text style
    // (color + fontSize mapped to v1's two-bucket size enum). Reads
    // from effectiveToolState so Library Focus picks up the lifted
    // hook's live style; standalone uses its own hook the same way.
    const textStyleSrc =
      effectiveToolState.activeStyle.tool === "text"
        ? effectiveToolState.activeStyle.style
        : null;
    const resolvedSize =
      textStyleSrc !== null ? resolveTextSize(textStyleSrc.fontSize) : "medium";
    // pwrdrvr/PwrSnap#110: every new text overlay persists an
    // absolute `sizePx` resolved at PLACEMENT time using the current
    // source raster's shortSide. From this point on the row's
    // physical size stays constant across crops — the popover's
    // "Custom" indicator surfaces if a later crop changes the
    // canvas's bucket math so the original "medium" no longer
    // matches the current canvas's medium-bucket value.
    //
    // Source dims come from the raster layer's natural_*_px; fall back
    // to record dims (= canvas dims) if no raster layer is found.
    let placementSourceW = model.record.width_px;
    let placementSourceH = model.record.height_px;
    for (const layer of model.layers) {
      if (layer.kind === "raster" && layer.parent_id !== null) {
        placementSourceW = layer.natural_width_px;
        placementSourceH = layer.natural_height_px;
        break;
      }
    }
    const sizePxAtPlacement = computeTextGlyphSize({
      size: resolvedSize,
      sourceWidthPx: placementSourceW,
      sourceHeightPx: placementSourceH,
      canvasWidthPx: model.record.width_px,
      canvasHeightPx: model.record.height_px
    }).sizePx;
    const overlay: Overlay = {
      kind: "text",
      point: { x: draft.xn, y: draft.yn },
      body,
      size: resolvedSize,
      sizePx: sizePxAtPlacement,
      // Persist the user's regular/bold pick into the row. Pre-fix this
      // wasn't written at all — the schema didn't even carry weight —
      // so every committed glyph rendered at the hardcoded 600. Now
      // the popover's "weight" field actually changes what gets baked.
      ...(textStyleSrc !== null ? { weight: textStyleSrc.weight } : {}),
      color:
        textStyleSrc !== null ? resolveToolColor(textStyleSrc.color) : "auto"
    };
    const editingId = draft.editingId;
    setDraft(null);
    if (editingId !== undefined) {
      // Re-edit path: the user double-clicked an existing text
      // overlay, edited the body, hit Enter. Write back to the
      // SAME overlay id via the format-aware updateOverlay op —
      // preserves the overlay's position, size, color, and weight
      // (those came from the popover when it was first placed) and
      // only updates the typed body. dispatchEdit routes through
      // both v1 (overlays:update) and v2 (layers:updateOverlay).
      //
      // Capture the PRE-EDIT body BEFORE dispatching so undo can revert
      // it — the persisted row still holds the old body here (entering
      // edit mode left the overlay untouched behind the draft input).
      const previousRow = overlaysRef.current.find((o) => o.id === editingId);
      const previousBody =
        previousRow !== undefined && previousRow.data.kind === "text"
          ? previousRow.data.body
          : undefined;
      const result = await dispatchEditErased({
        kind: "updateOverlay",
        layerId: editingId,
        patch: { kind: "text", body }
      });
      // Record the body change on the undo stack so ⌘Z reverts the edit
      // ("Hi Mommy" → "Hi Mom") rather than falling through to the
      // previous create entry. Mirrors the style-popover path
      // (onSelectedStyleFieldChange). Pre-fix this dispatch recorded
      // NOTHING — the edit was invisible to undo. With updateOverlay now
      // preserving the layer id, the earlier `create` entry for this
      // text stays valid too, so undoing all the way still deletes the
      // text last (the user's expected order). Skip the no-op case where
      // the body didn't actually change.
      if (
        result.ok &&
        result.value.kind === "update" &&
        previousBody !== undefined &&
        previousBody !== body &&
        !undoApplyingRef.current
      ) {
        recordStyleRef.current?.({
          currentIdRef: { current: result.value.artifact.node.id },
          previousPatch: { kind: "text", body: previousBody },
          nextPatch: { kind: "text", body }
        });
      }
      return;
    }
    const wrote = await persistOverlay(overlay);
    if (wrote.ok && !isControlled) {
      effectiveToolState.onAnnotationPlaced({ tool: "text" });
    }
  }

  /** Phase 3.6 — double-click an existing text overlay to re-open
   *  the draft input with the body pre-filled. The handler:
   *    • flips the active tool to "text" so commit + Escape behave
   *      consistently (the canvas's pointer handler also expects
   *      `tool === "text"` for keyboard-Escape to clear the draft)
   *    • clears any current selection so the user doesn't see both
   *      the dashed outline AND the new in-place input
   *    • seeds the draft with the existing overlay's position, body,
   *      and `editingId` so commitText knows to write BACK to this
   *      row rather than create a new one
   *  The existing overlay stays rendered behind the draft input —
   *  that's fine because the input is the SAME font / color / weight
   *  / position via the resolved tool style + textBoundsBox math.
   *  The user just sees their cursor land on the text and the
   *  caret blink there. */
  const onRequestEditOverlay = useCallback(
    (overlay: OverlayRow): void => {
      if (overlay.data.kind !== "text") return;
      clearSelection();
      effectiveToolState.setActiveTool("text");
      setDraft({
        kind: "text",
        xn: overlay.data.point.x,
        yn: overlay.data.point.y,
        body: overlay.data.body,
        editingId: overlay.id
      });
      // TextDraftInput's mount effect handles focus + caret-at-end
      // for the contentEditable div (the equivalent of the old
      // textarea's `setSelectionRange(value.length, value.length)`).
      // Nothing to do here — the draft state change triggers the
      // mount, which seeds the body + positions the caret.
    },
    [effectiveToolState]
  );

  // -------------------- Paste/drop image as raster layer ----------
  //
  // Finder drop and OS-image paste failures surface a transient
  // notice. Cmd+V is owned by the copy/paste handler below so layer
  // fragments, in-memory layers, and standard images are mutually
  // exclusive for a single keypress.
  const [pasteNotice, setPasteNotice] =
    useState<{ text: string; tone: "error" | "info" } | null>(null);
  useEffect(() => {
    if (pasteNotice === null) return;
    const timer = setTimeout(() => setPasteNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [pasteNotice]);

  const formatPasteError = useCallback((error: { code: string; message: string }): string => {
    switch (error.code) {
      case "v1_capture_use_v2":
        return "Only v2 captures support multi-image";
      case "no_image":
        return "Clipboard doesn't contain an image";
      case "image_too_large":
        return "Image too large to paste (max 32 MiB)";
      case "image_invalid_dimensions":
        return "Image dimensions invalid or exceed cap";
      case "image_decode_failed":
        return "Image failed to decode";
      case "image_read_failed":
        return "Image bytes unreadable";
      case "unsafe_symlink":
      case "unsafe_not_regular_file":
      case "unsafe_privileged_path":
      case "unsafe_stat_failed":
        return "Invalid file";
      case "drop_not_image":
        return "Only image files supported";
      case "drop_path_unavailable":
        return "Dropped file path unavailable";
      default:
        return error.message;
    }
  }, []);

  /** Copy / paste / duplicate helpers. All three operate on the
   *  current `selectedLayerIds` snapshot at call time.
   *
   *  • copySelected — snapshot each selected overlay's `data` into
   *    `clipboardRef`. Cheap; no IPC. Replaces any previous clipboard
   *    contents (consistent with OS clipboard semantics).
   *
   *  • pasteFromClipboard — one Cmd+V owner. It tries a private
   *    PwrSnap layer fragment first, then the in-memory same-editor
   *    layer clipboard, then a standard OS image as a raster layer.
   *
   *  • duplicateSelected — equivalent to "copy + paste without
   *    touching the clipboard." Useful when the user wants a quick
   *    duplicate but already has something on the clipboard they
   *    don't want to lose.
   *
   *  Limitations (deferred):
   *  - Repeated Cmd+V always paste at the same offset from the
   *    original, so back-to-back pastes overlap. A future pass can
   *    bump a per-clipboard counter so each paste lands at a fresh
   *    offset (Cleanshot-style).
   *  - Each paste produces one undo entry per pasted layer. Wrap in
   *    a coalescing bracket for "undo restores all pastes" in a
   *    future polish pass. */
  function copySelected(): void {
    if (selectedLayerIds.length === 0) return;
    const snapshot = overlaysRef.current;
    const items: Overlay[] = [];
    for (const id of selectedLayerIds) {
      const row = snapshot.find((o) => o.id === id);
      if (row !== undefined) items.push(row.data);
    }
    clipboardRef.current = items;
    // Also push to the OS clipboard for cross-capture / cross-instance
    // paste. The in-memory clipboard is the load-bearing path for
    // same-capture paste, so we don't block Cmd+C on the OS write — but
    // we DO surface a failure: a silently-failed fragment copy means a
    // later cross-capture paste finds nothing and (confusingly) reports
    // "clipboard doesn't contain an image".
    if (model.kind === "loaded") {
      void (async (): Promise<void> => {
        try {
          const result = await dispatch("clipboard:copyLayerFragment", {
            captureId,
            layerIds: selectedLayerIds.slice()
          });
          if (!result.ok) {
            setPasteNotice({
              text: `Couldn't copy layers: ${result.error.message}`,
              tone: "error"
            });
            return;
          }
          // Positive confirmation — also a diagnostic: if Cmd+C shows
          // NOTHING, copySelected never ran; if it shows this, the copy
          // landed a fragment and a later cross-capture paste should find
          // it.
          const n = result.value.layerCount;
          setPasteNotice({
            text: `Copied ${n} layer${n === 1 ? "" : "s"} to the clipboard`,
            tone: "info"
          });
        } catch (cause) {
          setPasteNotice({
            text: `Couldn't copy layers: ${cause instanceof Error ? cause.message : String(cause)}`,
            tone: "error"
          });
        }
      })();
    } else {
      // Selection copy was requested but the model isn't loaded — surface
      // it rather than silently no-op'ing the OS fragment write (the
      // in-memory copy above still happened for same-capture paste).
      setPasteNotice({
        text: "Couldn't copy layers: editor model not loaded",
        tone: "error"
      });
    }
  }

  /** Paste-with-offset helper used by both Cmd+V and Cmd+D. The offset
   *  is fixed (20 source-pixels in each axis). Returns once every
   *  dispatch has settled. */
  async function pasteOverlaysWithOffset(items: readonly Overlay[]): Promise<void> {
    if (items.length === 0) return;
    if (model.kind !== "loaded") return;
    const w = model.record.width_px;
    const h = model.record.height_px;
    if (w <= 0 || h <= 0) return;
    const OFFSET_PX = 20;
    const dxn = OFFSET_PX / w;
    const dyn = OFFSET_PX / h;
    // Open a coalescing bracket so every persistOverlay's auto-
    // recordCreate lands in ONE undo entry — pressing Undo once
    // removes the whole batch of pasted layers as a group. Without
    // the bracket (and the matching `{ opKind, layerId, mergeMode }`
    // tags below) the user'd have to mash Undo N times to clean up
    // a paste of N layers. The bracket key + mergeMode pair MUST
    // agree with the recordOpts threaded through persistOverlay
    // below — push()'s `insideInteraction` check needs both halves
    // of the key matched, and the items[] accumulator needs
    // `mergeMode: "append"` so earlier pasted rows aren't dropped.
    const begin = beginInteractionRef.current;
    const end = endInteractionRef.current;
    const token = begin !== null ? begin("create", "kbd-paste") : null;
    try {
      const newIds: string[] = [];
      for (const item of items) {
        const translated = translateOverlayData(item, dxn, dyn);
        const wrote = await persistOverlay(translated, {
          opKind: "create",
          layerId: "kbd-paste",
          mergeMode: "append"
        });
        if (wrote.ok && wrote.newId !== "") newIds.push(wrote.newId);
      }
      if (newIds.length > 0) setSelectionTrustingDispatch(newIds);
    } finally {
      if (token !== null && end !== null) end(token);
    }
  }

  function pasteFromClipboard(): void {
    // Priority: OS clipboard fragment > in-memory clipboard.
    //
    // OS fragment is what enables cross-capture / cross-instance
    // paste — it survives capture switches (which unmount the
    // Editor + lose the in-memory ref) and other PwrSnap windows
    // / processes. The IPC handler auto-detects between the
    // private UTI (fragment) and PNG-fallback (creates a raster
    // layer); both count as a successful OS paste.
    //
    // In-memory wins as a fallback when the OS clipboard is empty
    // (most common when the user just copied within the same capture
    // and hasn't touched the OS clipboard — in-memory has the data,
    // no IPC needed).
    //
    // The OS call is async; when there is no private PwrSnap fragment,
    // it returns `insertedLayerIds: []` which signals "fall through".
    // Fallthrough order is deliberate: in-memory layer copies beat a
    // generic image on the clipboard, and generic image paste is last.
    if (model.kind === "loaded") {
      void (async (): Promise<void> => {
        const result = await dispatch("clipboard:pasteLayerFragment", {
          captureId,
          parentId: null
        });
        if (result.ok && result.value.insertedLayerIds.length > 0) {
          // OS clipboard had a PwrSnap fragment. Select what landed
          // so the user can immediately nudge / re-style / delete it.
          setSelectionTrustingDispatch(result.value.insertedLayerIds);
          return;
        }
        if (!result.ok) {
          // A PwrSnap fragment WAS on the clipboard but failed to paste
          // (schema mismatch, source-integrity, insert error). Surface
          // the real reason instead of masking it with the generic
          // "doesn't contain an image" image-paste fallback below — that
          // fallback is only correct when there's genuinely no fragment
          // (handler returns ok + insertedLayerIds: []).
          setPasteNotice({
            text: `Couldn't paste layers: ${result.error.message}`,
            tone: "error"
          });
          return;
        }
        if (clipboardRef.current.length > 0) {
          // OS clipboard had no PwrSnap fragment — fall back to the
          // in-memory clipboard so same-capture copy → paste still
          // works if another app touched the OS clipboard.
          void pasteOverlaysWithOffset(clipboardRef.current);
          return;
        }
        // Last resort: paste a standard OS clipboard image as a raster
        // layer. This is intentionally owned by the same Cmd+V flow so
        // a single keystroke cannot insert both a PwrSnap fragment and
        // a rasterized clipboard image.
        const canvas = canvasRef.current;
        let position: PasteImagePosition | undefined;
        if (canvas !== null) {
          const rect = canvas.getBoundingClientRect();
          position = {
            xn: 0.5,
            yn: 0.5,
            canvasPx: { x: rect.width / 2, y: rect.height / 2 }
          };
        }
        const req: {
          captureId: string;
          positionXn?: number;
          positionYn?: number;
        } = { captureId };
        if (position !== undefined) {
          req.positionXn = position.xn;
          req.positionYn = position.yn;
        }
        const imagePasteResult = await dispatch("editor:pasteImageAsLayer", req);
        if (imagePasteResult.ok) {
          setSelectionTrustingDispatch([imagePasteResult.value.layerId]);
        } else {
          setPasteNotice({
            text: formatPasteError(imagePasteResult.error),
            tone: "error"
          });
        }
      })();
      return;
    }
    // Model not loaded — in-memory only.
    void pasteOverlaysWithOffset(clipboardRef.current);
  }

  function duplicateSelected(): void {
    if (selectedLayerIds.length === 0) return;
    const snapshot = overlaysRef.current;
    const items: Overlay[] = [];
    for (const id of selectedLayerIds) {
      const row = snapshot.find((o) => o.id === id);
      if (row !== undefined) items.push(row.data);
    }
    void pasteOverlaysWithOffset(items);
  }

  /** Delete every selected layer as ONE coalesced undo entry.
   *  Extracted from the Delete/Backspace keyboard handler so the
   *  context menu's "Delete" item can dispatch the SAME path
   *  without duplicating the bracket + items[] coalescing
   *  discipline. Two load-bearing details: (1) AWAIT each
   *  deleteSelectedRef before closing the bracket — the deleter
   *  is async and the bracket close MUST happen after every
   *  recordDelete lands; (2) tag each delete with the SAME
   *  `{ opKind, layerId, mergeMode: "append" }` so push()'s
   *  insideInteraction check fires AND the items[] accumulator
   *  retains every deleted row (without "append" the merge would
   *  replace and only the last delete would be restored on undo —
   *  the user reported this bug class twice during PR #125). */
  function deleteSelected(): void {
    if (selectedLayerIds.length === 0) return;
    const overlaysSnapshot = overlaysRef.current;
    const rasterIdSet = new Set(rastersRef.current.map((r) => r.id));
    const rows: OverlayRow[] = [];
    const rasterIds: string[] = [];
    for (const id of selectedLayerIds) {
      const row = overlaysSnapshot.find((o) => o.id === id);
      if (row !== undefined) rows.push(row);
      else if (rasterIdSet.has(id)) rasterIds.push(id);
    }
    clearSelection();
    const begin = beginInteractionRef.current;
    const end = endInteractionRef.current;
    const token = begin !== null ? begin("delete", "kbd-multi-delete") : null;
    void (async (): Promise<void> => {
      try {
        for (const row of rows) {
          const deleter = deleteSelectedRef.current;
          if (deleter !== null) {
            await deleter(row, {
              opKind: "delete",
              layerId: "kbd-multi-delete",
              mergeMode: "append"
            });
          }
        }
        // Non-source rasters aren't OverlayRows, so delete them by id via
        // the model dispatcher (same path as the Layers panel's Delete;
        // rasters don't project to a row, so no undo entry — an accepted
        // v1 edge, matching api.deleteLayer).
        for (const id of rasterIds) {
          if (model.kind === "loaded") {
            // eslint-disable-next-line no-await-in-loop
            await model.dispatchEdit({ kind: "delete", id });
          }
        }
      } finally {
        if (token !== null && end !== null) end(token);
      }
    })();
  }

  /** Route a context-menu item click to the appropriate dispatcher.
   *  Mirrors the keyboard surface — every menu item shares an
   *  underlying handler with its keyboard binding. Edit Text is
   *  the one item without a keyboard binding (the existing
   *  click-on-selected-text-body gesture covers that); for the
   *  menu we route through `onRequestEditOverlay` directly with
   *  the single-selected overlay. */
  function dispatchContextMenuItem(id: LayerContextMenuItemId): void {
    if (id === "edit-text") {
      const row = overlaysRef.current.find(
        (o) => o.id === (selectedLayerIds[0] ?? "")
      );
      if (row !== undefined) onRequestEditOverlay(row);
      return;
    }
    if (id === "cut") {
      copySelected();
      deleteSelected();
      return;
    }
    if (id === "copy") {
      copySelected();
      return;
    }
    if (id === "paste") {
      pasteFromClipboard();
      return;
    }
    if (id === "duplicate") {
      duplicateSelected();
      return;
    }
    if (id === "delete") {
      deleteSelected();
      return;
    }
    if (id === "bring-to-front") {
      reorderSelectedRef.current?.("toFront");
      return;
    }
    if (id === "bring-forward") {
      reorderSelectedRef.current?.("forward");
      return;
    }
    if (id === "send-backward") {
      reorderSelectedRef.current?.("backward");
      return;
    }
    if (id === "send-to-back") {
      reorderSelectedRef.current?.("toBack");
      return;
    }
    // Exhaustiveness — every LayerContextMenuItemId must have a
    // branch above. New menu items will surface as compile errors.
    const _exhaustive: never = id;
    void _exhaustive;
  }

  // Keyboard shortcuts: tool selection + Esc cancels drag.
  //
  // "Double-tap to configure" shortcut: pressing the active tool's
  // letter (e.g. "A" while already on Arrow) a second time opens the
  // tool's style popover. Tracked via `lastShortcutToolRef` so a
  // back-to-back shortcut counts; any tool change in between resets.
  const lastShortcutToolRef = useRef<Tool | null>(null);
  // Toolbar imperative API: exposes a function the keyboard handler
  // can call to open the popover for the active tool when the user
  // double-taps its shortcut. Populated by the toolbar render below.
  const openActivePopoverRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape" && draft !== null) {
        event.preventDefault();
        setDraft(null);
        return;
      }
      // Escape on the open right-click context menu closes the menu
      // WITHOUT clearing the selection. Per the PR #150 spec ("Escape
      // closes the menu without clearing the selection"), the menu
      // owns the Escape gesture once it's open; the selection should
      // survive so right-click-on-the-same-layer-and-redo-the-action
      // is a smooth flow.
      //
      // Why the Editor handles this here instead of relying on the
      // menu's own `document.addEventListener("keydown", …,
      // { capture: true })` listener in LayerContextMenu.tsx:
      //
      //   Event-propagation order for `capture: true` is
      //   window → document → ... → target. The Editor's listener is
      //   on WINDOW with capture; the menu's is on DOCUMENT with
      //   capture. So the Editor's listener ALWAYS fires first. By
      //   the time the menu's listener runs, the selection-clearing
      //   branch below has already executed — `stopPropagation()` in
      //   the menu's listener can't retroactively undo that.
      //
      //   We could move the menu's listener to window-capture too,
      //   but listeners on the same target fire in REGISTRATION
      //   order. Editor mounts first, registers first; the menu
      //   would still be second.
      //
      //   Cleanest fix: the Editor checks `contextMenuState !== null`
      //   before its own Escape branches, closes the menu directly,
      //   and stops propagation. Stopping at window-capture means the
      //   event never reaches the menu's document-capture listener —
      //   so on this path the Editor solely owns the close. (The menu
      //   still closes itself via click-outside and the close-on-
      //   selection-change effect for non-Escape dismissals.)
      if (event.key === "Escape" && contextMenuState !== null) {
        event.preventDefault();
        event.stopPropagation();
        setContextMenuState(null);
        return;
      }
      // Don't interpret as a tool shortcut when text input has focus.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable === true) return;
      // Multi-select keyboard ops. Escape clears the selection (when
      // not mid-draft — that case was handled above). Delete / Backspace
      // soft-deletes every selected overlay. We route through the
      // overlays:delete IPC for v1; v2 layers use layers:delete.
      // Branching on bundle_format_version lives in the deletion
      // helper below (set up in EditorLoaded which has the record).
      if (event.key === "Escape" && selectedLayerIds.length > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedLayerIds.length > 0
      ) {
        event.preventDefault();
        deleteSelected();
        return;
      }
      // ⌘A / ⌃A — select every overlay on the current capture.
      if (
        (event.key === "a" || event.key === "A") &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        // Select the WHOLE image for "select all → copy": annotation
        // overlays + every raster (the base Source AND non-source pasted
        // images / cursor). Exclude the Crop and legacy Step overlays —
        // they aren't click-selectable (hitTestOverlays skips them) and a
        // crop is a no-op canvas-level viewport that can't transfer to
        // another capture; selecting it would also paint a phantom outline.
        setSelectedLayerIds([
          ...overlaysRef.current
            .filter((o) => o.data.kind !== "crop" && o.data.kind !== "step")
            .map((o) => o.id),
          ...rastersRef.current.map((r) => r.id),
          ...(sourceRasterIdRef.current !== null ? [sourceRasterIdRef.current] : [])
        ]);
        return;
      }
      // ⌘C / ⌃C — copy selected layers into the in-memory clipboard.
      // Skipped when nothing's selected so the system Cmd+C (browser
      // "Copy" of any selected text on the page) still wins.
      if (
        (event.key === "c" || event.key === "C") &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        selectedLayerIds.length > 0
      ) {
        event.preventDefault();
        copySelected();
        return;
      }
      // ⌘V / ⌃V — paste. Prefers OS clipboard fragment / image on v2
      // captures (handles cross-capture + cross-instance), falls back
      // to the in-memory clipboard otherwise. We can't easily query
      // OS clipboard contents synchronously here, so we always
      // preventDefault on Cmd+V from the editor canvas (the inner
      // text-draft input is already early-returned above via the
      // INPUT/TEXTAREA guard). pasteFromClipboard internally no-ops
      // when both OS + in-memory are empty.
      if (
        (event.key === "v" || event.key === "V") &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        pasteFromClipboard();
        return;
      }
      // ⌘D / ⌃D — duplicate selected layers in place (at an offset).
      // Doesn't touch the clipboard. No-op when nothing's selected.
      if (
        (event.key === "d" || event.key === "D") &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        selectedLayerIds.length > 0
      ) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      // ⌘] / ⌘[ — bring forward / send backward (one step).
      // ⌘⇧] / ⌘⇧[ — bring to front / send to back.
      // No-op when nothing's selected so the system shortcut wins.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        selectedLayerIds.length > 0 &&
        (event.key === "]" || event.key === "[")
      ) {
        event.preventDefault();
        const isBracketClose = event.key === "]";
        const variant: "forward" | "backward" | "toFront" | "toBack" =
          event.shiftKey
            ? isBracketClose
              ? "toFront"
              : "toBack"
            : isBracketClose
              ? "forward"
              : "backward";
        reorderSelectedRef.current?.(variant);
        return;
      }
      // Arrow-key nudge of every selected overlay. Plain arrow = 1
      // source-pixel; Shift+arrow = 10. ⌘/⌃ arrow are reserved for
      // future tool shortcuts (text caret navigation in the draft
      // input is handled by the textarea itself, which we early-
      // returned out of above).
      //
      // stopImmediatePropagation + the {capture: true} registration
      // below is what prevents Library.tsx's Focus / Reel mode
      // arrow-key navigation from ALSO firing on the same event and
      // navigating to the next capture instead of nudging the
      // selected layer. Library's listener is bubble-phase + ran
      // first (registered earlier in Focus mode mount order), so
      // without these two, every nudge ALSO swaps the capture.
      // We only do this when the editor IS handling the key —
      // empty-selection arrow keys still fall through so reel
      // navigation works when nothing's selected.
      // When a row in the Layers panel has focus, IT owns arrow/page
      // keys (reorder the focused layer). Don't grab them for the
      // pixel-nudge here, and (crucially) don't stopImmediatePropagation
      // below — the capture-phase registration would otherwise eat the
      // key before the panel's bubble-phase handler ever runs.
      const layersPanelFocused =
        (document.activeElement as HTMLElement | null)?.closest?.(
          ".psl-layers"
        ) != null;
      if (
        !layersPanelFocused &&
        selectedLayerIds.length > 0 &&
        draft === null &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const stepPx = event.shiftKey ? 10 : 1;
        // The keyboard handler doesn't have direct access to canvas
        // dims (those live in EditorLoaded). Push the step through
        // the ref so the child can do the source-pixel → normalized
        // conversion in its own closure. (1 source-px = 1 / dim_px
        // in normalized space.)
        let dxnSteps = 0;
        let dynSteps = 0;
        if (event.key === "ArrowLeft") dxnSteps = -stepPx;
        if (event.key === "ArrowRight") dxnSteps = stepPx;
        if (event.key === "ArrowUp") dynSteps = -stepPx;
        if (event.key === "ArrowDown") dynSteps = stepPx;
        nudgeSelectedRef.current?.(dxnSteps, dynSteps);
        return;
      }
      // Modifier presses (⌘/⌃/⌥) belong to other handlers — don't eat
      // ⌘A or similar as the arrow shortcut. (⌘A handled above.)
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const upper = event.key.toUpperCase();
      const matched = TOOLS.find((t) => t.key === upper);
      if (matched !== undefined) {
        event.preventDefault();
        if (
          !isControlled &&
          tool === matched.id &&
          lastShortcutToolRef.current === matched.id &&
          isStyledToolKind(matched.id)
        ) {
          // Double-tap: open the popover for this styled tool.
          openActivePopoverRef.current?.();
          // Reset so a third tap doesn't repeat the open.
          lastShortcutToolRef.current = null;
          return;
        }
        lastShortcutToolRef.current = matched.id;
        setTool(matched.id);
      }
    }
    // Capture-phase registration: window-level capture-phase listeners
    // fire BEFORE bubble-phase listeners on the same target. Library's
    // arrow-key navigation handler is bubble-phase, so registering here
    // with { capture: true } guarantees the editor sees the keydown
    // first and can stopImmediatePropagation when it owns the gesture
    // (currently the arrow-key nudge branch above — the other
    // shortcuts use their own modifier patterns that don't collide).
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [contextMenuState, draft, isControlled, selectedLayerIds, setTool, tool]);

  // Hook-owned deleter (populated by EditorLoaded once it knows the
  // bundle format). Like recordCreateRef, this lives in the outer
  // function because the keyboard handler is here but the model
  // resolution + format branching lives in the child.
  //
  // Takes the full OverlayRow (not just an id) so the deleter can
  // record a proper undo entry — recordDelete needs `row.data` to
  // re-upsert on undo, plus the matching v2 layer node when
  // applicable. The outer keyboard handler grabs the row from
  // overlaysRef before calling in.
  const deleteSelectedRef = useRef<
    ((row: OverlayRow, opts?: RecordOptions) => Promise<void>) | null
  >(null);
  // Hook-owned nudger (same pattern as deleteSelectedRef). Translates
  // every selected overlay by (dxn, dyn) in normalized [0,1]² space —
  // EditorLoaded populates this with a closure that knows the canvas
  // dims + dispatchEdit. The outer keyboard handler computes (dxn,
  // dyn) from the arrow-key + Shift modifier and calls in.
  const nudgeSelectedRef =
    useRef<((dxn: number, dyn: number) => void) | null>(null);
  // Hook-owned reorderer. Same pattern as deleteSelectedRef /
  // nudgeSelectedRef — EditorLoaded populates with a closure that
  // owns the current overlay list + dispatchEdit, so the outer
  // keyboard handler can fire reorder shortcuts without knowing about
  // the v1/v2 split.
  const reorderSelectedRef =
    useRef<
      ((variant: "forward" | "backward" | "toFront" | "toBack") => void) | null
    >(null);
  // In-memory editor clipboard for copy / paste. Stores the immutable
  // `data` payload of every overlay that was selected at Cmd+C time —
  // not full OverlayRow values, since ids are regenerated on paste.
  // Outlives the current selection: after copy, the user can click
  // away, then Cmd+V to paste at the original geometry + offset.
  //
  // Scope: in-memory, this editor instance only. Cross-capture /
  // cross-editor paste goes through the private OS clipboard fragment
  // (`clipboard:copyLayerFragment` / `pasteLayerFragment`).
  const clipboardRef = useRef<readonly Overlay[]>([]);

  const overlaysForRender = useMemo<OverlayRow[] | null>(() => {
    if (model.kind !== "loaded") return null;
    return projectV2LayersToOverlayRows(model.layers, captureId, {
      widthPx: model.record.width_px,
      heightPx: model.record.height_px
    });
  }, [
    captureId,
    model.kind,
    model.kind === "loaded" ? model.layers : null,
    model.kind === "loaded" ? model.record.width_px : null,
    model.kind === "loaded" ? model.record.height_px : null
  ]);

  // Drop any ids from the selection that are no longer in the list
  // (e.g. another window deleted them via the events:overlays:changed
  // broadcast, or the capture switched). This must run after commit:
  // queuing setState from render creates an idle microtask/render loop
  // when a stale id remains selected.
  useEffect(() => {
    if (overlaysForRender === null) return;
    if (selectedLayerIds.length === 0 && inFlightSelectionIdsRef.current.size === 0) {
      return;
    }

    const alive = new Set(overlaysForRender.map((row) => row.id));
    const nextInFlight = pruneLandedInFlightSelectionIds(
      inFlightSelectionIdsRef.current,
      alive
    );
    inFlightSelectionIdsRef.current = nextInFlight;

    setSelectedLayerIds((previous) =>
      filterSelectionToAliveOrInFlight(previous, alive, nextInFlight)
    );
  }, [overlaysForRender, selectedLayerIds]);

  if (model.kind === "loading") {
    return (
      <div className="editor-loading" data-testid="editor-loading">
        Loading capture…
      </div>
    );
  }
  if (model.kind === "error") {
    return (
      <div className="editor-error" data-testid="editor-error">
        {model.message}
      </div>
    );
  }

  // Resolve OverlayRow[] for the existing renderer code path by
  // projecting the v2 layer tree back to OverlayRow shape (vector +
  // blur-effect cover the editor surface).
  if (overlaysForRender === null) {
    return (
      <div className="editor-error" data-testid="editor-error">
        Capture model was not ready.
      </div>
    );
  }
  // Sync the synchronous-read ref the outer pointerdown handler reads.
  // Render-phase write to a ref is safe (refs don't trigger renders);
  // we deliberately do this before returning EditorLoaded so a click
  // landing in the same commit reads the up-to-date overlay list.
  overlaysRef.current = overlaysForRender;
  // Sync the non-source raster layers for the same synchronous handlers.
  // Same Source-vs-annotation rule + visibility filter as the RasterLayers
  // render, so a hit-test / Cmd+A / delete only ever sees what's painted.
  const sourceRasterIdForHit = selectBaseRaster(model.layers, model.record.sha256)?.id ?? null;
  sourceRasterIdRef.current = sourceRasterIdForHit;
  rastersRef.current = model.layers.filter(
    (l): l is Extract<BundleLayerNode, { kind: "raster" }> =>
      l.kind === "raster" &&
      l.id !== sourceRasterIdForHit &&
      l.visible &&
      l.rejected_at === null
  );
  // `textHitDimsRef` is populated lower in this render — after
  // `sourceWidthPx` / `sourceHeightPx` are resolved via the raster-
  // layer scan below. See the assignment near `return <EditorLoaded
  // ... />`.

  const dispatchEditErased = model.dispatchEdit;

  // Source raster natural dims — separate from the capture's
  // `width_px`/`height_px` which are the CANVAS (cropped) dims.
  // Without this, the editor's <img> would scale the full source into
  // the cropped canvas box, hiding the crop visually (aspect-preserved
  // squash looks identical at auto-fit zoom — real user hit exactly
  // this on 8nnmKLuUpBI4K8fl).
  //
  // Scan model.layers for the root raster's natural dims. The
  // native-create path always seeds exactly one raster at
  // canvas-fits-source dims. Fall back to record dims if we can't find
  // one (shouldn't happen for a healthy capture).
  let sourceWidthPx = model.record.width_px;
  let sourceHeightPx = model.record.height_px;
  // Off-origin crops translate the raster layer's transform by
  // (-rect.x × oldW, -rect.y × oldH) so the (smaller) canvas displays
  // the user's chosen region of the source. Read those translation
  // components here so the editor's <img> can mirror the offset via
  // CSS transform. Identity (0, 0) for uncropped + edge-aligned crops.
  // See pwrdrvr/PwrSnap#110 and useCaptureModel.ts's `Step 0.5:
  // translate every raster layer's transform...` for the dispatcher
  // side of this contract.
  let rasterTranslateXPx = 0;
  let rasterTranslateYPx = 0;
  // The base image is hidden when the user toggles the Source row's eye
  // off. The bake already drops a hidden raster (the compositor skips
  // !visible onto a transparent canvas), so honoring it here makes the
  // editor WYSIWYG: the <img> is hidden behind a transparency checker so
  // you can see every annotation on an empty canvas. Was a silent no-op
  // before — the editor painted the source regardless of the flag.
  let isSourceHidden = false;
  // The editor renders exactly ONE raster as its <img>: the base SOURCE
  // the `pwrsnap-capture://` protocol serves (sha-matched). selectBaseRaster
  // resolves that layer even when the capture carries multiple rasters, so
  // the <img>'s dims / translate / source-hidden flag describe the layer
  // actually shown — not just whichever raster happens to be first.
  const baseRaster = selectBaseRaster(model.layers, model.record.sha256);
  if (baseRaster !== undefined) {
    sourceWidthPx = baseRaster.natural_width_px;
    sourceHeightPx = baseRaster.natural_height_px;
    // transform[4] = tx, transform[5] = ty, both in source-pixel units.
    rasterTranslateXPx = baseRaster.transform[4];
    rasterTranslateYPx = baseRaster.transform[5];
    isSourceHidden = baseRaster.visible === false;
  }

  // Sync-write the text-hit dims AFTER `sourceWidthPx` / `sourceHeightPx`
  // are resolved. onPointerDown (outer Editor scope) reads this ref to
  // size text overlays' bounding rectangles correctly during hit-
  // testing — without it, text overlays use a tiny point-radius hit
  // target that's near-impossible to click on multi-line bodies.
  textHitDimsRef.current = {
    canvasWidthPx: model.record.width_px,
    canvasHeightPx: model.record.height_px,
    sourceWidthPx,
    sourceHeightPx
  };

  // RAW (stored / cropped-space) values the Layers panel's `uncrop`
  // needs — it must invert the REAL cropped dims even while the editor
  // is rendering the virtual uncropped view (`model` is the full-image
  // projection when the crop is hidden). The fallbacks never fire here
  // (model is loaded ⇒ rawModel is loaded), they just satisfy types.
  const storedLayers = rawModel.kind === "loaded" ? rawModel.layers : model.layers;
  const storedCanvasWidthPx =
    rawModel.kind === "loaded" ? rawModel.record.width_px : model.record.width_px;
  const storedCanvasHeightPx =
    rawModel.kind === "loaded" ? rawModel.record.height_px : model.record.height_px;

  return (
    <EditorLoaded
      record={model.record}
      overlays={overlaysForRender}
      chrome={chrome}
      tool={tool}
      setTool={setTool}
      draft={draft}
      setDraft={setDraft}
      canvasRef={canvasRef}
      canvasWrapRef={canvasWrapRef}
      textInputRef={textInputRef}
      undoApplyingRef={undoApplyingRef}
      recordCreateRef={recordCreateRef}
      recordCropRef={recordCropRef}
      recordStyleRef={recordStyleRef}
      beginInteractionRef={beginInteractionRef}
      endInteractionRef={endInteractionRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      contextMenuState={contextMenuState}
      setContextMenuState={setContextMenuState}
      dispatchContextMenuItem={dispatchContextMenuItem}
      draftGeometry={draftGeometry}
      setDraftGeometry={setDraftGeometry}
      commitText={commitText}
      onZoomChange={onZoomChange}
      onSelectionChange={onSelectionChange}
      onLayersApi={onLayersApi}
      blurStyle={blurStyle}
      blurRadiusPx={blurRadiusPx}
      isControlled={isControlled}
      toolState={effectiveToolState}
      openActivePopoverRef={openActivePopoverRef}
      selectedLayerIds={selectedLayerIds}
      setSelectedLayerIds={setSelectedLayerIds}
      setSelectionTrustingDispatch={setSelectionTrustingDispatch}
      primarySelectedLayerId={primarySelectedLayerId}
      deleteSelectedRef={deleteSelectedRef}
      nudgeSelectedRef={nudgeSelectedRef}
      reorderSelectedRef={reorderSelectedRef}
      commitMultiDragRef={commitMultiDragRef}
      modelLayers={model.layers}
      storedLayers={storedLayers}
      storedCanvasWidthPx={storedCanvasWidthPx}
      storedCanvasHeightPx={storedCanvasHeightPx}
      isUncroppedView={isUncroppedView}
      isSourceHidden={isSourceHidden}
      sourceHasAlpha={model.record.has_alpha}
      toStoredGeometry={toStoredGeometry}
      dispatchEdit={dispatchEditErased}
      rawDispatchEdit={
        rawModel.kind === "loaded" ? rawModel.dispatchEdit : dispatchEditErased
      }
      sourceWidthPx={sourceWidthPx}
      sourceHeightPx={sourceHeightPx}
      rasterTranslateXPx={rasterTranslateXPx}
      rasterTranslateYPx={rasterTranslateYPx}
      onRequestEditOverlay={onRequestEditOverlay}
      pasteNotice={pasteNotice}
      setPasteNotice={setPasteNotice}
      formatPasteError={formatPasteError}
    />
  );
}

/** Loaded body extracted so the zoom + undo hooks can depend on
 *  the capture's intrinsic dimensions (and only mount once the
 *  record has resolved). */
function EditorLoaded({
  record,
  overlays,
  chrome,
  tool,
  setTool,
  draft,
  setDraft,
  canvasRef,
  canvasWrapRef,
  textInputRef,
  undoApplyingRef,
  recordCreateRef,
  recordCropRef,
  recordStyleRef,
  beginInteractionRef,
  endInteractionRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onContextMenu,
  contextMenuState,
  setContextMenuState,
  dispatchContextMenuItem,
  draftGeometry,
  setDraftGeometry,
  commitText,
  onZoomChange,
  onSelectionChange,
  onLayersApi,
  blurStyle,
  blurRadiusPx,
  isControlled,
  toolState,
  openActivePopoverRef,
  selectedLayerIds,
  setSelectedLayerIds,
  setSelectionTrustingDispatch,
  primarySelectedLayerId,
  deleteSelectedRef,
  nudgeSelectedRef,
  reorderSelectedRef,
  commitMultiDragRef,
  modelLayers,
  storedLayers,
  storedCanvasWidthPx,
  storedCanvasHeightPx,
  isUncroppedView,
  isSourceHidden,
  sourceHasAlpha,
  toStoredGeometry,
  dispatchEdit,
  rawDispatchEdit,
  sourceWidthPx,
  sourceHeightPx,
  rasterTranslateXPx,
  rasterTranslateYPx,
  onRequestEditOverlay,
  pasteNotice,
  setPasteNotice,
  formatPasteError
}: {
  record: CaptureRecord;
  overlays: OverlayRow[];
  chrome: EditorChromeKind;
  tool: Tool;
  /** Mirrors the outer `setTool` signature so the ⌥-click single-shot
   *  option passes through the toolbar wrapper into useEditorToolState. */
  setTool: (t: Tool, options?: { singleShot?: boolean }) => void;
  draft: Draft | null;
  setDraft: (d: Draft | null) => void;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  canvasWrapRef: React.RefObject<HTMLDivElement | null>;
  textInputRef: React.RefObject<HTMLTextAreaElement | null>;
  undoApplyingRef: React.RefObject<boolean>;
  recordCreateRef: React.RefObject<
    | ((
        row: OverlayRow,
        opts?: { node?: BundleLayerNode | null }
      ) => void)
    | null
  >;
  recordCropRef: React.RefObject<
    | ((entry: {
        rect: { x: number; y: number; w: number; h: number };
        previousWidthPx: number;
        previousHeightPx: number;
        newWidthPx: number;
        newHeightPx: number;
      }) => void)
    | null
  >;
  /** Style/body recorder — populated from the undo hook so the outer
   *  Editor's commitText can push a style op when a text body is
   *  re-edited (⌘Z reverts the body change). */
  recordStyleRef: React.RefObject<
    | ((entry: {
        currentIdRef: { current: string };
        previousPatch: Partial<Overlay>;
        nextPatch: Partial<Overlay>;
      }) => void)
    | null
  >;
  /** Coalescing bracket refs — populated from the undo hook so pointer
   *  handlers in the outer Editor function can open/close coalescing
   *  windows without depending on the hook directly. */
  beginInteractionRef: React.RefObject<
    ((opKind: string, layerId: string) => InteractionToken) | null
  >;
  endInteractionRef: React.RefObject<
    ((token: InteractionToken) => void) | null
  >;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => Promise<void>;
  /** OS-level pointer cancellation (window blur during drag,
   *  Mission Control, etc.). Outer Editor uses it to drop any armed
   *  multi-drag snapshots so the next pointerdown doesn't see stale
   *  state. EditorLoaded just forwards it to the canvas's
   *  onPointerCancel attribute. */
  onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** Right-click handler — opens the layer context menu over the
   *  canvas at the click anchor. Defined in the outer Editor so it
   *  can call into outer-scope helpers (hitTestOverlays + selection
   *  mutators); EditorLoaded just wires it onto `.editor-canvas`. */
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Layer context menu state owned by the outer Editor. Null when
   *  closed; `{ anchorPx, selectedIdsAtOpen }` when open. EditorLoaded
   *  renders `<LayerContextMenu>` based on this state and uses
   *  `setContextMenuState(null)` to close it (item-pick / dismissal). */
  contextMenuState: {
    anchorPx: { x: number; y: number };
    selectedIdsAtOpen: readonly string[];
  } | null;
  setContextMenuState: React.Dispatch<
    React.SetStateAction<{
      anchorPx: { x: number; y: number };
      selectedIdsAtOpen: readonly string[];
    } | null>
  >;
  /** Routes a context-menu item click to the appropriate dispatcher
   *  (copySelected / pasteFromClipboard / duplicateSelected /
   *  deleteSelected / reorderSelectedRef / onRequestEditOverlay).
   *  Defined in the outer Editor where those helpers live; passed
   *  down so the `<LayerContextMenu>` rendered inside EditorLoaded
   *  can route picks back. */
  dispatchContextMenuItem: (id: LayerContextMenuItemId) => void;
  /** Live-drag geometry override owned by the outer Editor (the
   *  multi-drag pointermove handler there is the primary writer; the
   *  single-select drag's onHandleGeometryDrag also writes through
   *  this setter). EditorLoaded reads `draftGeometry` to thread into
   *  OverlaySvg / BlurOverlays / TextHtmlOverlays as `liveOverride`,
   *  and uses `setDraftGeometry(null)` to clear on commit / error /
   *  drag-end. Map shape covers both single-select (1 entry) and
   *  multi-drag (N entries) through one contract. */
  draftGeometry: ReadonlyMap<string, GeometryUpdate> | null;
  setDraftGeometry: React.Dispatch<
    React.SetStateAction<ReadonlyMap<string, GeometryUpdate> | null>
  >;
  commitText: () => Promise<void>;
  onZoomChange: ((api: ZoomApi) => void) | undefined;
  onSelectionChange: ((ids: readonly string[]) => void) | undefined;
  onLayersApi: ((api: LayersPanelApi | null) => void) | undefined;
  blurStyle: BlurStyle;
  blurRadiusPx: number | undefined;
  isControlled: boolean;
  toolState: ReturnType<typeof useEditorToolState>;
  openActivePopoverRef: React.RefObject<(() => void) | null>;
  /** Multi-select model — ids of every currently-selected overlay.
   *  Empty array means nothing selected. Drives the selection outline
   *  glyphs in OverlaySvg (one per id) and the keyboard-Delete /
   *  arrow-nudge / copy-paste / z-order handlers. */
  selectedLayerIds: readonly string[];
  /** Phase 3.5 — geometry/style updates land as delete-plus-insert
   *  (id changes on every cycle). EditorLoaded reads this setter to
   *  re-anchor the selection on the new id after a successful
   *  updateGeometry / updateOverlay dispatch. Typed as a full React
   *  dispatcher (not just `(ids) => void`) so the Layers-panel API can
   *  use the functional updater form — that lets its `selectLayers`
   *  toggle read the latest selection without closing over
   *  `selectedLayerIds`, keeping the published API identity stable. */
  setSelectedLayerIds: React.Dispatch<React.SetStateAction<readonly string[]>>;
  /** Like `setSelectedLayerIds` but also registers each id with the
   *  outer in-flight set so the stale-id cleanup in the outer Editor
   *  doesn't wipe a just-set selection while the
   *  events:overlays:changed broadcast → refetch round-trip is still
   *  pending. Use this from any post-dispatch path (nudge, paste,
   *  duplicate, create — anything whose `result` carries fresh row
   *  ids). Plain `setSelectedLayerIds` is fine for selections built
   *  from ids that are already in `overlaysForRender` (e.g. Cmd+A,
   *  click-to-select). */
  setSelectionTrustingDispatch: (ids: readonly string[]) => void;
  /** Convenience derived value — the single selected id when exactly
   *  one overlay is selected, null otherwise. Drives single-selection-
   *  only surfaces (transform handles, popover-switches-to-selected-
   *  style) which intentionally hide when 0 or 2+ are selected. */
  primarySelectedLayerId: string | null;
  /** Outer Editor's keyboard handler reads this for Delete/Backspace.
   *  EditorLoaded populates it with a format-aware deleter (v1 →
   *  overlays:delete, v2 → layers:delete). */
  deleteSelectedRef: React.RefObject<
    ((row: OverlayRow, opts?: RecordOptions) => Promise<void>) | null
  >;
  /** Outer keyboard handler calls into this on arrow-key presses with
   *  source-pixel deltas; EditorLoaded's closure converts to normalized
   *  coords and dispatches one updateGeometry per selected layer. */
  nudgeSelectedRef: React.RefObject<
    ((dxnSteps: number, dynSteps: number) => void) | null
  >;
  /** Outer keyboard handler calls into this on ⌘] / ⌘[ / ⌘⇧] / ⌘⇧[
   *  with the variant name; EditorLoaded's closure resolves the
   *  current overlay list, computes the new ordering, and dispatches
   *  one reorder op per item whose z_index moved. Same code path for
   *  v1 + v2 — both formats expose an in-place z_index UPDATE via
   *  their respective :reorder IPCs. */
  reorderSelectedRef: React.RefObject<
    ((variant: "forward" | "backward" | "toFront" | "toBack") => void) | null
  >;
  /** Outer onPointerUp calls this when a multi-select drag commits.
   *  EditorLoaded populates it with the format-aware dispatcher loop
   *  (same shape nudgeSelectedRef uses but driven by a normalized
   *  pointer delta instead of arrow-key steps). `dxn` / `dyn` are
   *  the cursor delta in normalized [0,1] canvas coords; the closure
   *  translates each pre-drag-snapshot geometry by that delta,
   *  dispatches updateGeometry per layer, and records the burst as
   *  ONE coalesced undo entry. */
  commitMultiDragRef: React.RefObject<
    | ((
        snapshots: readonly { id: string; data: OverlayRow["data"] }[],
        dxn: number,
        dyn: number
      ) => Promise<void>)
    | null
  >;
  /** The v2 layer tree. The deleter looks up the matching layer node
   *  by id so `recordDelete` can pass `node` to the undo entry —
   *  without it, undo of a delete couldn't re-insert the
   *  structurally-identical layer. */
  modelLayers: readonly BundleLayerNode[];
  /** RAW (stored / cropped-space) layer tree + canvas dims, distinct
   *  from `modelLayers` / `record` which are the VIRTUAL full-image
   *  projection while a crop is hidden. The Layers panel's `uncrop`
   *  reads these so it inverts the real cropped dims, not the displayed
   *  natural dims. Equal to the virtual values whenever the crop is
   *  visible or absent. */
  storedLayers: readonly BundleLayerNode[];
  storedCanvasWidthPx: number;
  storedCanvasHeightPx: number;
  /** True when the lone crop layer is hidden and the editor is showing
   *  the full source image. Drives the re-crop guard in onCropCommit. */
  isUncroppedView: boolean;
  /** True when the base raster's eye is toggled off. Hides the editor
   *  <img> behind a transparency checker so annotations show on an empty
   *  canvas — matching the bake, which already drops a hidden raster. */
  isSourceHidden: boolean;
  /** True when the source PNG has transparent pixels
   *  (`CaptureRecord.has_alpha`). Paints the transparency checker behind
   *  the <img> so the alpha reads as "empty" rather than black/white,
   *  WITHOUT hiding the image (unlike isSourceHidden). Opaque captures
   *  skip the checker entirely (#3 — no wasted paint behind a solid
   *  screenshot). */
  sourceHasAlpha: boolean;
  /** Map a geometry from displayed (source) space into STORED (cropped)
   *  space — applied to the RECORDED geometry at every recordGeometry
   *  site so undo/redo (which replays via rawDispatchEdit) restores the
   *  right position. Identity when the crop is visible. */
  toStoredGeometry: (g: GeometryUpdate) => GeometryUpdate;
  /** dispatchEdit from the resolved CaptureModel. EditorLoaded threads
   *  it into useUndoRedo (so undo/redo route through the same
   *  dispatcher as create writes) and into onCropCommit (which uses
   *  bundle:updateCanvasDimensions). When the crop is hidden this is the
   *  WRAPPED dispatcher that maps draw/move coords back into stored
   *  space — so EditorLoaded's draw paths need no crop awareness. */
  dispatchEdit: (
    op: LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
  /** The UNWRAPPED dispatcher (no crop-space coord mapping). undo/redo
   *  REPLAY routes through this: every undo artifact is captured in
   *  stored (cropped) space (from dispatch results / stored nodes), so
   *  replaying it must NOT re-map through the wrapper or it double-
   *  transforms. Equal to `dispatchEdit` whenever the crop is visible. */
  rawDispatchEdit: (
    op: LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
  /** Source raster's natural dimensions, distinct from the capture's
   *  `width_px`/`height_px` which are the CANVAS (cropped) dims.
   *  Editor's <img> renders at source dims; canvas wrap clips to canvas
   *  dims so the crop is visually reflected. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Raster layer's transform translation in source-pixel units —
   *  drives the off-origin crop view (pwrdrvr/PwrSnap#110). Zero
   *  for uncropped captures and edge-aligned crops. */
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
  /** Phase 3.6 — caller-provided handler for double-click on a TEXT
   *  overlay. Opens the draft input pre-filled with the existing
   *  body; commit replaces the overlay's body rather than creating
   *  a new one. */
  onRequestEditOverlay: (overlay: OverlayRow) => void;
  pasteNotice: { text: string; tone: "error" | "info" } | null;
  setPasteNotice: React.Dispatch<
    React.SetStateAction<{ text: string; tone: "error" | "info" } | null>
  >;
  formatPasteError: (error: { code: string; message: string }) => string;
}) {
  // Live ref to the editor's source `<img>` element. BlurOverlays'
  // pixelate preview reads pixels off this image via canvas drawImage
  // to produce a real coarse-grid mosaic (issue #137); the bake's
  // mosaic algorithm operates on the same source bytes so the editor
  // and bake now agree visually block-for-block.
  const editorImageRef = useRef<HTMLImageElement | null>(null);

  const zoom = useZoomPan({
    devicePixelRatio: record.device_pixel_ratio,
    imageWidthPx: record.width_px,
    imageHeightPx: record.height_px,
    wrapRef: canvasWrapRef
  });

  // CANONICAL canvas CSS-pixel height — the single source of truth that
  // every text glyph (display + edit) reads to derive its on-screen
  // font-size. Lifted to EditorLoaded so display overlays
  // (TextHtmlOverlays) and the edit overlay (TextDraftInput) consume
  // the EXACT same value in the same render pass. Pre-fix the two
  // components each measured the canvas independently — TextHtmlOverlays
  // via ResizeObserver-backed state, TextDraftInput via a synchronous
  // getBoundingClientRect on each render. Disagreement between the two
  // (e.g. mid-resize, or stale observer state) produced a visible
  // ~11% font-size delta between display and edit. One source = zero
  // drift by construction.
  const [canvasCssHeight, setCanvasCssHeight] = useState<number>(0);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const update = (): void => {
      const rect = el.getBoundingClientRect();
      setCanvasCssHeight((prev) =>
        Math.abs(prev - rect.height) < 0.5 ? prev : rect.height
      );
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [canvasRef]);

  // Surface zoom state to Library (so its floating EditToolbar can
  // render zoom controls without overlaying the image). Split into
  // two effects so we don't bounce null/value/null/value on every
  // zoom tick (the cleanup of a deps-based effect would otherwise
  // fire `null` between every scale change).
  useEffect(() => {
    if (onZoomChange === undefined) return;
    onZoomChange({
      mode: zoom.mode,
      displayPct: zoom.displayPct,
      fitPct: zoom.fitPct,
      resetToFit: zoom.resetToFit,
      actualSize: zoom.actualSize,
      setCustomPct: zoom.setCustomPct,
      zoomBy: zoom.zoomBy
    });
  }, [
    onZoomChange,
    zoom.mode,
    zoom.displayPct,
    zoom.fitPct,
    zoom.resetToFit,
    zoom.actualSize,
    zoom.setCustomPct,
    zoom.zoomBy
  ]);
  useEffect(() => {
    if (onZoomChange === undefined) return;
    return () => onZoomChange(null);
  }, [onZoomChange]);

  const undo = useUndoRedo({
    captureId: record.id,
    applyingRef: undoApplyingRef,
    // Thread the format-aware dispatcher in so undo/redo route through
    // the same v1-or-v2 logic as create writes. Without this, the
    // hook would fall back to the legacy direct `overlays:*` dispatch
    // path — which the bus rejects on v2 captures with
    // `v2_capture_use_layers_ipc`.
    //
    // RAW (unwrapped) dispatcher on purpose: undo/redo replays artifacts
    // already in stored (cropped) space, so re-mapping them through the
    // hidden-crop wrapper would double-transform. Equals `dispatchEdit`
    // whenever the crop is visible.
    dispatchEdit: rawDispatchEdit
  });

  // Single choke point for recording a geometry edit on the undo stack.
  // Maps BOTH recorded geometries from DISPLAYED (source) space into
  // STORED (cropped) space via toStoredGeometry before handing them to the
  // undo hook — so undo/redo, which replay against stored coords (via the
  // raw dispatcher), restore the right position when the crop is hidden.
  // Centralized on purpose: the three call sites used to hand-wrap each
  // field, and a new caller (or an edit to one site) could record one
  // geometry mapped and the other raw, which drifts the layer on undo only
  // while the crop is hidden — exactly the kind of bug that hides until
  // someone toggles crop off. Routing every recordGeometry through here
  // makes the mapping un-forgettable. Identity when the crop is visible.
  const recordStoredGeometry = useCallback(
    (
      entry: Parameters<typeof undo.recordGeometry>[0],
      opts?: Parameters<typeof undo.recordGeometry>[1]
    ): void => {
      undo.recordGeometry(
        {
          ...entry,
          previousGeometry: toStoredGeometry(entry.previousGeometry),
          nextGeometry: toStoredGeometry(entry.nextGeometry)
        },
        opts
      );
    },
    [toStoredGeometry, undo]
  );

  // Bridge: parent's persistOverlay reads recordCreateRef.current
  // to push onto the undo stack. Sync the hook's recorder into
  // the parent's ref every render so callbacks aren't stale.
  useEffect(() => {
    recordCreateRef.current = undo.recordCreate;
    return () => {
      recordCreateRef.current = null;
    };
  }, [recordCreateRef, undo.recordCreate]);

  // Bridge: onCropCommit reads recordCropRef.current to push a crop
  // op onto the undo stack. Same pattern as recordCreateRef above.
  useEffect(() => {
    recordCropRef.current = undo.recordCrop;
    return () => {
      recordCropRef.current = null;
    };
  }, [recordCropRef, undo.recordCrop]);

  // Bridge: commitText's text re-edit reads recordStyleRef.current to
  // push a style op (body change) onto the undo stack. Same pattern as
  // recordCreateRef / recordCropRef above.
  useEffect(() => {
    recordStyleRef.current = undo.recordStyle;
    return () => {
      recordStyleRef.current = null;
    };
  }, [recordStyleRef, undo.recordStyle]);

  // Bridge: parent's pointer handlers read begin/endInteractionRef
  // to bracket coalescing windows around drag operations. Phase 2
  // is no-op (one write per drag) but the wiring readies Phase 4+'s
  // drag-existing-overlay flow.
  useEffect(() => {
    beginInteractionRef.current = undo.beginInteraction;
    endInteractionRef.current = undo.endInteraction;
    return () => {
      beginInteractionRef.current = null;
      endInteractionRef.current = null;
    };
  }, [
    beginInteractionRef,
    endInteractionRef,
    undo.beginInteraction,
    undo.endInteraction
  ]);

  // Phase 3.2 — selection deleter. The outer Editor's keyboard handler
  // reads `deleteSelectedRef.current` on Delete/Backspace. Routes
  // through the format-aware dispatchEdit so v1 captures hit
  // overlays:delete and v2 captures hit layers:delete with no
  // local branching. The events:overlays:changed broadcast triggers
  // useCaptureModel to refetch and the deleted row drops out.
  useEffect(() => {
    deleteSelectedRef.current = async (
      row: OverlayRow,
      opts?: RecordOptions
    ): Promise<void> => {
      // Find the layer node so recordDelete can re-insert the
      // structurally-identical layer on undo (preserves parent_id /
      // z_index / transform[] beyond what's in row.data). Read from the
      // RAW stored tree so the undo payload carries cropped-space coords
      // — undo replays through rawDispatchEdit, so a virtual (source-
      // space) node would be re-inserted at the wrong place.
      const node = storedLayers.find((l) => l.id === row.id) ?? null;
      const result = await dispatchEdit({ kind: "delete", id: row.id });
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error("delete failed", result.error);
        return;
      }
      // Record on the undo stack. Without this, Delete/Backspace
      // was silently unundoable (the dispatcher doesn't auto-
      // record; the only auto-bridge is for create via
      // recordCreateRef). The outer keyboard handler wraps a
      // multi-delete loop in beginInteraction/endInteraction so
      // every recordDelete here collapses into ONE undo entry —
      // forwarding `opts` (opKind + layerId) is what lets push()'s
      // `insideInteraction` check actually fire (untagged pushes
      // never coalesce). Single-delete callers pass no opts; that's
      // fine — the resulting standalone undo entry is correct UX.
      if (!undoApplyingRef.current) {
        undo.recordDelete(row, { node, ...(opts ?? {}) });
      }
    };
    return () => {
      deleteSelectedRef.current = null;
    };
  }, [
    deleteSelectedRef,
    dispatchEdit,
    modelLayers,
    storedLayers,
    undo,
    undoApplyingRef
  ]);

  // ---- Layers panel bridge (canvas ↔ DetailRail Layers tab) -------
  //
  // The Layers panel lives in the Library's DetailRail — a sibling of
  // this chromeless editor — so it can't reach the editor's selection
  // or dispatchers directly. We publish a small imperative API the
  // same way `onZoomChange` surfaces zoom state, and report selection
  // changes upward so the panel can highlight the active rows. The
  // editor stays the single source of truth for selection (Library
  // only mirrors it for the panel; it is never fed back in here).
  useEffect(() => {
    onSelectionChange?.(selectedLayerIds);
  }, [onSelectionChange, selectedLayerIds]);

  useEffect(() => {
    if (onLayersApi === undefined) return;
    onLayersApi({
      selectLayers: (id, additive) => {
        // Functional update so this closure doesn't capture
        // `selectedLayerIds` — that keeps the published API identity
        // stable across selection changes (no per-selection republish /
        // Library re-render). Canvas → panel selection still flows via
        // `onSelectionChange` below.
        setSelectedLayerIds((prev) =>
          additive
            ? prev.includes(id)
              ? prev.filter((x) => x !== id)
              : [...prev, id]
            : [id]
        );
      },
      setLayerVisibility: async (id, visible) => {
        // RAW node: this is a FULL-NODE replace, so it must carry stored
        // (cropped-space) coords. `modelLayers` is the virtual source-
        // space projection while a crop is hidden — writing that back
        // would scramble the layer's persisted geometry.
        const node = storedLayers.find((l) => l.id === id);
        if (node === undefined) return;
        const result = await dispatch("layers:update", {
          captureId: record.id,
          layer: { ...node, visible }
        });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("layer visibility update failed", result.error);
        }
      },
      deleteLayer: async (id) => {
        // RAW node for the undo payload (replays via rawDispatchEdit).
        const node = storedLayers.find((l) => l.id === id) ?? null;
        const result = await dispatchEdit({ kind: "delete", id });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("layer delete failed", result.error);
          return;
        }
        // Record undo when the layer projects to an OverlayRow (vector
        // + blur effect). Force `visible: true` for the projection so a
        // hidden layer still yields a row (the live projection skips
        // invisible layers). Other kinds delete without an undo entry —
        // an accepted v1 edge.
        if (node !== null && !undoApplyingRef.current) {
          const rows = projectV2LayersToOverlayRows(
            [{ ...node, visible: true }],
            record.id,
            { widthPx: record.width_px, heightPx: record.height_px }
          );
          const row = rows[0];
          if (row !== undefined) undo.recordDelete(row, { node });
        }
      },
      moveLayerToIndex: async (id, toIndex) => {
        // Reorder over the reorderable ANNOTATION set (see
        // `isReorderableLayer` — the same predicate the Layers panel pins
        // by, so a move the panel offers is a move we honor), including
        // hidden layers, sorted by z_index ASC (bottom-up) — independent
        // of the visible-filtered render snapshot. The raster (base image)
        // and the crop (no-op viewport) are excluded as pinned base
        // layers. `toIndex` is the panel's TOP-DOWN index (0 = front), so
        // convert to the bottom-up position moveToIndex / diffChanges use.
        const sourceRasterId = selectBaseRaster(modelLayers, record.sha256)?.id ?? null;
        const items = modelLayers
          .filter((l) => isReorderableLayer(l, sourceRasterId))
          .slice()
          .sort((a, b) => a.z_index - b.z_index)
          .map((l) => ({ id: l.id }));
        if (items.length === 0) return;
        const bottomUpIndex = items.length - 1 - toIndex;
        const newOrder = moveToIndex(items, id, bottomUpIndex);
        const changes = diffChanges(items, newOrder);
        for (const change of changes) {
          // eslint-disable-next-line no-await-in-loop
          const result = await dispatchEdit({
            kind: "reorder",
            layerId: change.id,
            zIndex: change.newZIndex
          });
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error("layer reorder failed", result.error);
            return;
          }
        }
      },
      uncrop: async (cropLayerId) => {
        const cropNode = storedLayers.find((l) => l.id === cropLayerId);
        if (
          cropNode === undefined ||
          cropNode.kind !== "vector" ||
          cropNode.shape.kind !== "crop"
        ) {
          return;
        }
        // FULL uncrop to the original image — not just a reverse of the
        // last crop. Crops collapse into one layer that records only the
        // most recent step, so to undo a STACK of crops we work from the
        // CUMULATIVE crop (the region of the natural raster the current
        // canvas shows), derived from canvas dims + the raster's
        // translation. Inverting that and dispatching it re-normalizes
        // every overlay back to natural coords, restores the raster
        // transform to identity, and grows the canvas to the source's
        // natural size — in one op, whether the user cropped once or N
        // times. (For a single crop this equals the old reverse-the-rect
        // behavior.)
        //
        // CRUCIAL: read the RAW stored dims + raster translate here, NOT
        // the virtual `record`/`sourceWidthPx` (which show the FULL image
        // when the crop is hidden). Inverting the virtual dims would make
        // uncrop think the canvas already == the source and bail, so
        // trashing a HIDDEN crop would silently do nothing.
        let storedSourceW = storedCanvasWidthPx;
        let storedSourceH = storedCanvasHeightPx;
        let storedTx = 0;
        let storedTy = 0;
        for (const l of storedLayers) {
          if (l.kind === "raster" && l.parent_id !== null) {
            storedSourceW = l.natural_width_px;
            storedSourceH = l.natural_height_px;
            storedTx = l.transform[4];
            storedTy = l.transform[5];
            break;
          }
        }
        if (storedCanvasWidthPx >= storedSourceW && storedCanvasHeightPx >= storedSourceH) {
          return; // already showing the whole source — nothing to uncrop
        }
        const cumulative = cropRectFromCanvas({
          canvasWidthPx: storedCanvasWidthPx,
          canvasHeightPx: storedCanvasHeightPx,
          sourceWidthPx: storedSourceW,
          sourceHeightPx: storedSourceH,
          rasterTranslateXPx: storedTx,
          rasterTranslateYPx: storedTy
        });
        if (cumulative === null) return;
        const inverse = inverseCropRect(cumulative);
        if (inverse === null) return;
        const previousWidthPx = storedCanvasWidthPx;
        const previousHeightPx = storedCanvasHeightPx;
        const result = await dispatchEdit({ kind: "crop", rect: inverse });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("uncrop failed", result.error);
          return;
        }
        // The crop dispatcher always inserts a fresh crop layer (the
        // inverse one). Delete it so no spurious "Crop" row lingers in
        // the panel and the capture is truly uncropped.
        const listed = await dispatch("layers:list", { captureId: record.id });
        if (listed.ok) {
          const leftover = listed.value.find(
            (l) => l.kind === "vector" && l.shape.kind === "crop"
          );
          if (leftover !== undefined) {
            await dispatchEdit({ kind: "delete", id: leftover.id });
          }
        }
        // Record undo so ⌘Z re-applies the original crop (mirrors
        // onCropCommit). Undo of this entry re-crops to the prior dims.
        if (result.value.kind === "crop" && !undoApplyingRef.current) {
          const newWidthPx = Math.max(
            1,
            Math.round(inverse.w * previousWidthPx)
          );
          const newHeightPx = Math.max(
            1,
            Math.round(inverse.h * previousHeightPx)
          );
          recordCropRef.current?.({
            rect: inverse,
            previousWidthPx,
            previousHeightPx,
            newWidthPx,
            newHeightPx
          });
        }
      }
    });
  }, [
    onLayersApi,
    setSelectedLayerIds,
    modelLayers,
    storedLayers,
    storedCanvasWidthPx,
    storedCanvasHeightPx,
    record,
    dispatchEdit,
    undo,
    undoApplyingRef,
    recordCropRef
  ]);
  useEffect(() => {
    if (onLayersApi === undefined) return;
    return () => onLayersApi(null);
  }, [onLayersApi]);

  // Arrow-key nudge — translate every selected overlay by N source-
  // pixels along the axis. Each dispatch is delete-plus-insert (id
  // changes), so we collect the new ids and re-anchor the selection
  // in one shot at the end. Serialized to avoid two concurrent
  // updates racing through the same broadcast → refetch cycle.
  //
  // Undo coalescing — a burst of arrow-key presses (auto-repeat or
  // back-to-back manual presses) coalesces into ONE undo entry:
  //   • First nudge after the bracket is closed → open a fresh
  //     beginInteraction("nudge", ...) bracket via the bridge refs.
  //   • Every nudge resets the idle timer (NUDGE_IDLE_MS).
  //   • Timer fire → endInteraction → bracket closed. Next nudge
  //     starts a brand-new bracket → brand-new undo entry.
  //   • Multi-layer nudge in one press → all layers' recordGeometry
  //     calls land in the SAME bracket (same press = same micro-task
  //     batch) so they collapse with each other AND with subsequent
  //     presses in the burst.
  // Refs live OUTSIDE the effect so the bracket survives the effect's
  // re-run when `selectedLayerIds` changes after dispatch settles
  // (the post-dispatch setSelectedLayerIds triggers a re-render →
  // effect cleanup → effect re-init; without ref-scoping the bracket
  // would close on every press).
  const nudgeBracketTokenRef = useRef<InteractionToken | null>(null);
  const nudgeIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const NUDGE_IDLE_MS = 500;
  // Set TRUE by nudgeSelectedRef just before its own
  // `setSelectedLayerIds(newIds)` so the selection-change effect
  // below can distinguish "nudge replaced the ids of the same
  // logical selection" from "user clicked a different layer".
  // Without this distinction the selection-change effect would fire
  // on EVERY nudge (because dispatching an edit mints new row ids
  // and the post-dispatch setSelectedLayerIds plumbs them in) and
  // would close the coalescing bracket after every press — defeats
  // burst coalescing entirely.
  const nudgeAdvancingSelectionRef = useRef(false);
  // Close the bracket exactly once on unmount — re-renders MUST NOT
  // close it (would defeat coalescing across presses). The cleanup
  // below is the only callsite besides the idle timer fire AND the
  // selection-change effect immediately below.
  useEffect(() => {
    return () => {
      if (nudgeIdleTimerRef.current !== null) {
        clearTimeout(nudgeIdleTimerRef.current);
        nudgeIdleTimerRef.current = null;
      }
      const token = nudgeBracketTokenRef.current;
      if (token !== null && endInteractionRef.current !== null) {
        endInteractionRef.current(token);
      }
      nudgeBracketTokenRef.current = null;
    };
  }, [endInteractionRef]);

  // Close the bracket when the user changes selection mid-burst (e.g.
  // nudges layer A, then clicks layer B before the 500 ms idle timer
  // fires). Without this, B's first nudge lands in A's bracket and a
  // single undo restores BOTH layers — confusing UX. The advancing-
  // selection ref (set just before the nudge's own setSelectedLayerIds)
  // lets us tell that case apart from "user really picked something
  // else" so the in-burst id rotation doesn't close the bracket.
  useEffect(() => {
    if (nudgeAdvancingSelectionRef.current) {
      nudgeAdvancingSelectionRef.current = false;
      return;
    }
    if (nudgeIdleTimerRef.current !== null) {
      clearTimeout(nudgeIdleTimerRef.current);
      nudgeIdleTimerRef.current = null;
    }
    const token = nudgeBracketTokenRef.current;
    if (token !== null && endInteractionRef.current !== null) {
      endInteractionRef.current(token);
    }
    nudgeBracketTokenRef.current = null;
  }, [selectedLayerIds, endInteractionRef]);

  useEffect(() => {
    nudgeSelectedRef.current = (dxnSteps: number, dynSteps: number): void => {
      if (selectedLayerIds.length === 0) return;
      if (record.width_px <= 0 || record.height_px <= 0) return;
      const dxn = dxnSteps / record.width_px;
      const dyn = dynSteps / record.height_px;
      const snapshot = overlays;
      const targets = selectedLayerIds
        .map((id) => snapshot.find((o) => o.id === id))
        .filter((o): o is OverlayRow => o !== undefined);
      if (targets.length === 0) return;

      // Open or refresh the coalescing bracket. The bracket lives in
      // refs (not effect-scoped locals) so it survives selection-
      // change re-renders between presses.
      if (
        nudgeBracketTokenRef.current === null &&
        beginInteractionRef.current !== null
      ) {
        nudgeBracketTokenRef.current = beginInteractionRef.current(
          "nudge",
          "kbd-nudge"
        );
      }
      if (nudgeIdleTimerRef.current !== null) {
        clearTimeout(nudgeIdleTimerRef.current);
      }
      nudgeIdleTimerRef.current = setTimeout(() => {
        const token = nudgeBracketTokenRef.current;
        if (token !== null && endInteractionRef.current !== null) {
          endInteractionRef.current(token);
        }
        nudgeBracketTokenRef.current = null;
        nudgeIdleTimerRef.current = null;
      }, NUDGE_IDLE_MS);

      void (async (): Promise<void> => {
        const newIds: string[] = [];
        for (const target of targets) {
          const geometry = translateOverlayGeometry(target.data, dxn, dyn);
          if (geometry === null) {
            // Kind has no geometry semantics (crop) — preserve in
            // selection as-is.
            newIds.push(target.id);
            continue;
          }
          // Capture the pre-nudge geometry NOW (before dispatch) so
          // the undo entry can restore it without a refetch race.
          const previousGeometry = overlayDataToGeometry(target.data);
          const result = await dispatchEdit({
            kind: "updateGeometry",
            layerId: target.id,
            geometry
          });
          if (!result.ok) {
            newIds.push(target.id);
            continue;
          }
          if (result.value.kind !== "update") {
            newIds.push(target.id);
            continue;
          }
          const artifact = result.value.artifact;
          const newId = artifact.node.id;
          newIds.push(newId);
          // Record on the undo stack. Without this, nudge was
          // silently unundoable (the dispatcher itself doesn't auto-
          // record; only recordCreate runs through the auto-bridge).
          // The recordGeometry call lands inside the bracket opened
          // above, so every nudge in the burst collapses into one
          // undo entry that restores every layer's pre-burst
          // geometry in one undo step.
          if (!undoApplyingRef.current && previousGeometry !== null) {
            recordStoredGeometry({
              currentIdRef: { current: newId },
              previousGeometry,
              nextGeometry: geometry
            });
          }
        }
        // Flag the impending selection change as "self-inflicted" so
        // the selection-change effect (which closes the coalescing
        // bracket on user-initiated changes) doesn't tear down the
        // in-flight nudge burst. Reset by the effect on next run.
        nudgeAdvancingSelectionRef.current = true;
        // Use the in-flight-aware setter — newIds come from the
        // dispatch result (so they exist in the DB) but may not have
        // landed in `overlaysForRender` by the next render, and the
        // outer stale-id cleanup would otherwise wipe them. Without
        // this the user saw the layer move 1px then the grippers
        // vanish, and the next arrow-key was stolen by the Library
        // reel because nothing was selected.
        setSelectionTrustingDispatch(newIds);
      })();
    };
    return () => {
      nudgeSelectedRef.current = null;
    };
  }, [
    nudgeSelectedRef,
    selectedLayerIds,
    overlays,
    dispatchEdit,
    record.width_px,
    record.height_px,
    setSelectionTrustingDispatch,
    recordStoredGeometry,
    undoApplyingRef,
    beginInteractionRef,
    endInteractionRef
  ]);

  // Multi-select drag commit — wired to the outer Editor's
  // `multiDragStartRef` via `commitMultiDragRef`. The OUTER pointer
  // handlers initiate the gesture (snapshot + setPointerCapture on
  // pointerdown over an already-multi-selected layer; compute delta
  // on pointerup) and call this closure with the snapshots + delta.
  // Same shape as `nudgeSelectedRef` (translate every snapshot by
  // (dxn, dyn), dispatch updateGeometry per layer, coalesce into ONE
  // undo entry via a shared bracket) — the only difference is the
  // delta source: keyboard steps for nudge, pointer-delta here.
  useEffect(() => {
    commitMultiDragRef.current = async (
      snapshots,
      dxn,
      dyn
    ): Promise<void> => {
      if (snapshots.length === 0) return;
      // Open the coalescing bracket — same key shape the multi-delete
      // handler uses. Every recordGeometry inside the loop tags with
      // the same { opKind, layerId } so push()'s `insideInteraction`
      // check fires and all N entries collapse into 1 undo step.
      const begin = beginInteractionRef.current;
      const end = endInteractionRef.current;
      const token =
        begin !== null ? begin("multi-drag", "pointer-multi-drag") : null;
      try {
        const newIds: string[] = [];
        for (const snapshot of snapshots) {
          const geometry = translateOverlayGeometry(snapshot.data, dxn, dyn);
          if (geometry === null) {
            // Kind has no geometry semantics (crop) — preserve in
            // selection but skip the dispatch.
            newIds.push(snapshot.id);
            continue;
          }
          const previousGeometry = overlayDataToGeometry(snapshot.data);
          const result = await dispatchEdit({
            kind: "updateGeometry",
            layerId: snapshot.id,
            geometry
          });
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error("multi-drag dispatch failed", result.error);
            newIds.push(snapshot.id);
            continue;
          }
          if (result.value.kind !== "update") {
            newIds.push(snapshot.id);
            continue;
          }
          const artifact = result.value.artifact;
          const newId = artifact.node.id;
          newIds.push(newId);
          if (!undoApplyingRef.current && previousGeometry !== null) {
            recordStoredGeometry(
              {
                currentIdRef: { current: newId },
                previousGeometry,
                nextGeometry: geometry
              },
              {
                opKind: "multi-drag",
                layerId: "pointer-multi-drag",
                // Multi-drag bursts each push a DIFFERENT layer's
                // geometry. "append" → push() accumulates every
                // item into the entry's items[] so undo restores
                // every layer's pre-drag geometry, not just the
                // first dragged layer.
                mergeMode: "append"
              }
            );
          }
        }
        // Re-anchor the selection on the post-dispatch ids — each
        // updateGeometry mints a new row id (delete-plus-insert),
        // so the original ids in `snapshots` are gone after the
        // burst. setSelectionTrustingDispatch holds them in the
        // in-flight set until the broadcast confirms they landed.
        setSelectionTrustingDispatch(newIds);
      } finally {
        if (token !== null && end !== null) end(token);
      }
    };
    return () => {
      commitMultiDragRef.current = null;
    };
  }, [
    commitMultiDragRef,
    dispatchEdit,
    setSelectionTrustingDispatch,
    recordStoredGeometry,
    undoApplyingRef,
    beginInteractionRef,
    endInteractionRef
  ]);

  // Z-order ops — bring forward / send backward / bring to front /
  // send to back. Computes the new ordering on the renderer side via
  // `computeNewOrder` (pure, well-tested) and dispatches one reorder
  // op per item whose POSITION changed. Layer / row ids are preserved
  // on both formats (reorder is a true in-place UPDATE on `z_index`,
  // not a delete-plus-insert), so the selection stays valid without
  // re-anchoring.
  useEffect(() => {
    reorderSelectedRef.current = (
      variant: "forward" | "backward" | "toFront" | "toBack"
    ): void => {
      if (selectedLayerIds.length === 0) return;
      const snapshot = overlays;
      if (snapshot.length === 0) return;
      const newOrder = computeNewOrder(snapshot, selectedLayerIds, variant);
      const changes = diffChanges(snapshot, newOrder);
      if (changes.length === 0) return;
      void (async (): Promise<void> => {
        for (const change of changes) {
          const result = await dispatchEdit({
            kind: "reorder",
            layerId: change.id,
            zIndex: change.newZIndex
          });
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.error("reorder failed", result.error);
            return;
          }
        }
      })();
    };
    return () => {
      reorderSelectedRef.current = null;
    };
  }, [reorderSelectedRef, selectedLayerIds, overlays, dispatchEdit]);

  // ----- Phase 3.5: transform handles + selected-style editing -----
  //
  // Resolve the currently-selected overlay row for the handles.
  // Transform handles + the per-layer style popover render ONLY when
  // exactly one overlay is selected — multi-select gets the dashed
  // outline + keyboard ops (delete / nudge / copy / z-order) but no
  // resize handles (would need union-bbox math) and no style edits
  // (would need to fan out the patch to every selected layer of the
  // same kind). Single-select to refine.
  const selectedOverlayForHandles: OverlayRow | null =
    primarySelectedLayerId === null
      ? null
      : overlays.find((r) => r.id === primarySelectedLayerId) ?? null;

  // Pre-drag snapshot — stashed on pointerdown so the geometry undo
  // entry can record the PRE-DRAG geometry alongside the post-drag
  // result. Cleared on drag end (whether or not the drag committed).
  const preDragRef = useRef<OverlayRow | null>(null);

  // Live-drag preview state — populated on every pointermove from
  // TransformHandles so OverlaySvg + BlurOverlays can paint the
  // selected overlay at the in-progress geometry. Cleared once
  // dispatchEdit settles (or immediately on failure / cancel).
  // Without this the underlying glyph stays at its pre-drag
  // position while the handle is dragged — the user sees the bbox
  // outline + handle move but the painted glyph "vanishes" until
  // commit re-anchors it (the bug we're fixing).
  // `draftGeometry` + `setDraftGeometry` are lifted to the outer
  // Editor — the multi-drag pointer handlers there need to write
  // them, and the single-select drag handlers below read/write them
  // through the same props. See the outer declaration for the full
  // rationale and shape comment.

  const onHandleDragStart = useCallback((row: OverlayRow): void => {
    preDragRef.current = row;
  }, []);

  const onHandleDragEnd = useCallback((): void => {
    // Don't clear preDragRef here — the geometry handler reads it
    // AFTER onDragEnd fires (the order is onGeometryChange → onDragEnd).
    // Cleared at the end of onHandleGeometryChange instead. The live
    // override is ALSO cleared by the geometry handler once
    // dispatchEdit resolves, so the override doesn't blink back to
    // the pre-drag position between drag-end and the broadcast refetch.
  }, []);

  const onHandleGeometryDrag = useCallback(
    (geometry: GeometryUpdate): void => {
      // Stash the in-progress geometry against the currently-dragged
      // overlay's id so OverlaySvg / BlurOverlays can paint it. Read
      // the id from the pre-drag snapshot rather than selectedLayerIds
      // so a stray selection-change broadcast mid-drag can't repoint
      // the override at the wrong row.
      const preDrag = preDragRef.current;
      if (preDrag === null) return;
      // Single-select drag emits a 1-entry map. Same renderer
      // contract as multi-drag (which emits N entries), unified
      // through `ReadonlyMap<string, GeometryUpdate>`.
      setDraftGeometry(new Map([[preDrag.id, geometry]]));
    },
    []
  );

  const onHandleGeometryChange = useCallback(
    (geometry: GeometryUpdate): void => {
      const preDrag = preDragRef.current;
      preDragRef.current = null;
      if (preDrag === null) {
        setDraftGeometry(null);
        return;
      }
      void (async (): Promise<void> => {
        const result = await dispatchEdit({
          kind: "updateGeometry",
          layerId: preDrag.id,
          geometry
        });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("updateGeometry failed", result.error);
          // Drop the live override on failure so the canvas snaps
          // back to the persisted (pre-drag) geometry rather than
          // strand the user with a ghost preview.
          setDraftGeometry(null);
          return;
        }
        if (result.value.kind !== "update") {
          setDraftGeometry(null);
          return;
        }
        const artifact = result.value.artifact;
        const newId = artifact.node.id;
        // Re-anchor the selection on the new id so the handles + the
        // selection outline follow the freshly-inserted row. Geometry
        // drags happen via TransformHandles which only renders for
        // single-select, so replacing (not merging) is correct here —
        // multi-select doesn't expose this code path today.
        //
        // Use the in-flight-aware setter — the newId is fresh from
        // the dispatch but the events:overlays:changed (or v2's
        // events:layers:changed) broadcast that adds it to
        // `overlaysForRender` is still in flight, so the outer
        // stale-id cleanup would wipe the selection (= grippers
        // vanish mid-drag) without the in-flight bookkeeping.
        setSelectionTrustingDispatch([newId]);
        // DON'T clear the live override here. Clearing immediately
        // produces a one-frame flash: at this point the dispatch has
        // resolved but the events:layers:changed broadcast hasn't
        // reached this renderer yet, so `overlays` STILL contains the
        // row at its OLD geometry. A bare-list paint would show the
        // pre-drag position briefly, then snap to post-drag once the
        // broadcast lands. Instead we leave the override in place (keyed
        // to preDrag.id — which v2 PRESERVES across the updateGeometry)
        // so the row keeps painting at the NEW geometry until the
        // refetch lands; the cleanup effect below then drops the
        // override once the persisted geometry MATCHES it (not when the
        // id changes — it doesn't, under v2). End result: zero-flash
        // pointerup → persisted state, and no stale override left to
        // mask a later undo.
        if (!undoApplyingRef.current) {
          const previousGeometry = overlayDataToGeometry(preDrag.data);
          if (previousGeometry !== null) {
            recordStoredGeometry({
              currentIdRef: { current: newId },
              previousGeometry,
              nextGeometry: geometry
            });
          }
        }
      })();
    },
    [dispatchEdit, setSelectionTrustingDispatch, recordStoredGeometry, undoApplyingRef]
  );

  // Cleanup effect — drop each live-drag override once the persisted
  // geometry has CAUGHT UP to it (the commit landed via the broadcast
  // refetch), OR the row it's keyed to is gone.
  //
  // The override is left in place at pointer-up so the row keeps
  // painting at the dragged geometry until the refetch lands (no
  // one-frame flash back to the pre-drag position). It must then be
  // dropped — but the OLD signal ("the dragged row's id disappeared")
  // only fired for v1's delete-plus-insert (new id). v2's
  // `updateGeometry` PRESERVES the layer id, so id-presence never
  // cleared the override: it lingered and MASKED the next undo/redo
  // (the data reverted, the stale override kept painting the dragged
  // position → glyph stuck, while the selection outline / handles /
  // hit-test sat at the reverted position). `pruneLandedDraftGeometry`
  // clears on geometry match instead, which is correct for both
  // formats. See draft-geometry.ts.
  useEffect(() => {
    if (draftGeometry === null) return;
    const next = pruneLandedDraftGeometry(
      draftGeometry,
      overlays,
      record.width_px,
      record.height_px
    );
    if (next !== draftGeometry) setDraftGeometry(next);
  }, [overlays, draftGeometry, record.width_px, record.height_px]);

  // Selected-overlay style edit handler — dispatched when the popover
  // is in selected-overlay mode (selectedOverlay is set). Mirrors the
  // geometry handler: dispatchEdit + re-anchor selection + record on
  // the undo stack.
  const onSelectedStyleFieldChange = useCallback(
    (field: string, value: unknown): void => {
      const current = selectedOverlayForHandles;
      if (current === null) return;
      // Special case: the text popover's "fontSize" field has to map
      // to TextOverlay's `size` field (different name — popover is
      // ToolStylePopover state, overlay is the persisted schema). Pre-
      // pwrdrvr/PwrSnap#110 this mapping was missing, so size changes
      // on selected text rows silently did nothing (the patch carried
      // an unknown `fontSize` field that the bus's zod parse stripped).
      // Now we also recompute `sizePx` to re-snap the persisted
      // absolute size to the current canvas's bucket value — what
      // surfaces "Custom" → S/M/L resize for the user.
      let patch: Partial<Overlay>;
      if (
        current.data.kind === "text" &&
        field === "fontSize" &&
        (value === "auto" || value === "small" || value === "medium" || value === "large")
      ) {
        const newSize: "small" | "medium" | "large" = resolveTextSize(
          value as "auto" | "small" | "medium" | "large"
        );
        // Recompute sizePx for the current canvas — the user has
        // explicitly picked a bucket, so re-snap to that bucket's
        // value (no more "Custom" state after this lands).
        const newSizePx = computeTextGlyphSize({
          size: newSize,
          sourceWidthPx,
          sourceHeightPx,
          canvasWidthPx: record.width_px,
          canvasHeightPx: record.height_px
        }).sizePx;
        patch = {
          kind: "text",
          size: newSize,
          sizePx: newSizePx
        };
      } else {
        // Project the (field, value) pair into a single-field overlay
        // patch. The patch's kind matches the current overlay's kind so
        // the dispatcher's kind-match guard accepts it.
        patch = {
          kind: current.data.kind,
          [field]: value
        } as Partial<Overlay>;
      }
      void (async (): Promise<void> => {
        const result = await dispatchEdit({
          kind: "updateOverlay",
          layerId: current.id,
          patch
        });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("updateOverlay failed", result.error);
          return;
        }
        if (result.value.kind !== "update") return;
        const artifact = result.value.artifact;
        const newId = artifact.node.id;
        // Style edits go through onSelectedStyleFieldChange which is
        // single-selection-only (gated by selectedOverlayForHandles).
        // Replace, not merge — the new id supersedes the old.
        //
        // In-flight-aware setter so the outer stale-id cleanup doesn't
        // wipe the selection between dispatch resolving and the
        // broadcast landing — same race as the nudge / drag paths.
        setSelectionTrustingDispatch([newId]);
        if (!undoApplyingRef.current) {
          // Capture the pre-edit value of the SAME field so undo
          // restores it. For nested objects the caller is expected to
          // pass a whole-object replacement — same shallow-merge
          // semantics as the dispatcher.
          const previousPatch: Partial<Overlay> = {
            kind: current.data.kind,
            [field]: (current.data as Record<string, unknown>)[field]
          } as Partial<Overlay>;
          undo.recordStyle({
            currentIdRef: { current: newId },
            previousPatch,
            nextPatch: patch
          });
        }
      })();
    },
    [dispatchEdit, selectedOverlayForHandles, setSelectionTrustingDispatch, undo, undoApplyingRef]
  );

  // ⌘0 / ⌘1 / ⌘+ / ⌘- keyboard shortcuts for zoom.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        zoom.resetToFit();
      } else if (e.key === "1") {
        e.preventDefault();
        zoom.actualSize();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoom.zoomBy(1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoom.zoomBy(1 / 1.25);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  // Attach the non-passive wheel listener at the WINDOW level with
  // CAPTURE phase. Two reasons:
  //
  // 1. Capture-phase at window catches wheel events BEFORE any
  //    intermediate element can stopPropagation or otherwise hide
  //    them from us. Earlier debugging suggested the wheel-with-
  //    ctrlKey synthetic events from macOS trackpad pinch weren't
  //    reliably reaching a wrap-level listener even with
  //    setVisualZoomLevelLimits(1, 1) on the webContents. Going
  //    window-level guarantees we see the events.
  //
  // 2. React's synthetic events go through a passive listener, so
  //    event.preventDefault() inside an onWheel JSX prop would warn
  //    or no-op. Native addEventListener with `passive: false` is
  //    the only reliable way.
  //
  // We filter by whether the event target is inside the canvas-wrap
  // so wheel events over the DetailRail, sidebar, popover, etc.
  // pass through normally.
  //
  // `onWheelRef` lets the listener attach ONCE on mount but still
  // call the latest `zoom.onWheel` closure (which captures `state`,
  // `computeFit`, etc.). Without the ref the effect would have to
  // depend on `zoom` (a new object every render) and re-attach the
  // listener every render — a microsecond window where pinch
  // events get dropped.
  const onWheelRef = useRef(zoom.onWheel);
  const onGestureStartRef = useRef(zoom.onGestureStart);
  const onGestureChangeRef = useRef(zoom.onGestureChange);
  const onGestureEndRef = useRef(zoom.onGestureEnd);
  useEffect(() => {
    onWheelRef.current = zoom.onWheel;
    onGestureStartRef.current = zoom.onGestureStart;
    onGestureChangeRef.current = zoom.onGestureChange;
    onGestureEndRef.current = zoom.onGestureEnd;
  });
  useEffect(() => {
    const inWrap = (e: Event): boolean => {
      const wrap = canvasWrapRef.current;
      if (wrap === null) return false;
      if (!(e.target instanceof Node)) return false;
      return wrap.contains(e.target);
    };
    const onWheel = (e: WheelEvent): void => {
      if (!inWrap(e)) return;
      onWheelRef.current(e);
    };
    // macOS trackpad pinch SHOULD dispatch synthetic ctrl+wheel
    // events (when setVisualZoomLevelLimits is set to a
    // non-degenerate range, which preload/main both do). On some
    // Chromium configurations the synthesis is silently dropped —
    // diagnostic logs from PR #91 verified that on the test
    // machine, pinch fires nothing while regular wheel fires
    // normally. Gesture event handlers (gesturestart/change/end)
    // are wired here as a fallback for the WebKit-style native
    // gesture path Chromium uses on some macOS configs. We leave
    // them in because they're harmless when they don't fire and
    // load-bearing when they do — pinch dispatch is unreliable
    // enough across machines that defense in depth is worth it.
    // The Figma-style ctrl/⌘+scroll fallback (in useZoomPan's
    // onWheel) is what gets the user a working zoom regardless.
    const onGestureStart = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureStartRef.current(e);
    };
    const onGestureChange = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureChangeRef.current(e);
    };
    const onGestureEnd = (e: Event): void => {
      if (!inWrap(e)) return;
      onGestureEndRef.current(e);
    };
    window.addEventListener("wheel", onWheel, { passive: false, capture: true });
    // macOS trackpad pinch — primary signal on Mac. Capture-phase
    // on the window so we catch them no matter where they're
    // dispatched. Note: gesturestart/change/end aren't in the
    // standard DOM event map; we use string event names.
    window.addEventListener("gesturestart", onGestureStart, { passive: false, capture: true });
    window.addEventListener("gesturechange", onGestureChange, { passive: false, capture: true });
    window.addEventListener("gestureend", onGestureEnd, { passive: false, capture: true });
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("gesturestart", onGestureStart, { capture: true });
      window.removeEventListener("gesturechange", onGestureChange, { capture: true });
      window.removeEventListener("gestureend", onGestureEnd, { capture: true });
    };
  }, [canvasWrapRef]);

  // When zoomed in or space-held, the canvas-wrap absorbs pan-drag
  // pointer events instead of the canvas's drawing handlers.
  // Single-finger drag arbitration on the canvas wrap:
  //   • Space held → always pan (Photoshop convention: hold Space
  //     to grab + drag regardless of active tool).
  //   • Pointer tool + zoomed in → pan (Pointer is the "no-op on
  //     drag" tool, so we repurpose its drag for navigation).
  //   • Any drawing tool (arrow, rect, highlight, blur, text) →
  //     pointer events go to the canvas so the user can DRAW. Pan
  //     stays accessible via Space+drag and via two-finger scroll
  //     (which doesn't conflict with tool drag — it's a separate
  //     gesture handled by useZoomPan's wheel handler).
  //
  // Crop is excluded from the pan arbitration — its overlay catches
  // all pointer events directly via its own element handlers.
  const wantPan = zoom.spaceHeld || (tool === "pointer" && zoom.state.scale > 1);

  // -------------------- Canvas DOMRect for CropTool ----------------
  //
  // CropTool needs the canvas's bounding rect in viewport coords so it
  // can translate pointer events into source-pixel coords. Track it as
  // state so a window resize / zoom change re-renders the overlay with
  // the new rect. ResizeObserver fires on size changes; scroll +
  // zoom-induced layout shifts get picked up via the deps below.
  const [canvasRect, setCanvasRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const update = (): void => {
      setCanvasRect(el.getBoundingClientRect());
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
    // Use the primitive components of canvasStyle, NOT the object
    // reference itself. `useZoomPan` rebuilds the canvasStyle object
    // on every render (no useMemo); depending on the object reference
    // here would tick the effect on every parent re-render, which
    // calls setCanvasRect with a fresh DOMRect, which forces another
    // render → React's "Maximum update depth exceeded" loop. Primitive
    // string deps stay reference-stable across renders that don't
    // actually change the canvas layout.
  }, [
    canvasRef,
    zoom.canvasStyle?.width,
    zoom.canvasStyle?.height,
    zoom.canvasStyle?.transform
  ]);

  const drop = useDropImage({
    captureId: record.id,
    bundleFormatVersion: record.bundle_format_version,
    canvasEl: canvasRef.current,
    onError: (error) => {
      setPasteNotice({ text: formatPasteError(error), tone: "error" });
    }
  });

  // -------------------- ToolStylePopover anchor + open state -------
  //
  // The popover anchors to a DOM ref provided by the toolbar's active
  // tool button. The toolbar populates `popoverAnchorRef.current` when
  // it mounts the active styled tool button.
  const popoverAnchorRef = useRef<HTMLElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const styledActiveTool: StyledToolKind | null = isStyledToolKind(tool)
    ? tool
    : null;
  // If the active tool changes off the styled set (e.g. user switches
  // to pointer), close the popover.
  useEffect(() => {
    if (styledActiveTool === null) {
      setPopoverOpen(false);
    }
  }, [styledActiveTool]);
  // Expose the open action to the parent's keyboard handler.
  useEffect(() => {
    openActivePopoverRef.current = (): void => {
      if (styledActiveTool !== null) {
        setPopoverOpen(true);
      }
    };
    return () => {
      openActivePopoverRef.current = null;
    };
  }, [openActivePopoverRef, styledActiveTool]);

  // -------------------- Crop commit handler ------------------------
  //
  // On ↵ inside CropTool, route through dispatchEdit's `crop` op kind.
  // For v1 captures the dispatcher inserts a CropOverlay through
  // overlays:upsert. For v2 captures the dispatcher updates the
  // captures row's width_px/height_px via bundle:updateCanvasDimensions,
  // which causes the compositor to clip the next composite to the
  // new canvas size.
  //
  // Crop exits to pointer on commit (mirrors the cancel path below
  // and Photoshop/Cleanshot/Skitch's behavior — every other crop
  // tool dismisses on Apply). Pre-fix the crop was deliberately
  // "sticky" — the assumption was the user might re-crop several
  // times — but that's wrong in practice: after Apply, the canvas
  // has SHRUNK, and the now-stale crop rect renders over the
  // smaller canvas in a confusing way (the post-commit screenshot in
  // pwrdrvr/PwrSnap#109 shows exactly this). Users who want to
  // re-crop pick the Crop tool again, which is the cheap path.
  const onCropCommit = useCallback(
    (rect: { x: number; y: number; w: number; h: number }): void => {
      void (async (): Promise<void> => {
        // Re-cropping while the crop is HIDDEN (the editor is showing the
        // full image) is ambiguous: the rect is in source space but the
        // dispatcher re-normalizes the STORED (cropped-space) overlays,
        // so applying it would scramble them. v1 guards it off — show the
        // crop again to adjust it, or trash it (full uncrop) first. The
        // common flow (draw on the revealed image) isn't affected.
        if (isUncroppedView) {
          setTool("pointer");
          return;
        }
        // Snapshot the pre-crop canvas dims BEFORE dispatching so the
        // undo entry knows what to restore on ⌘Z. Reading after the
        // dispatch would race the events:captures:changed broadcast
        // (which refetches the record with the new dims).
        const previousWidthPx = record.width_px;
        const previousHeightPx = record.height_px;
        const result = await dispatchEdit({ kind: "crop", rect });
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error("crop via dispatchEdit failed", result.error);
          return;
        }
        if (result.value.kind === "crop" && !undoApplyingRef.current) {
          // Compute the post-crop dims the dispatcher just landed.
          // For v2 it's previous × rect.{w,h} (rounded); for v1 the
          // canvas doesn't change, but we still record the entry so
          // ⌘Z removes the just-inserted CropOverlay row.
          let newWidthPx = previousWidthPx;
          let newHeightPx = previousHeightPx;
          if (record.bundle_format_version >= 2) {
            newWidthPx = Math.max(1, Math.round(rect.w * previousWidthPx));
            newHeightPx = Math.max(1, Math.round(rect.h * previousHeightPx));
          }
          recordCropRef.current?.({
            rect,
            previousWidthPx,
            previousHeightPx,
            newWidthPx,
            newHeightPx
          });
        }
        if (!isControlled) {
          toolState.onAnnotationPlaced({ tool: "crop" });
        }
        // Exit crop mode so the HUD, handles, and rule-of-thirds grid
        // dismiss. Without this the post-Apply screenshot in #109
        // shows the cropped (smaller) canvas with the old crop rect
        // still painted on top — confusing because the rect coords
        // refer to the OLD canvas dims and don't match anything the
        // user sees now. setTool guards against the controlled mode
        // already (onChange wrapper). Skip during undo replay so a
        // ⌘Z of a crop doesn't yank the user out of whatever tool
        // they're currently on.
        if (!undoApplyingRef.current) {
          setTool("pointer");
        }
      })();
    },
    [
      isControlled,
      isUncroppedView,
      record,
      dispatchEdit,
      recordCropRef,
      toolState,
      undoApplyingRef,
      setTool
    ]
  );

  const onCropCancel = useCallback((): void => {
    // Switching to pointer feels like "I'm done cropping" without
    // wedging the user on the crop tool. Mirrors Photoshop's behavior.
    // Same exit target as `onCropCommit` so Cancel and Apply share
    // the same end-state.
    setTool("pointer");
  }, [setTool]);

  // ------------------------------------------------------------------
  // Render — three modes:
  //   • chrome === "full" → wrap viewport in <EditorChrome> with the
  //     four right-sidebar panels.
  //   • chrome === "embedded" → standalone-style root, no chrome.
  //   • chrome === "chromeless" → Library Focus / Reel; canvas-only.
  // ------------------------------------------------------------------

  // Non-base raster layers (pasted images, the captured cursor) render as
  // their own positioned <img> elements via the RasterLayers LayerView.
  // The Source raster is already drawn by the <img> below; every other
  // raster stacks above it. Hidden / rejected layers are excluded so the
  // editor matches what the compositor paints. `selectBaseRaster` is the
  // same sha-matched Source rule the Layers panel pins by (and that the
  // `isSourceHidden` flag above already used).
  const sourceRasterId = selectBaseRaster(modelLayers, record.sha256)?.id ?? null;
  const extraRasterLayers = modelLayers.filter(
    (l): l is Extract<BundleLayerNode, { kind: "raster" }> =>
      l.kind === "raster" &&
      l.id !== sourceRasterId &&
      l.visible &&
      l.rejected_at === null
  );

  const viewport = (
    <div
      className={
        "editor-root" +
        (chrome === "embedded" ? " is-embedded" : "") +
        (chrome === "chromeless" ? " is-chromeless" : "") +
        (chrome === "full" ? " is-in-chrome" : "")
      }
      data-testid="editor-root"
      data-bundle-format-version={record.bundle_format_version}
    >
      {chrome === "full" && (
        <header className="editor-titlebar">
          <span className="editor-title">
            PwrSnap Editor · {record.source_app_name ?? "Capture"} ·{" "}
            <span className="editor-title-meta">
              {record.width_px}×{record.height_px}
            </span>
          </span>
        </header>
      )}

      <div
        ref={canvasWrapRef}
        className={
          "editor-canvas-wrap" +
          (wantPan ? " is-pannable" : "") +
          (zoom.isPanning ? " is-panning" : "") +
          (drop.isDragOver ? " is-drop-target" : "")
        }
        onPointerDown={wantPan ? zoom.onPanPointerDown : undefined}
        onPointerMove={wantPan ? zoom.onPanPointerMove : undefined}
        onPointerUp={wantPan ? zoom.onPanPointerUp : undefined}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={(e) => void drop.onDrop(e)}
        data-testid="editor-canvas-wrap"
      >
        <div
          ref={canvasRef}
          className={
            "editor-canvas" +
            // Until useZoomPan's layout effect measures the wrap and
            // emits explicit CSS px for the canvas, `.is-pre-measured`
            // applies max-width/max-height:100% as a safety net so the
            // canvas can't size up to the <img>'s intrinsic
            // dimensions (which would force scrollbars on the wrap
            // and start the resize feedback loop).
            (zoom.canvasStyle === null ? " is-pre-measured" : "")
          }
          style={
            // After first layout, useZoomPan returns explicit CSS px
            // for width/height. Before the wrap measures (rare; only
            // on the first frame between commit and useLayoutEffect),
            // fall back to aspect-ratio so the canvas has a sane
            // intrinsic shape.
            zoom.canvasStyle ?? { aspectRatio: `${record.width_px} / ${record.height_px}` }
          }
          onPointerDown={wantPan ? undefined : onPointerDown}
          onPointerMove={wantPan ? undefined : onPointerMove}
          onPointerUp={wantPan ? undefined : onPointerUp}
          onPointerCancel={wantPan ? undefined : onPointerCancel}
          onContextMenu={wantPan ? undefined : onContextMenu}
          data-tool={tool}
        >
          {/* Phase 3.6 — the <img> is sized so the SOURCE raster's
              natural pixels map 1:1 to canvas CSS pixels regardless of
              the current Fit/Actual/custom zoom level. The trick is to
              size the img to `(source / canvas) × 100%` of its parent
              and let the default object-fit (fill) scale the image
              content to that box. The `.editor-image-clip` wrapper
              (sized to the canvas, overflow:hidden) clips the overflow
              — `.editor-canvas` itself is overflow:visible so handles +
              outlines can extend off-canvas (#125).

              Why the percentage trick works for crop view:
                • No crop  → source == canvas → img is 100% × 100% →
                  natural image fills canvas exactly.
                • Crop     → source > canvas → img is e.g. 200% × 200%
                  of canvas → natural image's top-left fills the canvas
                  area; the rest overflows and is clipped.

              Why we must NOT add `objectFit: "none"`: that tells the
              browser to ignore the box size and render the image
              content at its natural pixel resolution. The img box
              would still scale with zoom (it's % of the canvas), but
              the rasterized content inside it would stay at native
              pixels and overflow as the canvas shrinks — so Fit zoom
              would show only the top-left of a HUGE image (this bug
              regressed once during the Phase 3.6 crop-view work; the
              symptom is a 2880×1920 capture displaying its top-left
              ~640px at Fit-73% instead of the whole thing scaled
              down). The default object-fit (fill) makes the image
              content respect the box, which is the behavior every
              zoom level expects.

              Off-origin crops (pwrdrvr/PwrSnap#110): the editor's view
              renders the SOURCE raster directly (not the baked
              composite), so the img has to honor the raster layer's
              transform translation too. The dispatcher's
              `Step 0.5: translate every raster layer's transform...`
              (useCaptureModel.ts) writes the translation in source-
              pixel units; `computeEditorImageStyle` converts that to
              a CSS `translate(%, %)` on the img with
              `transformOrigin: "0 0"`. Without this, an off-origin
              crop silently shows the top-left of the source even
              though the bake (compose-tree.ts) produces the right
              region. */}
          {/* Crop clip box. The <img> is sized to (source/canvas)×100%
              so a cropped capture's source OVERFLOWS the canvas (e.g.
              100%×412% for a horizontal-band crop) — that overflow is
              the whole mechanism: the kept region fills the canvas and
              the rest spills past the edges. It MUST be clipped to the
              canvas so the editor shows the same region the bake /
              export / library thumbnail produce.

              `.editor-canvas` itself is overflow:visible on purpose (so
              SelectionOutline + TransformHandles + draft glyphs can
              extend past the canvas edge when a shape is dragged
              off-screen — #125). That means it can NO LONGER clip the
              image, so the image gets its OWN overflow:hidden box here,
              sized to the canvas via inset:0. Without this wrapper the
              full source bleeds out and the crop is invisible in the
              editor even though every baked surface is correctly cropped
              — exactly the regression #125 introduced when it flipped
              .editor-canvas to overflow:visible on the (false for
              cropped captures) assumption that "the IMAGE doesn't extend
              past on its own". border-radius on the <img> does NOT stand
              in for this clip: it rounds the img's OWN (412%-tall) box,
              not the canvas, and for off-origin crops it would notch the
              middle of the visible region. */}
          <div
            className={
              "editor-image-clip" +
              // Paint the checker only when there's transparency to reveal:
              // the source is hidden (whole canvas empty) OR the source PNG
              // has alpha. An opaque, visible source skips it (#3) — the
              // <img> would cover it anyway, so it's pure wasted paint.
              (isSourceHidden || sourceHasAlpha ? " editor-image-clip--alpha" : "") +
              (isSourceHidden ? " editor-image-clip--source-hidden" : "")
            }
            data-source-hidden={isSourceHidden ? "true" : undefined}
          >
            {/* The <img> stays mounted (BlurOverlays' pixelate preview
                samples it via editorImageRef) but is hidden via CSS when
                the Source eye is off; the clip's checkerboard shows
                through as the "empty canvas". */}
            <img
              ref={editorImageRef}
              src={captureSrcUrl(record.id)}
              alt={record.source_app_name ?? "Capture"}
              draggable={false}
              className="editor-image"
              data-testid="editor-image"
              style={computeEditorImageStyle({
                sourceWidthPx,
                sourceHeightPx,
                canvasWidthPx: record.width_px,
                canvasHeightPx: record.height_px,
                rasterTranslateXPx,
                rasterTranslateYPx
              })}
            />
            {/* Non-base raster layers (pasted images, captured cursor)
                stacked above the base source, clipped to the canvas by
                the same .editor-image-clip overflow:hidden. */}
            <RasterLayers
              layers={extraRasterLayers}
              captureId={record.id}
              canvasWidthPx={record.width_px}
              canvasHeightPx={record.height_px}
              selectedLayerIds={selectedLayerIds}
            />
          </div>
          {/* HTML blur layer between the <img> and the SVG so
              backdrop-filter on each blur rect actually obscures
              the image behind. Lives separately from OverlaySvg
              because SVG <filter> can blur SVG content but not a
              sibling raster <img>. */}
          <BlurOverlays
            overlays={overlays}
            draft={draft}
            blurStyle={blurStyle}
            blurRadiusPx={blurRadiusPx}
            liveOverride={draftGeometry}
            editorImageRef={editorImageRef}
            canvasWidthPx={record.width_px}
            canvasHeightPx={record.height_px}
            sourceWidthPx={sourceWidthPx}
            sourceHeightPx={sourceHeightPx}
            rasterTranslateXPx={rasterTranslateXPx}
            rasterTranslateYPx={rasterTranslateYPx}
          />
          <OverlaySvg
            overlays={overlays}
            draft={draft}
            // Phase 3.3 — thread the active tool's color through to the
            // live-drag preview so a draft renders in the picked color
            // (not just on commit). Resolves the live activeStyle for
            // the relevant tool to a hex via resolveToolColor; for
            // tools whose draft kind doesn't carry a color (blur is
            // rendered separately by BlurOverlays), this is a no-op.
            // Falls back to undefined → glyph's own --accent default.
            draftStyle={resolveDraftStyleForActiveTool(toolState.activeStyle)}
            imageWidthPx={record.width_px}
            imageHeightPx={record.height_px}
            // pwrdrvr/PwrSnap#110: source raster dims drive text
            // overlay sizing so a "medium" text doesn't shrink when
            // the user crops. CANVAS dims (image*Px above) drive
            // coord normalization (those scale with the canvas).
            sourceWidthPx={sourceWidthPx}
            sourceHeightPx={sourceHeightPx}
            selectedLayerIds={selectedLayerIds}
            liveOverride={draftGeometry}
          />
          {/* HTML-text overlay layer — replaces the SVG TextGlyph that
              previously lived inside OverlaySvg. Sits ABOVE the SVG
              shapes (so text reads on top of background rects /
              highlights) and BELOW the TransformHandles (so handles
              still catch pointer events). Display + edit (visible div
              + invisible textarea) share `computeTextHtmlStyle` from
              @pwrsnap/shared so the rendered glyph is pixel-identical
              between the two surfaces. The export bake still goes
              through compose.ts textSvgForV2 (librsvg+SVG); a future
              PR will unify it too. */}
          <TextHtmlOverlays
            overlays={overlays}
            editingLayerId={
              draft?.kind === "text" && draft.editingId !== undefined
                ? draft.editingId
                : null
            }
            imageWidthPx={record.width_px}
            imageHeightPx={record.height_px}
            sourceWidthPx={sourceWidthPx}
            sourceHeightPx={sourceHeightPx}
            canvasCssHeight={canvasCssHeight}
            liveOverride={draftGeometry}
          />
          {/* Phase 3.5 — transform handles rendered on top of OverlaySvg
              so the selected overlay can be resized/moved via drag. The
              handles sit in their own absolute-positioned layer (HTML
              divs, not SVG) so they receive pointer events without
              fighting the OverlaySvg's pointer-events: none.
              `onGeometryDrag` fires on every pointermove so the parent
              can paint the selected glyph at the in-progress geometry
              (via `liveOverride` above) — without this, the painted
              glyph stays at its pre-drag position and the user only
              sees the handles + bbox outline move during the drag. */}
          {selectedOverlayForHandles !== null && (
            <TransformHandles
              selectedOverlay={selectedOverlayForHandles}
              imageWidthPx={record.width_px}
              imageHeightPx={record.height_px}
              sourceWidthPx={sourceWidthPx}
              sourceHeightPx={sourceHeightPx}
              onGeometryChange={onHandleGeometryChange}
              onGeometryDrag={onHandleGeometryDrag}
              onDragStart={onHandleDragStart}
              onDragEnd={onHandleDragEnd}
              onRequestEdit={onRequestEditOverlay}
            />
          )}
          {draft?.kind === "text" &&
            (() => {
              // Re-edit MUST mirror the persisted row, NOT the current
              // tool style — commitText only patches the body during
              // re-edit, so any tool-style derived size/color/weight
              // shown in the draft would visually disagree with the
              // row it's editing AND with the row after commit. Fresh-
              // placement (editingId undefined) falls through to the
              // tool style so the live preview matches what's about to
              // be persisted. All branching lives in
              // `resolveTextDraftStyle`; see text-draft-style.ts.
              const editingRow =
                draft.editingId !== undefined
                  ? overlays.find((o) => o.id === draft.editingId)
                  : undefined;
              const editingOverlay =
                editingRow !== undefined && editingRow.data.kind === "text"
                  ? { data: editingRow.data }
                  : null;
              const activeToolStyle =
                toolState.activeStyle.tool === "text"
                  ? toolState.activeStyle.style
                  : null;
              const { colorHex, size, weight, storedSizePx, rotation } =
                resolveTextDraftStyle({ editingOverlay, activeToolStyle });
              return (
                <TextDraftInput
                  draft={draft}
                  inputRef={textInputRef}
                  imageWidthPx={record.width_px}
                  imageHeightPx={record.height_px}
                  sourceWidthPx={sourceWidthPx}
                  sourceHeightPx={sourceHeightPx}
                  storedSizePx={storedSizePx}
                  canvasCssHeight={canvasCssHeight}
                  colorHex={colorHex}
                  size={size}
                  weight={weight}
                  rotation={rotation}
                  onChange={(body) => setDraft({ ...draft, body })}
                  onCommit={() => void commitText()}
                  onCancel={() => setDraft(null)}
                />
              );
            })()}
          {tool === "crop" && (
            <CropTool
              captureId={record.id}
              sourceWidth={record.width_px}
              sourceHeight={record.height_px}
              canvasRect={canvasRect}
              onCommit={onCropCommit}
              onCancel={onCropCancel}
            />
          )}
          {/* Matching-text affordance — only in standalone mode (the
              hook is dormant when controlled). Positioned relative to
              the canvas so the anchor coords (canvas-px) line up
              directly. */}
          {!isControlled && toolState.matchingText.kind === "available" && (
            <button
              type="button"
              className="pse-affordance"
              data-testid="matching-text-affordance"
              style={{
                position: "absolute",
                left: toolState.matchingText.anchorPoint.x,
                top: toolState.matchingText.anchorPoint.y + 8,
                transform: "translate(-50%, 0)"
              }}
              onClick={() => {
                toolState.clickMatchingTextAffordance();
              }}
            >
              + Add label
            </button>
          )}
        </div>
        {/* Phase 5 paste/drop notice. Surfaces user-friendly errors
            (v1-only, oversize, decode failure, symlink reject) for a
            short window. Auto-clears after 3.5s via the timer effect
            in the outer component. */}
        {pasteNotice !== null && (
          <div
            className={`pse-paste-notice is-${pasteNotice.tone}`}
            data-testid="paste-notice"
            role="status"
            aria-live="polite"
          >
            {pasteNotice.text}
          </div>
        )}
        {/* Right-click context menu over the canvas. Rendered as a
            sibling of `.editor-canvas` inside `.editor-canvas-wrap`
            so its absolute positioning (left/top set from anchorPx)
            is relative to the wrap — the outer Editor's
            `onContextMenu` computes anchorPx as
            `event.clientX/Y - wrapRect.left/top` so the math
            lines up.
            Lives in the same conditional structure as the paste
            notice — present only while `contextMenuState !== null`,
            torn down on close. */}
        {contextMenuState !== null && (
          <LayerContextMenu
            items={buildLayerContextMenuItems({
              selectedLayerIds,
              overlays
            })}
            anchorPx={contextMenuState.anchorPx}
            onClose={() => setContextMenuState(null)}
            onItemClick={(id) => {
              // Route the picked item to the same callback the
              // keyboard handler would dispatch. Closes the menu
              // synchronously regardless of action — picking an
              // item is a one-shot interaction.
              setContextMenuState(null);
              dispatchContextMenuItem(id);
            }}
          />
        )}
      </div>

      {chrome !== "chromeless" && (
        <EditorToolbar
          tool={tool}
          onChange={(next, options) => {
            // Toolbar click: also clear the double-tap shortcut latch
            // so a "click-then-press-key" sequence doesn't accidentally
            // count as a double-tap. `options.singleShot` carries the
            // ⌥-click escape hatch through to setTool → useEditorTool-
            // State so it actually arms single-shot for one placement.
            setTool(next, options);
            // Close popover on tool change.
            setPopoverOpen(false);
          }}
          appliedCount={overlays.length}
          canUndo={undo.canUndo}
          canRedo={undo.canRedo}
          zoom={{
            mode: zoom.mode,
            displayPct: zoom.displayPct,
            fitPct: zoom.fitPct,
            resetToFit: zoom.resetToFit,
            actualSize: zoom.actualSize,
            setCustomPct: zoom.setCustomPct,
            zoomBy: zoom.zoomBy
          }}
          onUndo={() => void undo.undo()}
          onRedo={() => void undo.redo()}
          onReveal={() => {
            void dispatch("capture:reveal", { captureId: record.id });
          }}
          // v2 wiring — only meaningful in standalone (chrome === "full");
          // EditorToolbar still works without these props for embedded
          // mode (no carets, no popover anchor wiring).
          enableStyleCaret={chrome === "full" && !isControlled}
          onCaretClick={(t) => {
            if (t === tool && isStyledToolKind(t)) {
              setPopoverOpen((prev) => !prev);
            }
          }}
          popoverAnchorRef={popoverAnchorRef}
          disabled={false}
        />
      )}

      {/* Popover anchored to the active styled tool's button. Re-mounted
          on tool change so the popover internals rebind to the new
          anchor + style shape.

          Phase 3.5 — when an overlay is selected, the popover switches
          to "selected-overlay" mode: it reads the style from the
          selected overlay's data (projected through
          selectedOverlayToToolStyle) and writes through
          onSelectedStyleFieldChange (which routes to
          dispatchEdit({kind: "updateOverlay"})). The header strip
          reads "Editing this <tool>" with an × to clear selection. */}
      {(() => {
        if (chrome !== "full" || isControlled || !popoverOpen) return null;
        // Selected-overlay mode takes precedence: if an overlay is
        // selected AND it maps to a styled tool, render that style.
        if (selectedOverlayForHandles !== null) {
          const projection = selectedOverlayToToolStyle(
            selectedOverlayForHandles.data,
            {
              arrow: toolState.activeStyle.tool === "arrow"
                ? toolState.activeStyle.style
                : { color: "accent", thickness: "auto", endStyle: "filled-triangle", stemStyle: "solid", doubleEnded: false },
              text: toolState.activeStyle.tool === "text"
                ? toolState.activeStyle.style
                : { color: "accent", fontSize: "auto", weight: "regular" },
              shape: toolState.activeStyle.tool === "shape"
                ? toolState.activeStyle.style
                : {
                    color: "accent",
                    thickness: "auto",
                    filled: false,
                    shape: "rect",
                    skewDeg: 15
                  },
              blur: toolState.activeStyle.tool === "blur"
                ? toolState.activeStyle.style
                : { mode: "gaussian", radius: { mode: "auto" } },
              highlight: toolState.activeStyle.tool === "highlight"
                ? toolState.activeStyle.style
                : { color: "yellow", opacity: 0.3, blend: "multiply" }
            }
          );
          if (projection === null) return null;
          const labelInfo = selectedOverlayToStyledTool(
            selectedOverlayForHandles.data
          );
          // pwrdrvr/PwrSnap#110: when the selected overlay is a text
          // with stored sizePx that doesn't match any bucket for the
          // CURRENT canvas, render the "Custom" indicator.
          // matchBucket returns null when off-bucket — that's the
          // Custom case. Legacy rows without sizePx skip this (matched
          // by the typeof check).
          let customTextSizeLabel: string | undefined;
          if (selectedOverlayForHandles.data.kind === "text") {
            const stored = selectedOverlayForHandles.data.sizePx;
            if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
              const match = matchBucket(stored, sourceWidthPx, sourceHeightPx);
              if (match === null) {
                customTextSizeLabel = `${Math.round(stored)} px`;
              }
            }
          }
          return (
            <ToolStylePopover
              anchorRef={popoverAnchorRef}
              tool={projection.tool}
              style={projection.style}
              onClose={() => setPopoverOpen(false)}
              onStyleFieldChange={(field, value) => {
                onSelectedStyleFieldChange(field, value);
              }}
              selectedOverlayLabel={labelInfo?.label ?? projection.tool}
              {...(customTextSizeLabel !== undefined
                ? { customTextSizeLabel }
                : {})}
              onClearSelection={() => {
                setSelectedLayerIds([]);
                setPopoverOpen(false);
              }}
            />
          );
        }
        // Active-tool mode (existing behavior).
        if (
          styledActiveTool === null ||
          toolState.activeStyle.tool !== styledActiveTool
        ) {
          return null;
        }
        return (
          <ToolStylePopover
            anchorRef={popoverAnchorRef}
            tool={styledActiveTool}
            style={
              // Discriminated narrowing: the guard above ensures
              // activeStyle.tool === styledActiveTool so `.style` is
              // present on the union member.
              (toolState.activeStyle as Extract<
                ActiveStyle,
                { tool: StyledToolKind }
              >).style
            }
            onClose={() => setPopoverOpen(false)}
            onStyleFieldChange={(field, value) => {
              // The popover's signature is (field, value); we close over
              // `styledActiveTool` to fan out to the hook's
              // (tool, field, value) shape. The runtime invariant is
              // that the popover only emits fields valid for its
              // current tool — the cast bridges the generic gap.
              (
                toolState.setStyleField as unknown as (
                  t: StyledToolKind,
                  f: string,
                  v: unknown
                ) => void
              )(styledActiveTool, field, value);
            }}
          />
        );
      })()}
    </div>
  );

  if (chrome !== "full") {
    return viewport;
  }

  // Standalone-window mode: wrap in EditorChrome and provide the four
  // right-sidebar panels. Library Focus + embedded modes don't get the
  // chrome — they're hosted inside the Library shell.
  return (
    <EditorChrome
      panels={{
        info: <InfoPanel captureId={record.id} />,
        chat: <ChatPanel captureId={record.id} />,
        toolConfig: (
          <ToolConfigPanel
            captureId={record.id}
            activeTool={isControlled ? tool : toolState.activeTool}
            activeStyle={
              isControlled
                ? // In controlled mode the hook stays at default
                  // "pointer" — but `chrome === "full"` is never
                  // controlled in current callers (Library uses
                  // chromeless). Defensive fallback only.
                  ({ tool: "pointer" } as ActiveStyle)
                : toolState.activeStyle
            }
            onStyleFieldChange={
              isControlled
                ? // Controlled mode has no hook to write into.
                  (<T extends StyledTool, K extends keyof StyleFor<T>>(
                    _tool: T,
                    _field: K,
                    _value: StyleFor<T>[K]
                  ): void => {
                    /* no-op */
                  })
                : toolState.setStyleField
            }
          />
        ),
        help: (
          <div className="pse-panel-stub" data-testid="panel-help-stub">
            <p>
              Editor shortcuts: V/A/S/H/B/T/C — tools · ⌘Z — undo · ⌘⇧Z — redo ·
              ⌘\ — toggle sidebar · ⌘1/⌘2/⌘3 — panels · ⌘+ / ⌘− — zoom · ⌘0 —
              fit · ⌘1 — actual size · Esc — cancel · ↵ — commit text/crop
            </p>
            <p>
              Tip: press a tool&apos;s shortcut twice in a row to open its
              style options.
            </p>
          </div>
        )
      }}
    >
      {viewport}
    </EditorChrome>
  );
}

// EditorToolbar: bottom-row toolbar attached to Editor's own chrome
// (full + embedded modes). The new <EditToolbar> at
// features/library/EditToolbar.tsx is a SEPARATE component used by
// Library's Stage component (chromeless Editor + floating bottom-
// center toolbar, Phase C). Renamed from `Toolbar` to avoid the
// name collision flagged by pattern-recognition-specialist.
//
// Phase 1 v2 wiring: when `enableStyleCaret` is true (standalone
// window in non-controlled mode), styled tools render a small ▾
// caret on the right edge of the button — click opens
// ToolStylePopover via `onCaretClick`. The caret is rendered as a
// nested <span> with role="button" (NOT a nested <button>) to keep
// the parent <button> the single focusable target; the click handler
// catches the caret event via target inspection.
function EditorToolbar({
  tool,
  onChange,
  appliedCount,
  canUndo,
  canRedo,
  zoom,
  onUndo,
  onRedo,
  onReveal,
  enableStyleCaret = false,
  onCaretClick,
  popoverAnchorRef,
  disabled = false
}: {
  tool: Tool;
  onChange: (t: Tool, options?: { singleShot?: boolean }) => void;
  appliedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  zoom: NonNullable<ZoomApi>;
  onUndo: () => void;
  onRedo: () => void;
  onReveal: () => void;
  enableStyleCaret?: boolean;
  onCaretClick?: (tool: Tool) => void;
  popoverAnchorRef?: React.MutableRefObject<HTMLElement | null>;
  /** When true, every tool / undo / redo button is disabled. Used by
   *  the Phase 3 v1 → v2 doctor wiring to lock out edits while the
   *  doctor is migrating or after it parks. ZoomMenu + Reveal stay
   *  enabled — they're navigation / debugging, not edits. */
  disabled?: boolean;
}) {
  return (
    <div
      className={
        "editor-toolbar" + (disabled ? " is-disabled" : "")
      }
      role="toolbar"
      aria-label="Annotation tools"
      aria-disabled={disabled ? "true" : undefined}
      data-testid="editor-toolbar"
    >
      <div className="editor-toolbar-tools">
        {TOOLS.map((t) => {
          const isActive = tool === t.id;
          const hasCaret = enableStyleCaret && STYLED_TOOLS.has(t.id);
          return (
            <button
              key={t.id}
              type="button"
              // data-testid is for E2E spec selectors only — added per
              // the v2 editor refresh task #11 (editor-tool-styles,
              // editor-sticky-tool specs). Stable identifier survives
              // label/icon refactors.
              data-testid={`editor-tool-button-${t.id}`}
              className={isActive ? "is-active" : ""}
              disabled={disabled}
              ref={
                isActive && popoverAnchorRef !== undefined
                  ? (el) => {
                      popoverAnchorRef.current = el;
                    }
                  : undefined
              }
              onClick={(e) => {
                // If the user clicked the caret glyph specifically, the
                // intent is "open the popover" — not "select the tool
                // again." Catch that by checking the event target.
                const tgt = e.target as HTMLElement | null;
                if (
                  hasCaret &&
                  tgt !== null &&
                  tgt.closest(".pse-tool-caret") !== null
                ) {
                  e.stopPropagation();
                  onCaretClick?.(t.id);
                  return;
                }
                // ⌥-click (Option on macOS / Alt elsewhere) flips this
                // tool into single-shot mode for one annotation — places
                // one and snaps back to Pointer. Lets a user override
                // sticky-tool mode on a per-click basis without leaving
                // the toolbar. See useEditorToolState `setActiveTool`
                // options + plan §"⌥-click toolbar tool → single-shot
                // mode (legacy behavior)".
                onChange(t.id, e.altKey ? { singleShot: true } : undefined);
              }}
              title={`${t.label} (${t.key})`}
            >
              <span className="editor-tool-key">{t.key}</span>
              <span>{t.label}</span>
              {hasCaret && isActive && (
                <span
                  className="pse-tool-caret"
                  role="button"
                  aria-label={`Open ${t.label} style options`}
                  data-testid={`tool-caret-${t.id}`}
                  // Stop the propagation here too so a stray pointerdown
                  // on the caret can't double-fire the select.
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    aria-hidden="true"
                    fill="currentColor"
                  >
                    <path d="M1 2.5 L4 5.5 L7 2.5 Z" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="editor-toolbar-meta">
        <span>
          {appliedCount} overlay{appliedCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          data-testid="editor-undo"
          disabled={disabled || !canUndo}
          onClick={onUndo}
          title="Undo (⌘Z)"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          data-testid="editor-redo"
          disabled={disabled || !canRedo}
          onClick={onRedo}
          title="Redo (⌘⇧Z)"
        >
          ↷ Redo
        </button>
        <ZoomMenu zoom={zoom} />
        <button type="button" onClick={onReveal} title="Reveal in Finder">
          Reveal
        </button>
      </div>
    </div>
  );
}
