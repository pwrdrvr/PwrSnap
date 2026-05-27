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
  RectToolStyle,
  Result,
  TextToolStyle,
  ToolSizePreset
} from "@pwrsnap/shared";
import {
  CURRENT_ARROW_STYLE_VERSION,
  DEFAULT_BLUR_STYLE,
  computeTextGlyphSize,
  matchBucket,
  readTextWeight
} from "@pwrsnap/shared";
import { dispatch, captureSrcUrl } from "../../lib/pwrsnap";
import { findRootGroupId, overlayToBundleLayerNode } from "./overlayToLayer";
import { computeEditorImageStyle } from "./editor-image-style";
import { resolveToolColor } from "./resolveToolColor";
import { TOOLS, type Tool } from "./editor-tools";
import { useZoomPan, type ZoomMode } from "./useZoomPan";
import { useUndoRedo, type InteractionToken } from "./useUndoRedo";
import {
  useCaptureModel,
  type EditOpResult,
  type GeometryUpdate,
  type LayerEditOp,
  type OverlayEditOp
} from "./useCaptureModel";
import { useEnsureV2, type EnsureV2State } from "./useEnsureV2";
import { V1ToV2DoctorBanner } from "./V1ToV2DoctorBanner";
import { OverlaySvg, TransformHandles, type DraftStyle } from "./OverlaySvg";
import { BlurOverlays } from "./BlurOverlays";
import { TextDraftInput } from "./TextDraftInput";
import { TextHtmlOverlays } from "./TextHtmlOverlays";
import { resolveTextDraftStyle } from "./text-draft-style";
import { ZoomMenu } from "./ZoomMenu";
import { CropTool } from "./CropTool";
import { EditorChrome } from "./EditorChrome";
import { ToolStylePopover, type StyledToolKind } from "./ToolStylePopover";
import { InfoPanel } from "./panels/InfoPanel";
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
  type DraftRect,
  type DraftText
} from "./editor-types";
import { usePasteImage, type PasteImagePosition } from "./usePasteImage";
import { useDropImage } from "./useDropImage";
import "./editor.css";

/** Three structural shapes for the editor:
 *
 *   • "full"       — standalone editor window: titlebar + bottom
 *                    toolbar, wrapped in <EditorChrome> (Phase 1 v2
 *                    refresh: activity bar + collapsible right panel).
 *                    Default when no chrome prop is passed.
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

const STYLED_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "arrow",
  "text",
  "rect",
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
    case "rect":
      return {
        color: resolveToolColor(activeStyle.style.color),
        thickness: activeStyle.style.thickness,
        filled: activeStyle.style.filled
      };
    case "highlight":
      return {
        color: resolveToolColor(activeStyle.style.color),
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
  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
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
    case "rect":
      return { tool: "rect", label: "rectangle" };
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
    rect: RectToolStyle;
    blur: BlurToolStyle;
    highlight: HighlightToolStyle;
  }
):
  | { tool: "arrow"; style: ArrowToolStyle }
  | { tool: "text"; style: TextToolStyle }
  | { tool: "rect"; style: RectToolStyle }
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
  if (data.kind === "rect") {
    return {
      tool: "rect",
      style: {
        ...defaults.rect,
        color: data.color ?? defaults.rect.color,
        thickness: data.thickness ?? defaults.rect.thickness,
        filled: data.filled ?? defaults.rect.filled
      }
    };
  }
  if (data.kind === "highlight") {
    return {
      tool: "highlight",
      style: {
        ...defaults.highlight,
        ...(data.color !== undefined ? { color: data.color } : {}),
        ...(data.opacity !== undefined ? { opacity: data.opacity } : {}),
        ...(data.blend !== undefined ? { blend: data.blend } : {})
      }
    };
  }
  if (data.kind === "blur") {
    return {
      tool: "blur",
      style: {
        ...defaults.blur,
        ...(data.style !== undefined ? { mode: data.style } : {})
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
 *  retires). Only `vector` and `effect` (blur) layers project — groups
 *  and rasters are skipped (no Phase 1 renderer surface for them). */
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
    if (layer.kind === "effect" && layer.effect.type === "blur") {
      // v2 blur effects clip to a `clip_rect` in absolute canvas
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
      rows.push({
        id: layer.id,
        capture_id: captureId,
        data: {
          kind: "blur",
          rect: {
            x: layer.clip_rect.x / dims.widthPx,
            y: layer.clip_rect.y / dims.heightPx,
            w: layer.clip_rect.w / dims.widthPx,
            h: layer.clip_rect.h / dims.heightPx
          },
          // Phase 3.4: read the v2 BlurEffect's `style` field (optional;
          // older v2 bundles without it fall back to DEFAULT_BLUR_STYLE
          // — same gaussian default the renderer always assumed).
          style: layer.effect.style ?? DEFAULT_BLUR_STYLE
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
    // group + raster + highlight-effect: no Phase 2 renderer surface.
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
 */
export function hitTestOverlays(
  overlays: OverlayRow[],
  xn: number,
  yn: number,
  canvasPxShortSide: number,
  /** Optional canvas + source pixel dims. When provided, text hit-
   *  testing uses the full bounding rectangle of the rendered glyph
   *  (matching the HTML wrapper's actual on-screen extent). When
   *  omitted (older test call sites), falls back to a tiny point-
   *  radius around the anchor — kept for backwards compat with the
   *  existing hitTestOverlays.test.ts that doesn't thread dims. */
  textDims?: {
    canvasWidthPx: number;
    canvasHeightPx: number;
    sourceWidthPx: number;
    sourceHeightPx: number;
  }
): string | null {
  // ~10px hit radius on a 1000px short-side canvas → 0.01 in
  // normalized coords. Scales inversely with size for a roughly
  // constant pixel tolerance.
  const hitRadiusN = Math.max(0.008, 10 / Math.max(1, canvasPxShortSide));
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const row = overlays[i];
    if (row === undefined) continue;
    const o = row.data;
    if (o.kind === "rect" || o.kind === "highlight" || o.kind === "blur") {
      if (
        xn >= o.rect.x &&
        xn <= o.rect.x + o.rect.w &&
        yn >= o.rect.y &&
        yn <= o.rect.y + o.rect.h
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
      // 0.65 char-advance is slightly wider than the 0.55 used in
      // textBoundsBox so the hit target reaches past the rendered
      // glyph's right edge (users pointing at characters near the
      // right side were misfiring on the empty space just past the
      // glyph). Width also has a floor of 1× fontSize so a 1-char
      // line still has a reasonable click target.
      const naturalWidthPx = Math.max(
        sizePx,
        maxChars * sizePx * 0.65
      );
      const naturalHeightPx = sizePx * lineCount;
      // Box centered vertically on the anchor (matches the HTML
      // wrapper's `translateY(-50%)` layout); left edge at anchor.x.
      const boxXn = o.point.x;
      const boxYn = o.point.y - naturalHeightPx / 2 / canvasHeightPx;
      const boxWn = naturalWidthPx / canvasWidthPx;
      const boxHn = naturalHeightPx / canvasHeightPx;
      // Add a small padding (half a hitRadius) on every edge so the
      // user can click slightly past the rendered glyph and still
      // land on the layer. Matches the affordance Cleanshot / Skitch
      // ship for text annotations.
      const padN = hitRadiusN * 0.5;
      if (
        xn >= boxXn - padN &&
        xn <= boxXn + boxWn + padN &&
        yn >= boxYn - padN &&
        yn <= boxYn + boxHn + padN
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
  onZoomChange
}: {
  captureId: string;
  /** Chrome shape — see `EditorChromeKind` above. Defaults to `"full"`
   *  (standalone editor window). */
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
   *  Editor's hook, so style choices don't stick" bug. The standalone
   *  Editor window leaves this undefined and keeps owning its own
   *  hook (its EditorChrome panels also need a single source of truth
   *  in-window). */
  toolState?: UseEditorToolStateReturn;
  /** Optional controlled blur-style state. When provided (Library
   *  mode), Library owns the v1-string-shaped blur mode and writes
   *  it back via the EditToolbar's hook-mirror effect (post-
   *  BlurMenu-fold the picker UI lives in the unified
   *  ToolStylePopover). When omitted (standalone window), the
   *  editor falls back to the `useEditorToolState` blur tool style
   *  block (which the right-sidebar ToolConfigPanel + popover edit). */
  blurStyle?: BlurStyle;
  /** Called whenever the editor's zoom state changes. Library uses
   *  this to render the zoom indicator in the floating EditToolbar
   *  (so the indicator doesn't float over the image). Called with
   *  `null` on unmount so the parent can clear its cached api. */
  onZoomChange?: (api: ZoomApi) => void;
}) {
  // ----- Capture data ---------------------------------------------
  //
  // Phase 2 v2 editor refresh — single hook owns both v1 and v2 reads
  // plus the cancel-safety dance + broadcast-driven refetch. The hook
  // returns a discriminated union (loading / loaded-v1 / loaded-v2 /
  // error); we project v2 layers back to OverlayRow[] for the existing
  // OverlaySvg / BlurOverlays render path (read-only — write paths
  // still go through overlays:upsert for v1; v2 writes are Phase 4-5).
  const model = useCaptureModel(captureId);

  // ----- v1 → v2 lazy doctor orchestration (Phase 3) --------------
  //
  // When the capture loads as v1, this hook fires `v1ToV2:upgrade` in
  // the background. While the doctor runs, we render the banner and
  // disable the toolbar. On success the doctor broadcasts
  // `events:captures:changed`, useCaptureModel re-fetches, and the
  // hook sees format >= 2 → flips to "irrelevant". On parking after
  // MAX_ATTEMPTS=5, the hook flips to "view_only" — the banner
  // surfaces a Retry button bound to ensureV2.retry().
  const currentBundleFormatVersion: number | null =
    model.kind === "loaded" ? model.record.bundle_format_version : null;
  const ensureV2 = useEnsureV2({ captureId, currentBundleFormatVersion });

  // ----- Tool + style state ---------------------------------------
  //
  // Two-mode source-of-truth:
  //
  //   • Controlled (Library Focus): `tool` + `onToolChange` props are
  //     both passed. Library is the single owner; per-tool style memory
  //     lives in the floating EditToolbar's own hook in task #10.
  //   • Standalone window (chrome === "full"): we own the hook here.
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
  // not lifted (standalone editor window), instantiate our own hook.
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

  const [draft, setDraft] = useState<Draft | null>(null);
  // Phase 3.2 — minimal selection model. Tracks the id of the
  // currently-selected overlay/layer; null means nothing selected.
  // Used to render a selection outline and to delete on backspace/
  // delete. Click on the pointer tool hit-tests against existing
  // overlays; click on empty canvas clears. Escape clears too.
  //
  // Out of scope (deferred to Phase 4): transform handles (move /
  // resize / rotate), color/style editing of the selected glyph,
  // multi-select. Just enough state for the user to clean up wrong
  // annotations without rebuilding the whole capture.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  // Mirror of the resolved overlay list, kept in a ref so
  // onPointerDown's hit-test reads the latest value without bouncing
  // through state. The list itself lives in the EditorLoaded child
  // (after the model resolves); we project a v1-shaped view of it
  // here for the synchronous click handler.
  const overlaysRef = useRef<OverlayRow[]>([]);
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
      const hit = hitTestOverlays(
        overlays,
        start.xn,
        start.yn,
        shortSide,
        textHitDimsRef.current ?? undefined
      );
      setSelectedLayerId(hit);
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
      const hit = hitTestOverlays(
        overlays,
        start.xn,
        start.yn,
        shortSide,
        textHitDimsRef.current ?? undefined
      );
      if (hit !== null) {
        setSelectedLayerId(hit);
        return;
      }
    }
    // Drawing a new annotation on empty canvas deselects any previous
    // selection so the outline doesn't linger on top of the new draft.
    if (selectedLayerId !== null) setSelectedLayerId(null);
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
    if (tool === "rect" || tool === "highlight" || tool === "blur") {
      setDraft({
        kind: "rect-drag",
        tool,
        startXn: start.xn,
        startYn: start.yn,
        curXn: start.xn,
        curYn: start.yn
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
    if (draft === null) return;
    if (draft.kind === "text") return;
    const cur = clientToNormalized(event.clientX, event.clientY);
    if (cur === null) return;
    if (draft.kind === "arrow") {
      setDraft({ ...draft, toXn: cur.xn, toYn: cur.yn });
      return;
    }
    if (draft.kind === "rect-drag") {
      setDraft({ ...draft, curXn: cur.xn, curYn: cur.yn });
      return;
    }
  }

  async function onPointerUp(event: React.PointerEvent<HTMLDivElement>): Promise<void> {
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
      if (wrote && !isControlled) {
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

    if (draft.kind === "rect-drag") {
      const rect = rectFromDrag(draft);
      if (rect === null) {
        setDraft(null);
        closeInteraction();
        return;
      }
      const placedKind = draft.tool;
      // Phase 3.1 fix #2: thread the active style into rect / highlight
      // / blur overlays. Pre-fix, rect + highlight dropped everything
      // to defaults regardless of popover choices.
      let overlay: Overlay;
      if (placedKind === "rect") {
        const rectStyleSrc =
          effectiveToolState.activeStyle.tool === "rect"
            ? effectiveToolState.activeStyle.style
            : null;
        const rectOverlay: Extract<Overlay, { kind: "rect" }> = {
          kind: "rect",
          rect,
          color:
            rectStyleSrc !== null
              ? resolveToolColor(rectStyleSrc.color)
              : "auto"
        };
        if (rectStyleSrc !== null) {
          rectOverlay.thickness = rectStyleSrc.thickness;
          rectOverlay.filled = rectStyleSrc.filled;
        }
        overlay = rectOverlay;
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
        // blur — already threaded via the `blurStyle` memo at the
        // top of this function, so this branch was correct pre-fix.
        overlay = { kind: "blur", rect, style: blurStyle };
      }
      setDraft(null);
      const wrote = await persistOverlay(overlay);
      closeInteraction();
      if (wrote && !isControlled) {
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
   * Routes through `model.dispatchEdit` so v1 + v2 write paths land
   * in one place — the dispatcher picks `overlays:upsert` or
   * `layers:upsert` based on `bundle_format_version`. The v2 branch
   * runs `overlayToBundleLayerNode` to project the renderer's
   * Overlay shape into a BundleLayerNode, then routes through
   * dispatchEdit's `{ kind: "upsert", node }` op.
   *
   * Undo records for BOTH formats now — earlier the v2 path skipped
   * recordCreate because useUndoRedo dispatched `overlays:*` directly
   * (which v2 captures refuse). The undo hook now routes through
   * dispatchEdit too, so the v2 inverse (`layers:delete` /
   * `layers:upsert`) lands without the v2-guard refusal.
   */
  async function persistOverlay(overlay: Overlay): Promise<boolean> {
    // Snapshot the model at call time. The model branch is the only
    // thing we read; subsequent state changes (e.g. a captures:changed
    // broadcast) re-render but don't race this in-flight write — the
    // result is recorded on the same model.
    if (model.kind !== "loaded") {
      // No record yet — drop the write. Shouldn't happen since the
      // editor wraps EditorLoaded inside a model.kind === "loaded"
      // guard, but be defensive.
      return false;
    }
    if (model.format === 2) {
      // v2 path: adapt the Overlay → BundleLayerNode + route through
      // dispatchEdit. The adapter still refuses crop here — crop
      // takes the dispatchEdit `{ kind: "crop" }` path via
      // onCropCommit, not persistOverlay.
      const adapted = overlayToBundleLayerNode(
        overlay,
        { width: model.record.width_px, height: model.record.height_px },
        findRootGroupId(model.layers)
      );
      if (!adapted.ok) {
        // eslint-disable-next-line no-console
        console.error("overlayToBundleLayerNode failed", adapted.error);
        return false;
      }
      const result = await model.dispatchEdit({
        kind: "upsert",
        node: adapted.layer
      });
      if (!result.ok) {
        // eslint-disable-next-line no-console
        console.error("layers:upsert via dispatchEdit failed", result.error);
        return false;
      }
      if (!undoApplyingRef.current && result.value.kind === "upsert") {
        const artifact = result.value.artifact;
        if (artifact.format === 2) {
          // Pass the inserted layer node so undo→redo can re-insert
          // the structurally-identical layer via layers:upsert. The
          // synthetic OverlayRow gives the v1-shaped recorder a
          // working .id for the delete-side of undo (matches the
          // layer's id since the v2-to-row projection in
          // projectV2LayersToOverlayRows uses layer.id as row.id).
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
          recordCreateRef.current?.(syntheticRow, { node: artifact.node });
        }
      }
      return true;
    }

    // v1 path — same dispatchEdit indirection. The synthesized
    // OverlayRow comes back from the dispatcher (v1 captures persist
    // OverlayRows verbatim). Behavior identical to the pre-refactor
    // path; the only diff is the call goes through model.dispatchEdit.
    // Need a placeholder OverlayRow to pass into the dispatcher — the
    // v1 dispatcher only reads `op.row.data`, so a minimal shape is
    // enough. The REAL row id comes back in the artifact.
    const placeholderRow: OverlayRow = {
      id: "",
      capture_id: captureId,
      data: overlay,
      schema_version: 1,
      source: "user",
      ai_run_id: null,
      z_index: 0,
      rejected_at: null,
      applied_at: null,
      superseded_by: null,
      created_at: new Date().toISOString()
    };
    const result = await model.dispatchEdit({
      kind: "upsert",
      row: placeholderRow
    });
    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.error("overlays:upsert via dispatchEdit failed", result.error);
      return false;
    }
    if (!undoApplyingRef.current && result.value.kind === "upsert") {
      const artifact = result.value.artifact;
      if (artifact.format === 1) {
        recordCreateRef.current?.(artifact.row, { node: null });
      }
    }
    // events:overlays:changed broadcast triggers refetch.
    return true;
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
    // For v2 captures the source dims come from the raster layer's
    // natural_*_px. For v1, the model doesn't carry separate source
    // dims; fall back to record dims (= canvas dims = source dims
    // for v1 since v1 crops don't shrink the canvas record).
    let placementSourceW = model.record.width_px;
    let placementSourceH = model.record.height_px;
    if (model.format === 2) {
      for (const layer of model.layers) {
        if (layer.kind === "raster" && layer.parent_id !== null) {
          placementSourceW = layer.natural_width_px;
          placementSourceH = layer.natural_height_px;
          break;
        }
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
      await dispatchEditErased({
        kind: "updateOverlay",
        layerId: editingId,
        patch: { kind: "text", body }
      });
      return;
    }
    const wrote = await persistOverlay(overlay);
    if (wrote && !isControlled) {
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
      setSelectedLayerId(null);
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
      // Don't interpret as a tool shortcut when text input has focus.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (target?.isContentEditable === true) return;
      // Phase 3.2 selection: Escape clears the selection (when not
      // mid-draft — that case was handled above). Delete / Backspace
      // soft-deletes the selected overlay. We route through the
      // overlays:delete IPC for v1; v2 layers use layers:delete.
      // Branching on bundle_format_version lives in the deletion
      // helper below (set up in EditorLoaded which has the record).
      if (event.key === "Escape" && selectedLayerId !== null) {
        event.preventDefault();
        setSelectedLayerId(null);
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedLayerId !== null
      ) {
        event.preventDefault();
        const id = selectedLayerId;
        setSelectedLayerId(null);
        deleteSelectedRef.current?.(id);
        return;
      }
      // Modifier presses (⌘/⌃/⌥) belong to other handlers — don't eat
      // ⌘A or similar as the arrow shortcut.
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, isControlled, selectedLayerId, setTool, tool]);

  // Hook-owned deleter (populated by EditorLoaded once it knows the
  // bundle format). Like recordCreateRef, this lives in the outer
  // function because the keyboard handler is here but the model
  // resolution + format branching lives in the child.
  const deleteSelectedRef = useRef<((id: string) => void) | null>(null);

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

  // Resolve OverlayRow[] for the existing renderer code path. v1 hands
  // back overlays natively. v2 projects layer nodes back to OverlayRow
  // shape (read-only — vector + blur-effect cover Phase 2 surface).
  const overlaysForRender: OverlayRow[] =
    model.format === 1
      ? model.overlays
      : projectV2LayersToOverlayRows(model.layers, captureId, {
          widthPx: model.record.width_px,
          heightPx: model.record.height_px
        });
  // Sync the synchronous-read ref the outer pointerdown handler reads.
  // Render-phase write to a ref is safe (refs don't trigger renders);
  // we deliberately do this before returning EditorLoaded so a click
  // landing in the same commit reads the up-to-date overlay list.
  overlaysRef.current = overlaysForRender;
  // `textHitDimsRef` is populated lower in this render — after
  // `sourceWidthPx` / `sourceHeightPx` are resolved via the raster-
  // layer scan below. See the assignment near `return <EditorLoaded
  // ... />`.
  // Clear stale selection when the selected overlay is no longer in
  // the list (e.g. another window deleted it via the events:overlays:
  // changed broadcast, or the capture switched).
  if (
    selectedLayerId !== null &&
    overlaysForRender.find((r) => r.id === selectedLayerId) === undefined
  ) {
    // Schedule via microtask so we don't setState during render.
    queueMicrotask(() => setSelectedLayerId(null));
  }

  // Type-erase dispatchEdit so EditorLoaded doesn't carry the format
  // discriminant in its prop type. The hook itself reads
  // `bundle_format_version` at dispatch time via its closure over
  // `state`, so the runtime branch is correct regardless of which
  // typed entry we hand over.
  const dispatchEditErased = model.dispatchEdit as (
    op: OverlayEditOp | LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;

  // Source raster natural dims — separate from the capture's
  // `width_px`/`height_px` which are the CANVAS (cropped) dims for v2.
  // Without this, the editor's <img> would scale the full source into
  // the cropped canvas box, hiding the crop visually (aspect-preserved
  // squash looks identical at auto-fit zoom — real user hit exactly
  // this on 8nnmKLuUpBI4K8fl).
  //
  // v1: there's no separate source vs canvas — record dims ARE source
  // dims. Crop in v1 writes a CropOverlay; the bake honors it but the
  // editor's source-PNG URL stays full-size. v1 didn't have this
  // problem because v1 captures don't change their record dims on crop.
  //
  // v2: scan model.layers for the root raster's natural dims. The
  // doctor + native-create paths always seed exactly one raster at
  // canvas-fits-source dims. Fall back to record dims if we can't find
  // one (shouldn't happen for a healthy v2 capture).
  let sourceWidthPx = model.record.width_px;
  let sourceHeightPx = model.record.height_px;
  // Off-origin v2 crops translate the raster layer's transform by
  // (-rect.x × oldW, -rect.y × oldH) so the (smaller) canvas displays
  // the user's chosen region of the source. Read those translation
  // components here so the editor's <img> can mirror the offset via
  // CSS transform. Identity (0, 0) for uncropped + edge-aligned
  // crops + v1 captures (no layer tree). See pwrdrvr/PwrSnap#110 and
  // useCaptureModel.ts's `Step 0.5: translate every raster layer's
  // transform...` for the dispatcher side of this contract.
  let rasterTranslateXPx = 0;
  let rasterTranslateYPx = 0;
  if (model.format === 2) {
    for (const layer of model.layers) {
      if (layer.kind === "raster" && layer.parent_id !== null) {
        sourceWidthPx = layer.natural_width_px;
        sourceHeightPx = layer.natural_height_px;
        // transform[4] = tx, transform[5] = ty, both in source-pixel units.
        rasterTranslateXPx = layer.transform[4];
        rasterTranslateYPx = layer.transform[5];
        break;
      }
    }
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
      beginInteractionRef={beginInteractionRef}
      endInteractionRef={endInteractionRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      commitText={commitText}
      onZoomChange={onZoomChange}
      blurStyle={blurStyle}
      isControlled={isControlled}
      toolState={effectiveToolState}
      openActivePopoverRef={openActivePopoverRef}
      ensureV2State={ensureV2.state}
      onEnsureV2Retry={ensureV2.retry}
      selectedLayerId={selectedLayerId}
      setSelectedLayerId={setSelectedLayerId}
      deleteSelectedRef={deleteSelectedRef}
      modelFormat={model.format}
      dispatchEdit={dispatchEditErased}
      sourceWidthPx={sourceWidthPx}
      sourceHeightPx={sourceHeightPx}
      rasterTranslateXPx={rasterTranslateXPx}
      rasterTranslateYPx={rasterTranslateYPx}
      onRequestEditOverlay={onRequestEditOverlay}
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
  beginInteractionRef,
  endInteractionRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  commitText,
  onZoomChange,
  blurStyle,
  isControlled,
  toolState,
  openActivePopoverRef,
  ensureV2State,
  onEnsureV2Retry,
  selectedLayerId,
  setSelectedLayerId,
  deleteSelectedRef,
  modelFormat,
  dispatchEdit,
  sourceWidthPx,
  sourceHeightPx,
  rasterTranslateXPx,
  rasterTranslateYPx,
  onRequestEditOverlay
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
  commitText: () => Promise<void>;
  onZoomChange: ((api: ZoomApi) => void) | undefined;
  blurStyle: BlurStyle;
  isControlled: boolean;
  toolState: ReturnType<typeof useEditorToolState>;
  openActivePopoverRef: React.RefObject<(() => void) | null>;
  /** v1 → v2 doctor state from `useEnsureV2`. While the doctor is
   *  upgrading (or has parked), the toolbar is disabled and the
   *  V1ToV2DoctorBanner renders over the canvas. */
  ensureV2State: EnsureV2State;
  /** Bound to the Retry button on the view-only banner. */
  onEnsureV2Retry: () => void;
  /** Phase 3.2 selection model — id of the currently-selected overlay,
   *  null if nothing selected. Drives the selection outline glyph in
   *  OverlaySvg. */
  selectedLayerId: string | null;
  /** Phase 3.5 — geometry/style updates land as delete-plus-insert
   *  (id changes on every cycle). EditorLoaded reads this setter to
   *  re-anchor the selection on the new id after a successful
   *  updateGeometry / updateOverlay dispatch. */
  setSelectedLayerId: (id: string | null) => void;
  /** Outer Editor's keyboard handler reads this for Delete/Backspace.
   *  EditorLoaded populates it with a format-aware deleter (v1 →
   *  overlays:delete, v2 → layers:delete). */
  deleteSelectedRef: React.RefObject<((id: string) => void) | null>;
  /** Resolved bundle format from the model (1 or 2). EditorLoaded uses
   *  it to branch overlay-delete IPC selection. */
  modelFormat: 1 | 2;
  /** Type-erased dispatchEdit from the resolved CaptureModel. EditorLoaded
   *  threads it into useUndoRedo (so undo/redo route through the same
   *  format-aware dispatcher as create writes) and into onCropCommit
   *  (so v2 captures use bundle:updateCanvasDimensions). */
  dispatchEdit: (
    op: OverlayEditOp | LayerEditOp
  ) => Promise<Result<EditOpResult, PwrSnapError>>;
  /** Source raster's natural dimensions, distinct from the capture's
   *  `width_px`/`height_px` which are the CANVAS (cropped) dims for v2.
   *  Editor's <img> renders at source dims; canvas wrap clips to canvas
   *  dims so the crop is visually reflected. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Raster layer's transform translation in source-pixel units —
   *  drives the off-origin crop view (pwrdrvr/PwrSnap#110). Zero
   *  for uncropped captures, edge-aligned crops, and v1 captures. */
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
  /** Phase 3.6 — caller-provided handler for double-click on a TEXT
   *  overlay. Opens the draft input pre-filled with the existing
   *  body; commit replaces the overlay's body rather than creating
   *  a new one. */
  onRequestEditOverlay: (overlay: OverlayRow) => void;
}) {
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
    dispatchEdit
  });

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
    deleteSelectedRef.current = (id: string): void => {
      void dispatchEdit({ kind: "delete", id });
    };
    return () => {
      deleteSelectedRef.current = null;
    };
  }, [deleteSelectedRef, dispatchEdit]);

  // ----- Phase 3.5: transform handles + selected-style editing -----
  //
  // Resolve the currently-selected overlay row for the handles.
  const selectedOverlayForHandles: OverlayRow | null =
    selectedLayerId === null
      ? null
      : overlays.find((r) => r.id === selectedLayerId) ?? null;

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
  const [draftGeometry, setDraftGeometry] = useState<
    { layerId: string; geometry: GeometryUpdate } | null
  >(null);

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
      // the id from the pre-drag snapshot rather than selectedLayerId
      // so a stray selection-change broadcast mid-drag can't repoint
      // the override at the wrong row.
      const preDrag = preDragRef.current;
      if (preDrag === null) return;
      setDraftGeometry({ layerId: preDrag.id, geometry });
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
        const newId =
          artifact.format === 1 ? artifact.row.id : artifact.node.id;
        // Re-anchor the selection on the new id so the handles + the
        // selection outline follow the freshly-inserted row.
        setSelectedLayerId(newId);
        // Drop the live override now that the new row id is known.
        // The events:overlays:changed (or v2's events:layers:changed)
        // broadcast refetches the row list with the persisted
        // geometry, so the override is no longer load-bearing.
        // Clearing here avoids a brief flash where the override
        // (keyed by the OLD id) lingers against a list that no
        // longer contains that row.
        setDraftGeometry(null);
        // Record on the undo stack — capture both the PRE and POST
        // geometry, with a chain-id ref so subsequent undo/redo cycles
        // can track the new ids.
        if (!undoApplyingRef.current) {
          const previousGeometry = overlayDataToGeometry(preDrag.data);
          if (previousGeometry !== null) {
            undo.recordGeometry({
              currentIdRef: { current: newId },
              previousGeometry,
              nextGeometry: geometry
            });
          }
        }
      })();
    },
    [dispatchEdit, setSelectedLayerId, undo, undoApplyingRef]
  );

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
        const newId =
          artifact.format === 1 ? artifact.row.id : artifact.node.id;
        setSelectedLayerId(newId);
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
    [dispatchEdit, selectedOverlayForHandles, setSelectedLayerId, undo, undoApplyingRef]
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

  // -------------------- Phase 5 paste/drop image as raster layer ---
  //
  // Multi-image paste + Finder drop. v2 captures only. ⌘V on the canvas
  // routes through usePasteImage; HTML5 drag-drop on the canvas-wrap
  // routes through useDropImage. Both surface a transient notice on
  // success/failure via `pasteNotice` state; v1 captures get a
  // friendly "Only v2 captures support multi-image" message rather
  // than a silent no-op.
  //
  // The "Pasting…" affordance is positioned by `pastingAt` (canvas-px
  // coords). Cleared when the dispatch resolves or rejects.
  const [pastingAt, setPastingAt] =
    useState<PasteImagePosition | null>(null);
  const [pasteNotice, setPasteNotice] =
    useState<{ text: string; tone: "error" | "info" } | null>(null);
  // Auto-clear the notice after a short window so it doesn't linger.
  useEffect(() => {
    if (pasteNotice === null) return;
    const timer = setTimeout(() => setPasteNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [pasteNotice]);

  const formatPasteError = useCallback((error: { code: string; message: string }): string => {
    // Map a handful of bus codes to user-friendly copy; fall back to
    // the raw message for unrecognized codes (defensive against a
    // future code we haven't surfaced yet).
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

  const paste = usePasteImage({
    captureId: record.id,
    bundleFormatVersion: record.bundle_format_version,
    onPastingChange: setPastingAt,
    onError: (error) => {
      setPasteNotice({ text: formatPasteError(error), tone: "error" });
    }
  });

  const drop = useDropImage({
    captureId: record.id,
    bundleFormatVersion: record.bundle_format_version,
    canvasEl: canvasRef.current,
    onError: (error) => {
      setPasteNotice({ text: formatPasteError(error), tone: "error" });
    }
  });

  // Bind ⌘V on the document. We're already inside the editor's
  // keyboard event chain (the outer Editor function handles tool
  // shortcuts), but those handlers explicitly skip ⌘-modified keys.
  // Adding a dedicated listener here keeps the paste path independent
  // of the tool-shortcut handler.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // ⌘V (macOS) / Ctrl+V (others). Both modifiers in the same
      // condition because Electron normalizes macOS Command to metaKey.
      if (e.key !== "v") return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      // Don't hijack ⌘V from text inputs / contenteditable elements —
      // the user is pasting into a text field, not the canvas.
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      ) {
        return;
      }
      e.preventDefault();
      // Default position: canvas center. The keyboard-triggered path
      // doesn't have a click point.
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
      void paste.pasteFromClipboard(position);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paste, canvasRef]);

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
          data-tool={tool}
        >
          {/* Phase 3.6 — the <img> is sized so the SOURCE raster's
              natural pixels map 1:1 to canvas CSS pixels regardless of
              the current Fit/Actual/custom zoom level. The trick is to
              size the img to `(source / canvas) × 100%` of its parent
              and let the default object-fit (fill) scale the image
              content to that box. The parent `.editor-canvas` clips
              via `overflow: hidden`.

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
          <img
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
          {/* HTML blur layer between the <img> and the SVG so
              backdrop-filter on each blur rect actually obscures
              the image behind. Lives separately from OverlaySvg
              because SVG <filter> can blur SVG content but not a
              sibling raster <img>. */}
          <BlurOverlays
            overlays={overlays}
            draft={draft}
            blurStyle={blurStyle}
            liveOverride={draftGeometry}
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
            selectedLayerId={selectedLayerId}
            editingLayerId={
              draft?.kind === "text" && draft.editingId !== undefined
                ? draft.editingId
                : null
            }
            liveOverride={draftGeometry}
          />
          {/* HTML-text overlay layer — replaces the SVG TextGlyph that
              previously lived inside OverlaySvg. Sits ABOVE the SVG
              shapes (so text reads on top of background rects /
              highlights) and BELOW the TransformHandles (so handles
              still catch pointer events). Display + edit (textarea)
              + bake (hidden BrowserWindow → PNG) all share
              `computeTextHtmlStyle` from @pwrsnap/shared, so the
              rendered glyph is pixel-identical across every surface
              the user sees. */}
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
              const { colorHex, size, weight, storedSizePx } =
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
          {/* Phase 5 "Pasting…" affordance. Lives at the click point
              while the worker decodes + writes. Auto-clears when the
              dispatch resolves. */}
          {pastingAt !== null && (
            <div
              className="pse-pasting-affordance"
              data-testid="paste-pasting-affordance"
              style={{
                position: "absolute",
                left: pastingAt.canvasPx.x,
                top: pastingAt.canvasPx.y,
                transform: "translate(-50%, -50%)"
              }}
            >
              Pasting…
            </div>
          )}
        </div>
        {/* v1 → v2 lazy doctor banner. Anchored to the canvas-wrap so
            it overlays the editor canvas; returns null in
            irrelevant/ready states. */}
        <V1ToV2DoctorBanner
          state={ensureV2State}
          onRetry={onEnsureV2Retry}
        />
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
          // Disable while the v1 → v2 doctor is running or has parked
          // (Phase 3) — annotations on a v1 capture mid-migration
          // would conflict with the doctor's atomic write ordering,
          // and a parked capture is read-only by design until Retry.
          disabled={
            ensureV2State.status === "upgrading" ||
            ensureV2State.status === "view_only"
          }
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
              rect: toolState.activeStyle.tool === "rect"
                ? toolState.activeStyle.style
                : { color: "accent", thickness: "auto", filled: false },
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
                setSelectedLayerId(null);
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
        chat: (
          <div className="pse-panel-stub" data-testid="panel-chat-stub">
            Chat with AI lands in Phase 7.
          </div>
        ),
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
              Editor shortcuts: V/A/R/H/B/T/C — tools · ⌘Z — undo · ⌘⇧Z — redo ·
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
