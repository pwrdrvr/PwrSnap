// Editor canvas overlay layer — single <svg> with a PIXEL-SPACE
// viewBox (`0 0 imageWidthPx imageHeightPx`) that renders every
// committed overlay PLUS the live-drag draft on top. The overlay
// schema stores coordinates in normalized [0,1]² space (so the same
// row can be baked at any resolution by compose.ts); this component
// multiplies by the image dims at render so all geometry lands in
// pixel units inside the SVG.
//
// Why pixel-space, not viewBox="0 0 1 1" + preserveAspectRatio="none":
// the non-uniform stretch from a 1×1 viewBox to a non-square canvas
// SKEWS strokes (the stroke perpendicular is no longer perpendicular
// to the visible line) and turns round line caps into ellipses
// oriented along the image's aspect ratio, not the line. On a tall
// image, diagonal arrows show a vertical "fang" at the tail and the
// arrow tip's halo fringes asymmetrically. Pixel-space viewBox keeps
// the coordinate system isotropic, mirrors compose.ts (which already
// uses pixel-space SVG buffers), and eliminates an entire class of
// "live editor diverges from baked thumbnail" bugs.
//
// Extracted from Editor.tsx as part of the v1 polish round so the
// Editor file itself stays focused on state/handlers/effects.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type {
  ArrowEndStyle,
  ArrowStemStyle,
  OverlayRow,
  OverlayThickness,
  ShapeKind
} from "@pwrsnap/shared";
import {
  CURRENT_ARROW_STYLE_VERSION,
  computeArrowGeometry,
  computeStemDashArray,
  DEFAULT_PARALLELOGRAM_SKEW_DEG,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle,
  readHighlightColor,
  readHighlightOpacity,
  readOverlayRotation,
  readOverlayThickness,
  readShapeFilled,
  readShapeKind,
  readShapeSkewDeg,
  readTextWeight
} from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import type { GeometryUpdate, NormalizedPoint, NormalizedRect } from "./useCaptureModel";
import { applyGeometryLocally } from "./geometry-projection";
import { shapeStrokeGeometry } from "./shape-stroke-geometry";
import { computeTextGlyphSize } from "@pwrsnap/shared";
import { TEXT_BBOX_CHAR_ADVANCE_OUTLINE } from "./text-bbox-constants";
import { measureTextWidthPx } from "./text-measure";
import {
  useGlyphSize,
  type MeasuredGlyphSize
} from "./text-measure-registry";

/** Phase 3.3 — draft style overrides threaded from `useEditorToolState`.
 *  When the user picks "red" for the arrow tool, the draft preview
 *  should render in red DURING the drag (not just on commit). Editor.tsx
 *  reads `effectiveToolState.activeStyle` and passes the relevant slice
 *  here so the OverlaySvg renders the draft with the picked style.
 *  Persisted overlays read their own `data.color` etc.; this prop only
 *  affects the live-draft branch. */
export interface DraftStyle {
  /** Color slug or hex — matches the OverlaySchema `color` field. */
  color?: "auto" | string;
  /** Arrow head glyph style for the live-drag preview. */
  endStyle?: ArrowEndStyle;
  /** Arrow stem stroke style for the live-drag preview. */
  stemStyle?: ArrowStemStyle;
  /** When true, the live-drag preview renders the end glyph at both
   *  endpoints (mirrored at the tail). */
  doubleEnded?: boolean;
  /** Optional thickness preset / fraction. Same mapping as the
   *  persisted overlay field — see `readOverlayThickness`. */
  thickness?: OverlayThickness;
  /** Shape-tool only — render the live-drag shape as a solid fill
   *  rather than a stroke-only outline. */
  filled?: boolean;
  /** Shape-tool only — which geometric primitive to render for the
   *  live-drag preview (rect / square / circle / oval / parallelogram).
   *  Defaults to "rect" when undefined. */
  shape?: ShapeKind;
  /** Shape-tool only — horizontal skew (degrees) for parallelogram.
   *  Ignored for every other shape kind. */
  skewDeg?: number;
  /** Highlight-tool only — CSS mix-blend-mode for the live-drag
   *  preview. Mirrors the persisted overlay's `blend` field. */
  highlightBlend?: "multiply" | "screen" | "overlay";
  /** Highlight-tool only — opacity for the live-drag preview. Mirrors
   *  the persisted overlay's `opacity` field so the drag preview and
   *  committed glyph do not jump on pointerup. */
  highlightOpacity?: number;
}

export function OverlaySvg({
  overlays,
  draft,
  draftStyle,
  imageWidthPx,
  imageHeightPx,
  sourceWidthPx,
  sourceHeightPx,
  selectedLayerIds = [],
  selectedRasterBoxesN = [],
  liveOverride = null
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  /** Explicitly `| undefined` (not just `?`) so callers can pass the
   *  helper's result directly under `exactOptionalPropertyTypes`. */
  draftStyle?: DraftStyle | undefined;
  /** CANVAS dims — `record.width_px` / `record.height_px`. Drive
   *  viewBox-relative measurements and overlay coord mapping. */
  imageWidthPx: number;
  imageHeightPx: number;
  /** SOURCE raster dims — raster layer's `natural_*_px`. Used by
   *  `textBoundsBox` + `SelectionOutline` via `computeTextGlyphSize`
   *  so text overlays don't silently resize after a v2 crop
   *  (pwrdrvr/PwrSnap#110). v1 callers pass canvas dims (no separate
   *  source). */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Multi-select model — ids of every currently-selected overlay.
   *  Empty array means nothing selected. One 1px accent-colored
   *  outline glyph is drawn over each selected overlay's bounding box
   *  so the user can see what they've selected and confirm before
   *  Delete/Backspace. Defaults to `[]` so existing tests that don't
   *  pass the prop keep working. */
  selectedLayerIds?: readonly string[];
  /** Selected NON-BASE raster layers' normalized bounding boxes
   *  (pasted images / captured cursor). Rasters live outside the
   *  OverlayRow projection, so the editor computes each selected
   *  raster's box (rasterLayerBoundsN, draft-override-aware) and
   *  passes it here to get the SAME dashed selection chrome as
   *  every other layer kind — one visual language for "selected". */
  selectedRasterBoxesN?: readonly {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
  /** Live-drag geometry override. When set, the row whose id matches
   *  `id` IS A KEY in the map is rendered with the overridden
   *  geometry instead of its persisted `data.*` fields — so e.g.
   *  an arrow's endpoint visibly follows the cursor during a
   *  TransformHandles drag, rather than staying at its old position
   *  until pointerup commits. Cleared by the parent on drag end.
   *  The selection outline also follows the override (drawn from
   *  the overridden box).
   *
   *  Map shape (vs the previous single-id object) so multi-drag —
   *  the gesture that translates an entire multi-selection in one
   *  go — can paint N concurrent previews through the same renderer
   *  contract. Single-select drags pass a 1-entry map; the kind-
   *  bucket projections below don't care about the cardinality. */
  liveOverride?: ReadonlyMap<string, GeometryUpdate> | null;
}): ReactElement {
  // Blur overlays render outside this SVG via <BlurOverlays> — HTML
  // divs with backdrop-filter, so the live preview ACTUALLY blurs
  // the underlying image. SVG <filter> can blur SVG content but
  // can't reach behind itself to blur a sibling <img>.
  //
  // viewBox in pixel space so 1 SVG unit = 1 image pixel — strokes
  // and round caps stay isotropic regardless of the image's aspect.
  // The SVG element is sized via CSS to fill the editor-canvas
  // (which itself has the image's aspect-ratio), so the default
  // preserveAspectRatio="xMidYMid meet" fits the viewBox exactly
  // into the rendered area without distortion.
  const viewBox = `0 0 ${imageWidthPx} ${imageHeightPx}`;
  // Project the live-drag override (if any) onto the matching row's
  // `data`. Every downstream split reads from `effectiveOverlays`
  // so the override participates uniformly in the kind-buckets and
  // the selection outline below. TransformHandles fires
  // `onGeometryDrag` on every pointermove, the parent stashes the
  // result here, and the painted glyph follows the cursor — without
  // this the underlying arrow / rect stays at its pre-drag position
  // and the user sees "the line vanishes" until pointerup.
  const effectiveOverlays = useMemo(() => {
    if (liveOverride === null || liveOverride.size === 0) return overlays;
    return overlays.map((row) => {
      const geom = liveOverride.get(row.id);
      if (geom === undefined) return row;
      const merged = applyGeometryLocally(row.data, geom);
      if (merged === null) return row;
      return { ...row, data: merged };
    });
  }, [liveOverride, overlays]);
  // Pre-fix this file kept three useMemo'd kind buckets (arrows,
  // rects, highlights) and rendered them in fixed order. The unified
  // single-map paint loop below reads `effectiveOverlays` directly
  // and branches on `data.kind` per row — same memoization benefit
  // (effectiveOverlays is already memoized; React only re-runs the
  // map when it changes) without the cross-kind paint-order bug
  // those three buckets imposed.
  // Text overlays moved out of the SVG path in the HTML-text
  // unification (see TextHtmlOverlays). The SVG side handles non-text
  // shapes + the selection outline; TextHtml renders persisted text
  // glyphs as absolute-positioned <div>s in the canvas-wrap so display
  // + edit go through Chromium's HTML text pipeline. The "suppress
  // the editing overlay" rule lives in TextHtmlOverlays.tsx now.

  // Live-rect for shape/highlight/blur drags, computed once so all
  // three branches can share. Threads the canvas aspect into
  // rectFromDrag so the 1:1 lock for square/circle produces a true
  // pixel-square box (not a canvas-aspect-shaped one).
  const canvasAspect =
    imageHeightPx > 0 ? imageWidthPx / imageHeightPx : 1;
  const liveRect =
    draft !== null && draft.kind === "shape-drag"
      ? rectFromDrag(draft, canvasAspect)
      : null;

  // `overflow="visible"` on the svg element AND `overflow: visible`
  // in the CSS — belt-and-suspenders. SVG 1.1 spec says the
  // outermost <svg> defaults to overflow:hidden via the SVG
  // attribute, and CSS `overflow:visible` doesn't always win
  // against the SVG attribute in every Chromium version. With
  // both set, content drawn past the viewBox (a rect dragged
  // partway off the canvas, its selection outline, etc.) is
  // guaranteed to render past the SVG's CSS box.
  //
  // **Per-glyph mini-SVGs for cross-kind z-order.** Pre-fix this
  // function returned ONE big SVG with all persisted glyphs as
  // siblings. SVG document order determined paint order inside
  // that SVG, but CSS z-index doesn't apply to SVG children — only
  // to SVG elements themselves. That meant a rect inside the SVG
  // couldn't stack against a sibling HTML element (a blur item, a
  // text wrapper) via CSS z-index — they were all in one z-block.
  // User repro: "Bring Forward / Bring to Front on a Rect does not
  // bring it above the arrows... ever" (the cross-kind case
  // between rect and blur had the same shape too).
  //
  // Each persisted glyph now renders in its OWN mini-SVG with CSS
  // `zIndex: row.z_index`. The parent `.editor-svg` CSS class is
  // `position: absolute` with no z-index of its own → no stacking
  // context, so the z-index on each mini-SVG applies to the
  // canvas-wrap stacking context. Combined with BlurOverlays and
  // TextHtmlOverlays applying the same `zIndex: row.z_index` on
  // their items, ALL persisted layers participate in ONE shared
  // stacking context, ordered by their layer.z_index — which is
  // the same order the bake (compose.ts + compose-tree.ts) paints
  // in, so live preview and exported PNG agree.
  //
  // The chrome SVG (drafts + selection outlines) renders at a
  // sentinel `Z_INDEX_CHROME` so it ALWAYS paints above every
  // persisted layer, regardless of how many reorders have bumped
  // the layer z_index values.
  return (
    <>
      {effectiveOverlays.map((row) => {
        const data = row.data;
        if (
          data.kind !== "highlight" &&
          data.kind !== "shape" &&
          data.kind !== "arrow"
        ) {
          // text → TextHtmlOverlays; blur → BlurOverlays; crop →
          // no-op (canvas dim mutation). step is a Phase 6 affordance
          // not in the SVG path yet.
          return null;
        }
        // Clip a RESTING committed glyph to the canvas viewBox so the
        // editor matches the bake/export — an annotation (or the part of
        // one) outside a cropped viewport must not bleed past the canvas
        // edge. The exception is a glyph being ACTIVELY DRAGGED (present
        // in `liveOverride`): keep it overflow:visible so the user can
        // still see what they're dragging off-canvas (the #125
        // affordance, which also covers selection outlines + drafts in
        // the chrome SVG below). Set both the attribute AND inline style
        // because the SVG `overflow` attribute and CSS don't always
        // agree on which wins (see the editor-svg note in editor.css).
        const dragging = liveOverride?.has(row.id) === true;
        const glyphOverflow = dragging ? "visible" : "hidden";
        return (
          <svg
            key={row.id}
            className="editor-svg"
            viewBox={viewBox}
            overflow={glyphOverflow}
            style={{ zIndex: row.z_index, overflow: glyphOverflow }}
            data-testid="persisted-glyph-svg"
          >
            {data.kind === "highlight" && (
              <HighlightGlyph
                rect={data.rect}
                rotation={readOverlayRotation(data)}
                color={data.color}
                opacity={data.opacity}
                blend={data.blend}
                imageWidthPx={imageWidthPx}
                imageHeightPx={imageHeightPx}
              />
            )}
            {data.kind === "shape" && (
              <ShapeGlyph
                rect={data.rect}
                shape={readShapeKind(data)}
                skewDeg={readShapeSkewDeg(data)}
                rotation={readOverlayRotation(data)}
                color={data.color}
                thickness={data.thickness}
                filled={readShapeFilled(data)}
                imageWidthPx={imageWidthPx}
                imageHeightPx={imageHeightPx}
              />
            )}
            {data.kind === "arrow" && (
              <ArrowGlyph
                fromXn={data.from.x}
                fromYn={data.from.y}
                toXn={data.to.x}
                toYn={data.to.y}
                color={data.color}
                endStyle={readArrowEndStyle(data)}
                stemStyle={readArrowStemStyle(data)}
                doubleEnded={readArrowDoubleEnded(data)}
                thickness={data.thickness}
                styleVersion={data.styleVersion}
                imageWidthPx={imageWidthPx}
                imageHeightPx={imageHeightPx}
              />
            )}
          </svg>
        );
      })}
      {/* Chrome SVG — drafts + selection outlines. ALWAYS painted
          above all persisted layers via Z_INDEX_CHROME sentinel.
          Selection outlines per id; ids missing from the current
          overlay list are silently skipped (the parent's stale-id
          cleanup catches up on the next render). */}
      <svg
        className="editor-svg"
        viewBox={viewBox}
        overflow="visible"
        style={{ zIndex: Z_INDEX_CHROME }}
        data-testid="chrome-svg"
      >
        {selectedLayerIds.map((id) => {
          const sel = effectiveOverlays.find((r) => r.id === id);
          if (sel === undefined) return null;
          return (
            <SelectionOutline
              key={id}
              overlayId={id}
              data={sel.data}
              imageWidthPx={imageWidthPx}
              imageHeightPx={imageHeightPx}
              sourceWidthPx={sourceWidthPx}
              sourceHeightPx={sourceHeightPx}
            />
          );
        })}
        {selectedRasterBoxesN.map((box) => (
          <RasterSelectionOutline
            key={box.id}
            box={box}
            imageWidthPx={imageWidthPx}
            imageHeightPx={imageHeightPx}
          />
        ))}
        {/* Drafts (live-drag preview) rendered last so they're on
            top of selection outlines. Phase 3.3 — the draft now
            consumes `draftStyle.color` so the live preview matches
            the user's popover pick during the drag, not just on
            commit. Falls back to "auto" → --accent for any tool
            that doesn't pass a draftStyle. */}
        {draft?.kind === "arrow" && (
          <ArrowGlyph
            fromXn={draft.fromXn}
            fromYn={draft.fromYn}
            toXn={draft.toXn}
            toYn={draft.toYn}
            color={draftStyle?.color}
            endStyle={draftStyle?.endStyle}
            stemStyle={draftStyle?.stemStyle}
            doubleEnded={draftStyle?.doubleEnded}
            thickness={draftStyle?.thickness}
            // Drafts always render at the CURRENT style version —
            // they get stamped with it on commit, so the live
            // preview during drag matches what's about to be
            // persisted. Without this an in-flight arrow would
            // render at v1 (the default when styleVersion is
            // undefined) and then jump to the current version
            // proportions on pointerup.
            styleVersion={CURRENT_ARROW_STYLE_VERSION}
            imageWidthPx={imageWidthPx}
            imageHeightPx={imageHeightPx}
            isDraft
          />
        )}
        {draft?.kind === "shape-drag" && liveRect !== null && (
          <>
            {draft.tool === "highlight" && (
              <HighlightGlyph
                rect={liveRect}
                color={draftStyle?.color}
                opacity={draftStyle?.highlightOpacity}
                blend={draftStyle?.highlightBlend}
                imageWidthPx={imageWidthPx}
                imageHeightPx={imageHeightPx}
              />
            )}
            {draft.tool === "shape" && (
              <ShapeGlyph
                rect={liveRect}
                shape={draft.shape ?? draftStyle?.shape ?? "rect"}
                skewDeg={
                  draftStyle?.skewDeg ?? DEFAULT_PARALLELOGRAM_SKEW_DEG
                }
                color={draftStyle?.color}
                thickness={draftStyle?.thickness}
                filled={draftStyle?.filled ?? false}
                imageWidthPx={imageWidthPx}
                imageHeightPx={imageHeightPx}
                isDraft
              />
            )}
          </>
        )}
      </svg>
    </>
  );
}

/** CSS z-index used for editor chrome (drafts, selection outlines,
 *  transform handles, text-draft-input). Sentinel above any
 *  realistic layer.z_index value — even after many reorders pushing
 *  layers up, the chrome will still paint on top. Exported because
 *  the outer Editor uses the same constant for TransformHandles +
 *  TextDraftInput so they sit at the same chrome level. */
export const Z_INDEX_CHROME = 1_000_000_000;

function ArrowGlyph({
  fromXn,
  fromYn,
  toXn,
  toYn,
  imageWidthPx,
  imageHeightPx,
  color,
  endStyle,
  stemStyle,
  doubleEnded = false,
  thickness,
  styleVersion,
  isDraft = false
}: {
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
  imageWidthPx: number;
  imageHeightPx: number;
  /** Persisted overlay's color (or live-drag's chosen color). When
   *  `"auto"` or undefined, falls back to the theme `--accent` token so
   *  legacy rows + draft-without-style render with the original
   *  pre-Phase-3.1 brand color. Anything else (hex from the popover
   *  swatches or Custom… picker) is passed through. Pre-3.3 the
   *  hardcoded accent meant the persisted `data.color` was silently
   *  ignored — library thumbnails baked via compose.ts showed the
   *  picked color but the live editor canvas showed tangerine. */
  color?: "auto" | string | undefined;
  /** Head glyph at the arrow's `to` endpoint. Defaults to the legacy
   *  filled-triangle when undefined (matches `readArrowEndStyle`). */
  endStyle?: ArrowEndStyle | undefined;
  /** Stem stroke style. Defaults to solid when undefined. */
  stemStyle?: ArrowStemStyle | undefined;
  /** When true, mirror the same end glyph at the `from` endpoint. */
  doubleEnded?: boolean | undefined;
  /** Optional stroke-thickness override. "auto"/undefined falls back
   *  to the geometry-derived stroke fraction (legacy behavior). */
  thickness?: OverlayThickness | undefined;
  /** Pinned arrow style version (see `ARROW_STYLE_VERSIONS` in
   *  `arrow.ts`). Missing/undefined falls back to v1 — the legacy
   *  proportions — so pre-versioning rows render exactly as they
   *  did before the table existed. New committed rows stamp
   *  `CURRENT_ARROW_STYLE_VERSION`. */
  styleVersion?: number | undefined;
  isDraft?: boolean;
}): ReactElement {
  const resolvedEndStyle: ArrowEndStyle = endStyle ?? "filled-triangle";
  const resolvedStemStyle: ArrowStemStyle = stemStyle ?? "solid";
  // Resolve the thickness override BEFORE computing geometry so head
  // length/width scale with the stem. Without this, "Large" doubles
  // the stem but leaves the head at the auto-derived size — fat stem,
  // tiny head, and open-triangle's hollow interior fills up with the
  // now-thick outline stroke. Two-step:
  //   1. Compute the auto stroke for this arrow's geometry (length-
  //      aware, short-side aware) by running geometry once with no
  //      override.
  //   2. Resolve the user's preset/numeric value against that auto
  //      stroke, then feed the result back into geometry as
  //      `strokeWidthOverridePx` for the FINAL geometry call.
  // The compose.ts bake mirrors this same two-step.
  //
  // `styleVersion` is threaded through BOTH calls so head proportions
  // stay pinned to the row's version even when a thickness override
  // is in play.
  const autoGeom = computeArrowGeometry({
    from: { x: fromXn, y: fromYn },
    to: { x: toXn, y: toYn },
    imageWidthPx,
    imageHeightPx,
    styleVersion
  });
  const shortSidePx = Math.max(1, Math.min(imageWidthPx, imageHeightPx));
  // Pass autoStrokeWidthPx + shortSidePx so the floor-fraction
  // formula activates (Large/X-Large lift the stroke off the
  // STROKE_MAX_PX cap on high-DPI captures). Output is in pixels,
  // no trailing multiplication needed.
  const strokeWidthOverridePx =
    thickness === undefined || thickness === "auto"
      ? undefined
      : readOverlayThickness(thickness, autoGeom.strokeWidthPx, shortSidePx);
  const headGeom =
    strokeWidthOverridePx === undefined
      ? autoGeom
      : computeArrowGeometry({
          from: { x: fromXn, y: fromYn },
          to: { x: toXn, y: toYn },
          imageWidthPx,
          imageHeightPx,
          strokeWidthOverridePx,
          styleVersion
        });
  // Secondary geometry for double-ended arrows — swap from/to so the
  // tail-end head's triangle points at `from` with its base centered
  // along the stem. Same override applied so both ends match.
  const tailGeom = doubleEnded
    ? computeArrowGeometry({
        from: { x: toXn, y: toYn },
        to: { x: fromXn, y: fromYn },
        imageWidthPx,
        imageHeightPx,
        strokeWidthOverridePx,
        styleVersion
      })
    : null;
  // Stem stroke = final geometry's stroke. Short-arrow correction
  // inside computeArrowGeometry may have shrunk it from the requested
  // override (so a Large thickness on a tiny arrow still renders
  // proportionally).
  const stroke = headGeom.strokeWidthPx;
  const outline = Math.max(stroke * 0.25, 1.5);
  // Resolution: explicit color → use it; "auto" / undefined → fall back
  // to the theme accent token. Draft variant uses --accent-strong for
  // the pre-Phase-3.1 visual cue, but ONLY when color is "auto"/missing
  // — when the user picked a swatch we honor it for both draft + commit
  // so the preview matches what's about to be persisted.
  const accent =
    color !== undefined && color !== "auto"
      ? color
      : isDraft
      ? "var(--accent-strong, #ffa33d)"
      : "var(--accent, #ff8a1f)";

  // Stem endpoints — pulled back behind the head glyph(s) so the stem
  // doesn't punch through a hollow head outline. For filled glyphs the
  // head paints over the stem anyway; for `line`/`dot`/`open-triangle`
  // the head is shorter or has interior negative space so we stop the
  // stem at the geometric base instead of the apex. Returned in PIXEL
  // coordinates (the helper does the normalized→px conversion).
  const stemEndAtTo = stemEndpointFor(resolvedEndStyle, headGeom, imageWidthPx, imageHeightPx);
  const stemEndAtFrom =
    tailGeom !== null
      ? stemEndpointFor(resolvedEndStyle, tailGeom, imageWidthPx, imageHeightPx)
      : null;
  const fromPoint =
    stemEndAtFrom ?? {
      x: headGeom.from.x * imageWidthPx,
      y: headGeom.from.y * imageHeightPx
    };

  // Stroke-dash pattern, aligned so the line begins AND ends on a
  // complete dash. Pre-fix this used a fixed `${stroke*4} ${stroke*2}`
  // pattern; the stem ended at whatever phase the natural cycle
  // landed at, producing visible inconsistency between arrows of
  // slightly different lengths (sliver vs whole dash at the tail).
  // computeStemDashArray stretches the dash:gap ratio so N dashes +
  // (N−1) gaps fill the segment exactly. Mirrors the Illustrator/
  // Figma/PowerPoint convention. The halo line gets the same pattern
  // so dashed-on-dashed gaps align (otherwise the solid halo would
  // show through colored stem gaps as white "ghost dashes").
  const stemLengthPx = Math.hypot(
    stemEndAtTo.x - fromPoint.x,
    stemEndAtTo.y - fromPoint.y
  );
  const dashStem = computeStemDashArray(resolvedStemStyle, stemLengthPx, stroke);

  return (
    <g strokeLinejoin="round">
      {/* Stem halo — white under-stroke for legibility on busy
          backgrounds. Mirrors the SAME dash pattern as the colored
          stem so the gaps line up: a dashed colored stem over a
          solid halo would show solid-white "ghost" dashes through
          the gaps. With matching dash patterns the halo just widens
          each dash, never fills the gaps. */}
      <line
        x1={fromPoint.x}
        y1={fromPoint.y}
        x2={stemEndAtTo.x}
        y2={stemEndAtTo.y}
        stroke="white"
        strokeWidth={stroke + outline * 2}
        strokeLinecap="round"
        strokeDasharray={dashStem ?? undefined}
        fill="none"
      />
      {/* Head halo at the `to` endpoint. */}
      <ArrowHeadHalo
        style={resolvedEndStyle}
        geom={headGeom}
        outline={outline}
        stroke={stroke}
        imageWidthPx={imageWidthPx}
        imageHeightPx={imageHeightPx}
      />
      {/* Mirrored head halo at the `from` endpoint (double-ended). */}
      {tailGeom !== null && (
        <ArrowHeadHalo
          style={resolvedEndStyle}
          geom={tailGeom}
          outline={outline}
          stroke={stroke}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      )}
      {/* Colored stem on top of the halo. */}
      <line
        x1={fromPoint.x}
        y1={fromPoint.y}
        x2={stemEndAtTo.x}
        y2={stemEndAtTo.y}
        stroke={accent}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={dashStem ?? undefined}
        fill="none"
      />
      {/* Colored head at the `to` endpoint. */}
      <ArrowHead
        style={resolvedEndStyle}
        geom={headGeom}
        stroke={stroke}
        accent={accent}
        imageWidthPx={imageWidthPx}
        imageHeightPx={imageHeightPx}
      />
      {/* Mirrored colored head at the `from` endpoint (double-ended). */}
      {tailGeom !== null && (
        <ArrowHead
          style={resolvedEndStyle}
          geom={tailGeom}
          stroke={stroke}
          accent={accent}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      )}
    </g>
  );
}

/** Return where the stem should terminate for a given head style, in
 *  PIXEL coordinates.
 *  - filled-triangle / open-triangle: pull back to baseCenter (head
 *    triangle takes over from there).
 *  - line: stop at the apex; the perpendicular bar overlaps the stem
 *    end cleanly.
 *  - dot: stop at the apex; the dot is centered on `to` and the stem
 *    runs to its center (which is the visual end of the arrow). */
function stemEndpointFor(
  style: ArrowEndStyle,
  geom: ReturnType<typeof computeArrowGeometry>,
  imageWidthPx: number,
  imageHeightPx: number
): { x: number; y: number } {
  switch (style) {
    case "filled-triangle":
    case "open-triangle":
      return {
        x: geom.baseCenter.x * imageWidthPx,
        y: geom.baseCenter.y * imageHeightPx
      };
    case "line":
    case "dot":
      return { x: geom.to.x * imageWidthPx, y: geom.to.y * imageHeightPx };
  }
}

// Old `stemDashFor` removed in favor of `computeStemDashArray` from
// @pwrsnap/shared, which scales the dash pattern to land on a
// complete dash at both ends of the stem. See the helper's docblock
// for the algorithm; the bake (compose.ts) uses the same helper so
// renderer + thumbnail stay byte-aligned on the dash math.

/** White halo behind the arrow head — drawn underneath the colored
 *  head so the entire glyph reads on busy backgrounds. Geometry is
 *  normalized; pixel conversion happens here so all coords + strokes
 *  land in the parent SVG's pixel-space viewBox. */
function ArrowHeadHalo({
  style,
  geom,
  outline,
  stroke,
  imageWidthPx,
  imageHeightPx
}: {
  style: ArrowEndStyle;
  geom: ReturnType<typeof computeArrowGeometry>;
  outline: number;
  stroke: number;
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
  const toX = geom.to.x * imageWidthPx;
  const toY = geom.to.y * imageHeightPx;
  const blX = geom.baseLeft.x * imageWidthPx;
  const blY = geom.baseLeft.y * imageHeightPx;
  const brX = geom.baseRight.x * imageWidthPx;
  const brY = geom.baseRight.y * imageHeightPx;
  const polygon = `${toX},${toY} ${blX},${blY} ${brX},${brY}`;
  switch (style) {
    case "filled-triangle":
      // Filled head: interior is colored, so the halo only needs to
      // peek out at the edges. A filled white polygon under the
      // colored fill works (the colored fill covers everything but
      // the rim).
      return (
        <polygon
          points={polygon}
          fill="white"
          stroke="white"
          strokeWidth={outline * 2}
          strokeLinejoin="round"
        />
      );
    case "open-triangle":
      // Hollow head: interior must stay transparent so the image
      // shows through. Use a fill="none" white polygon with a stroke
      // wide enough that it extends `outline` past the colored stroke
      // on BOTH sides — the outside edge (legibility against the
      // background) AND the inside edge (legibility against whatever
      // the hollow exposes). Centered strokes split width equally:
      // a strokeWidth=(stroke + outline*2) halo over a strokeWidth=
      // stroke colored line yields `outline` of white visible on
      // each side. Without this fix the interior reads as solid
      // white — the very thing the open style was meant to avoid.
      return (
        <polygon
          points={polygon}
          fill="none"
          stroke="white"
          strokeWidth={stroke + outline * 2}
          strokeLinejoin="round"
        />
      );
    case "line":
      return (
        <line
          x1={blX}
          y1={blY}
          x2={brX}
          y2={brY}
          stroke="white"
          strokeWidth={stroke + outline * 2}
          strokeLinecap="round"
        />
      );
    case "dot": {
      const r = stroke * 1.5;
      return (
        <circle
          cx={toX}
          cy={toY}
          r={r + outline}
          fill="white"
          stroke="white"
          strokeWidth={outline * 2}
        />
      );
    }
  }
}

/** The colored head glyph — paints on top of `ArrowHeadHalo`. */
function ArrowHead({
  style,
  geom,
  stroke,
  accent,
  imageWidthPx,
  imageHeightPx
}: {
  style: ArrowEndStyle;
  geom: ReturnType<typeof computeArrowGeometry>;
  stroke: number;
  accent: string;
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
  const toX = geom.to.x * imageWidthPx;
  const toY = geom.to.y * imageHeightPx;
  const blX = geom.baseLeft.x * imageWidthPx;
  const blY = geom.baseLeft.y * imageHeightPx;
  const brX = geom.baseRight.x * imageWidthPx;
  const brY = geom.baseRight.y * imageHeightPx;
  const polygon = `${toX},${toY} ${blX},${blY} ${brX},${brY}`;
  switch (style) {
    case "filled-triangle":
      return <polygon points={polygon} fill={accent} />;
    case "open-triangle":
      return (
        <polygon
          points={polygon}
          fill="none"
          stroke={accent}
          strokeWidth={stroke}
          strokeLinejoin="round"
        />
      );
    case "line":
      return (
        <line
          x1={blX}
          y1={blY}
          x2={brX}
          y2={brY}
          stroke={accent}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      );
    case "dot": {
      const r = stroke * 1.5;
      return <circle cx={toX} cy={toY} r={r} fill={accent} />;
    }
  }
}

function ShapeGlyph({
  rect,
  shape = "rect",
  skewDeg = DEFAULT_PARALLELOGRAM_SKEW_DEG,
  rotation = 0,
  imageWidthPx,
  imageHeightPx,
  color,
  thickness,
  filled = false,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Which geometric primitive to render. Drives the choice of SVG
   *  element underneath:
   *    rect / square → <rect>     (square is a 1:1-locked rect — the
   *                                lock is enforced at draw time;
   *                                committed rect.w / rect.h are taken
   *                                verbatim here)
   *    circle / oval → <ellipse>  (circle is a 1:1-locked ellipse;
   *                                same lock-at-draw discipline)
   *    parallelogram → <polygon>  (rect bbox + horizontal skew)
   *  Defaults to "rect" — matches the back-compat default for legacy
   *  rows without an explicit `shape` field. */
  shape?: ShapeKind;
  /** Horizontal skew in degrees. Only honored when shape === "parallelogram".
   *  Positive values shift the top edge to the right. */
  skewDeg?: number;
  /** Clockwise rotation in radians around the shape's bbox center.
   *  Default 0 (legacy / unrotated rows). Applied as an SVG transform
   *  on the wrapping `<g>` so both halo + colored stroke rotate as one
   *  rigid body. */
  rotation?: number;
  imageWidthPx: number;
  imageHeightPx: number;
  /** See ArrowGlyph.color for the resolution rationale. Same shape. */
  color?: "auto" | string | undefined;
  /** Optional stroke-thickness override. See ArrowGlyph.thickness. */
  thickness?: OverlayThickness | undefined;
  /** When true, the shape renders as a solid fill in `accent` rather
   *  than a stroke-only outline. The halo (white under-stroke) is
   *  skipped because a solid fill already reads at full contrast. */
  filled?: boolean | undefined;
  isDraft?: boolean;
}): ReactElement {
  // Stroke width + halo scaled by image short-side. Same band as
  // ArrowGlyph — see ArrowGlyph for the calibration rationale. Pixel-
  // space: the shared helper applies the floor-fraction formula on
  // Large/X-Large so high-DPI captures don't get a hairline shape, and
  // it's the SAME source of truth the click hit-test + drag rect read
  // so the painted line and the grabbable region can't drift apart.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const { strokeWidthPx, outline } = shapeStrokeGeometry(thickness, shortSide);
  // Pixel-space bbox.
  const rx = rect.x * imageWidthPx;
  const ry = rect.y * imageHeightPx;
  const rw = rect.w * imageWidthPx;
  const rh = rect.h * imageHeightPx;
  const accent =
    color !== undefined && color !== "auto"
      ? color
      : isDraft
      ? "var(--accent-strong, #ffa33d)"
      : "var(--accent, #ff8a1f)";
  // Rotation: apply ONE transform on the wrapping <g> so halo + colored
  // strokes rotate together. Center of rotation is the bbox center in
  // PIXEL-SPACE viewBox units. SVG `rotate(deg cx cy)` takes degrees;
  // our schema stores radians.
  const rotateDeg = (rotation * 180) / Math.PI;
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const groupTransform =
    rotation !== 0 ? `rotate(${rotateDeg} ${cx} ${cy})` : undefined;
  const wrapperProps = groupTransform !== undefined
    ? { transform: groupTransform }
    : {};

  // Per-shape primitive renderers. Halo (white under-stroke) +
  // colored stroke are produced as a 2-element array so we can share
  // the wrapping <g> + filled-branch fork.
  function strokedPrimitive(stroke: string, strokeWidth: number): ReactElement {
    switch (shape) {
      case "circle":
      case "oval":
        // <ellipse> inscribed in the bbox — cx/cy at center, rx/ry =
        // half-extents. Same bbox semantics as <rect> for selection /
        // hit-testing parity.
        return (
          <ellipse
            cx={cx}
            cy={cy}
            rx={rw / 2}
            ry={rh / 2}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        );
      case "parallelogram": {
        // Horizontal shear of the bbox: top edge shifts +shearPx in X,
        // bottom edge shifts -shearPx in X. `shearPx = (h/2) * tan(skew)`.
        // The bbox SIZE on disk is the unsheared rect; we draw the
        // sheared quad inside it. Positive skewDeg → top edge slides
        // right; this matches Keynote / Figma's "skew right" convention.
        const skewRad = (skewDeg * Math.PI) / 180;
        const shearPx = (rh / 2) * Math.tan(skewRad);
        const xL = rx;
        const xR = rx + rw;
        const yT = ry;
        const yB = ry + rh;
        const points = [
          `${xL + shearPx},${yT}`,
          `${xR + shearPx},${yT}`,
          `${xR - shearPx},${yB}`,
          `${xL - shearPx},${yB}`
        ].join(" ");
        return (
          <polygon
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        );
      }
      case "rect":
      case "square":
      default:
        return (
          <rect
            x={rx}
            y={ry}
            width={rw}
            height={rh}
            fill="none"
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        );
    }
  }

  function filledPrimitive(): ReactElement {
    switch (shape) {
      case "circle":
      case "oval":
        return (
          <ellipse
            cx={cx}
            cy={cy}
            rx={rw / 2}
            ry={rh / 2}
            fill={accent}
            stroke="none"
          />
        );
      case "parallelogram": {
        const skewRad = (skewDeg * Math.PI) / 180;
        const shearPx = (rh / 2) * Math.tan(skewRad);
        const xL = rx;
        const xR = rx + rw;
        const yT = ry;
        const yB = ry + rh;
        const points = [
          `${xL + shearPx},${yT}`,
          `${xR + shearPx},${yT}`,
          `${xR - shearPx},${yB}`,
          `${xL - shearPx},${yB}`
        ].join(" ");
        return <polygon points={points} fill={accent} stroke="none" />;
      }
      case "rect":
      case "square":
      default:
        return (
          <rect x={rx} y={ry} width={rw} height={rh} fill={accent} stroke="none" />
        );
    }
  }

  if (filled) {
    // Solid fill — single primitive, no halo. The fill IS the glyph;
    // a halo around a solid fill would just shrink-wrap the same color
    // and add nothing.
    return <g {...wrapperProps}>{filledPrimitive()}</g>;
  }
  return (
    <g {...wrapperProps}>
      {strokedPrimitive("white", strokeWidthPx + outline * 2)}
      {strokedPrimitive(accent, strokeWidthPx)}
    </g>
  );
}

function HighlightGlyph({
  rect,
  rotation = 0,
  color,
  opacity,
  imageWidthPx,
  imageHeightPx
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise rotation in radians around the rect's geometric center.
   *  Default 0 (legacy / unrotated rows). Applied as an SVG `transform`
   *  attribute on the rect so the highlight rotates rigidly. */
  rotation?: number;
  /** Optional explicit color. v2-editor refresh: legacy rows (no
   *  color field) fall back to the historical yellow marker hue. */
  color?: "auto" | string | undefined;
  /** Optional 0..1 opacity. Legacy rows fall back to the shared
   *  marker-pen default used by the bake path. */
  opacity?: number | undefined;
  /** Legacy/persisted rows may still carry a blend field, but the live
   *  v2 preview intentionally ignores it. Highlight effects bake with
   *  marker-style alpha-over semantics so dark UI captures stay visibly
   *  highlighted; preview must match that instead of using CSS
   *  mix-blend-mode. */
  blend?: "multiply" | "screen" | "overlay" | undefined;
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
  const baseHex = readHighlightColor({ color });
  const fillOpacity = readHighlightOpacity({ opacity });
  // Rotation transform — same convention as ShapeGlyph: SVG `rotate(deg
  // cx cy)` in pixel-space, with `cx, cy` at the rect's center.
  const rx = rect.x * imageWidthPx;
  const ry = rect.y * imageHeightPx;
  const rw = rect.w * imageWidthPx;
  const rh = rect.h * imageHeightPx;
  const rotateDeg = (rotation * 180) / Math.PI;
  const transformAttr =
    rotation !== 0
      ? `rotate(${rotateDeg} ${rx + rw / 2} ${ry + rh / 2})`
      : undefined;
  return (
    <rect
      x={rx}
      y={ry}
      width={rw}
      height={rh}
      fill={baseHex}
      fillOpacity={fillOpacity}
      stroke="none"
      {...(transformAttr !== undefined ? { transform: transformAttr } : {})}
    />
  );
}

/** Normalized [0,1] bounding box for a text overlay's rendered glyph
 *  extent. Used by BOTH the dashed SelectionOutline AND the
 *  TransformHandles' drag-to-move body-hit rect — keeping them in
 *  lockstep is what made the post-`dominantBaseline="central"` switch
 *  work: the outline hugs the glyphs and the user's drag-anywhere-
 *  on-the-text behavior covers the same area.
 *
 *  Math mirrors TextGlyph's render:
 *    • fontSizePx — bucket on image short-side (small=shortSide/50,
 *      medium=/30, large=/18)
 *    • Width in pixels: maxChars × fontSizePx × 0.55 (avg em-advance
 *      for SF Pro), normalized by imageWidth so callers can place a
 *      hit-rect via CSS `%`.
 *    • Height in pixels: fontSizePx × (lineCount × 1.2 - 0.2),
 *      accounting for `dy="1.2em"` tspans + the central-baseline
 *      split of the first line, normalized by imageHeight.
 *    • Anchor: point.x (left edge), point.y − (fontSizePx/2) /
 *      imageHeight (top edge of first line; central baseline puts
 *      the line's center on point.y).
 *
 *  Pre-refactor this function carried an `aspectComp = imageH/imageW`
 *  multiplier on width to cancel the preserveAspectRatio="none"
 *  X-stretch that the parent SVG used to have. With the SVG now in
 *  pixel-space viewBox, the natural pixel width is already correct
 *  and the hack is gone.
 */
function textBoundsBox(
  data: Extract<OverlayRow["data"], { kind: "text" }>,
  imageWidthPx: number,
  imageHeightPx: number,
  sourceWidthPx: number,
  sourceHeightPx: number,
  /** The glyph's REAL measured box (image px) published by TextHtml.
   *  When present it wins outright — the outline/handles/hit-test then
   *  hug exactly what Chromium laid out. Absent only on the very first
   *  frame before the glyph's layout effect runs, and in jsdom unit
   *  tests (no live DOM) — both fall back to the analytic estimate
   *  below. See text-measure-registry.ts. */
  measured?: MeasuredGlyphSize | undefined
): { x: number; y: number; w: number; h: number } {
  // MUST match the HTML rendering's metrics. TextHtml renders the
  // glyph as a `<div>` styled by `computeTextHtmlStyle`, which sets
  // `line-height: 1` (single-line height = fontSize px exactly) and
  // wraps in an absolute-positioned outer div with `translateY(-50%)`
  // — meaning the FULL height of the multi-line block is centered on
  // the anchor point, not the first line.
  //
  // Pre-fix this function used the old SVG layout metrics
  // (`lineHeight * 1.2` and "first-line center on anchor"). On
  // multi-line bodies — especially ones with blank lines — the
  // outline ended up the wrong shape AND offset to the wrong vertical
  // position, drifting further with each added line. Visible
  // regression in the HTML-text unification commit.
  // Preferred path: the glyph's REAL measured box. The DOM element is
  // the single source of truth — its `offsetWidth`/`offsetHeight` already
  // reflect the exact font, kerning, line-height, and multi-line layout
  // Chromium produced, so no re-derivation can drift from it.
  if (
    measured !== undefined &&
    measured.widthImagePx > 0 &&
    measured.heightImagePx > 0
  ) {
    const naturalWidthPx = measured.widthImagePx;
    const naturalHeightPx = measured.heightImagePx;
    return {
      x: data.point.x,
      y: data.point.y - naturalHeightPx / 2 / imageHeightPx,
      w: naturalWidthPx / imageWidthPx,
      h: naturalHeightPx / imageHeightPx
    };
  }
  // Analytic fallback — first paint (before the glyph's layout effect
  // publishes) and jsdom unit tests (no live DOM to measure).
  const { sizePx: fontSizePx } = computeTextGlyphSize({
    size: data.size,
    sourceWidthPx,
    sourceHeightPx,
    canvasWidthPx: imageWidthPx,
    canvasHeightPx: imageHeightPx,
    storedSizePx: data.sizePx
  });
  const lines = data.body.split("\n");
  const lineCount = Math.max(1, lines.length);
  const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
  // Measure the REAL advance width of the widest line in the same font
  // the glyph renders with (family + weight + size) so the outline hugs
  // the visible text. The char-count × 0.55 fallback can't tell
  // `Hi Mom` from `Hi MOm` — capital glyphs are wider than the average
  // advance, so the count-based box under-shot wide-cap text (right edge
  // landing inside the glyph). fontSizePx is image-px and measureText
  // scales linearly, so the result is image-px too — normalized by
  // imageWidthPx below. The char-advance fallback only engages where a
  // 2D canvas is unavailable (jsdom unit tests). The hit-test
  // (`hitTestOverlays` in Editor.tsx) measures the same way but stays
  // looser; both constants live in text-bbox-constants.ts.
  const measuredWidthPx = measureTextWidthPx(
    data.body,
    fontSizePx,
    readTextWeight(data)
  );
  const naturalWidthPx =
    measuredWidthPx ?? maxChars * fontSizePx * TEXT_BBOX_CHAR_ADVANCE_OUTLINE;
  // line-height: 1 on the HTML div → total block height is exactly
  // `lineCount * fontSize`. No extra 1.2× spacing, no 0.2 trailing
  // subtraction (that was for SVG dy="1.2em").
  const naturalHeightPx = fontSizePx * lineCount;
  return {
    x: data.point.x,
    // translateY(-50%) on the wrapper centers the FULL block on the
    // anchor — top edge sits `half-block-height` above point.y. Same
    // math the HTML wrapper applies during layout.
    y: data.point.y - (naturalHeightPx / 2) / imageHeightPx,
    w: naturalWidthPx / imageWidthPx,
    h: naturalHeightPx / imageHeightPx
  };
}

/** Dashed selection chrome for a selected NON-BASE raster layer —
 *  IDENTICAL visual constants to `SelectionOutline`'s dashed box
 *  (pad 0.006, stroke shortSide*0.003, dash 0.012/0.008, white halo
 *  under accent) so a selected pasted image reads exactly like a
 *  selected rect/text. Kept as its own tiny component because
 *  SelectionOutline's box derivation + rotation pivots are
 *  overlay-kind-specific; rasters arrive pre-boxed (rasterLayerBoundsN,
 *  draft-override-aware) and don't rotate in v2.0. If the constants
 *  here ever change, change SelectionOutline's to match (and vice
 *  versa). */
function RasterSelectionOutline({
  box,
  imageWidthPx,
  imageHeightPx
}: {
  box: { x: number; y: number; w: number; h: number };
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
  const pad = 0.006;
  const x = (box.x - pad) * imageWidthPx;
  const y = (box.y - pad) * imageHeightPx;
  const w = (box.w + pad * 2) * imageWidthPx;
  const h = (box.h + pad * 2) * imageHeightPx;
  const stroke = "var(--accent, #ff8a1f)";
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const strokeW = Math.max(1, shortSide * 0.003);
  const dashOn = shortSide * 0.012;
  const dashOff = shortSide * 0.008;
  const dashArray = `${dashOn} ${dashOff}`;
  return (
    <g data-testid="selection-outline" data-kind="raster">
      {/* White halo for contrast on dark images. */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke="white"
        strokeWidth={strokeW * 2}
        strokeDasharray={dashArray}
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeW}
        strokeDasharray={dashArray}
      />
    </g>
  );
}

/** Phase 3.2 selection outline. Draws a 1px accent dashed rectangle
 *  around the selected overlay's bounding box, in normalized [0,1]
 *  coords. The outline is a glyph (not interactive); the pointerdown
 *  handler in Editor.tsx owns selection clear / re-select. */
function SelectionOutline({
  overlayId,
  data,
  imageWidthPx,
  imageHeightPx,
  sourceWidthPx,
  sourceHeightPx
}: {
  /** Selected overlay's id — used to read the glyph's measured box from
   *  the registry for text rows (other kinds ignore it). Subscribing
   *  here re-renders the outline when the glyph re-measures after an
   *  edit / resize. */
  overlayId: string;
  data: OverlayRow["data"];
  imageWidthPx: number;
  imageHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
}): ReactElement | null {
  // Subscribe to this id's measured glyph box (text only; undefined for
  // every other kind and until the first measurement lands).
  const measuredGlyph = useGlyphSize(overlayId);
  // Derive a normalized bounding box for each overlay kind.
  let box: { x: number; y: number; w: number; h: number } | null = null;
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    box = data.rect;
  } else if (data.kind === "arrow") {
    // Arrows don't get a bounding-box outline — an axis-aligned rect
    // around a line glyph is the wrong shape, just visual noise.
    // Instead, render two small accent-colored endpoint dots at
    // `from` and `to`. This is a CRITICAL multi-select affordance:
    // TransformHandles (which used to be the sole arrow-selection
    // indicator) only renders for single-selection, so without this
    // path a Cmd-multi-selected arrow had ZERO visual feedback — the
    // user saw nothing to confirm the click landed. Pre-fix the
    // SelectionOutline branch returned null and the comment claimed
    // TransformHandles owned the affordance; that assumption breaks
    // the moment a second layer joins the selection.
    //
    // The dots intentionally stack cleanly under TransformHandles'
    // larger square endpoint handles in the single-select case —
    // the dot is decorative, the handle is interactive. No
    // pointer-events override needed; the outer SVG is already
    // `pointer-events: none`.
    const shortSide = Math.min(imageWidthPx, imageHeightPx);
    // Dot radius tracks the same scale as the dashed-outline stroke
    // so multi-select feedback reads consistently across overlay
    // kinds (rect/highlight/blur/text get a dashed bbox, arrow gets
    // dots, but both at the same visual weight). Min 3px so a very
    // small canvas still shows something hit-testable visually.
    const dotR = Math.max(3, shortSide * 0.008);
    const haloW = Math.max(1, shortSide * 0.003);
    const fromX = data.from.x * imageWidthPx;
    const fromY = data.from.y * imageHeightPx;
    const toX = data.to.x * imageWidthPx;
    const toY = data.to.y * imageHeightPx;
    const stroke = "var(--accent, #ff8a1f)";
    return (
      <g data-testid="selection-outline" data-kind="arrow-endpoints">
        {/* White halo per dot for contrast on dark images. Painted
            first so the colored fill sits on top. */}
        <circle cx={fromX} cy={fromY} r={dotR} fill="white" stroke="white" strokeWidth={haloW * 2} />
        <circle cx={toX} cy={toY} r={dotR} fill="white" stroke="white" strokeWidth={haloW * 2} />
        <circle cx={fromX} cy={fromY} r={dotR - haloW} fill={stroke} />
        <circle cx={toX} cy={toY} r={dotR - haloW} fill={stroke} />
      </g>
    );
  } else if (data.kind === "text") {
    box = textBoundsBox(
      data,
      imageWidthPx,
      imageHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      measuredGlyph
    );
  } else if (data.kind === "crop") {
    box = data.rect;
  }
  if (box === null) return null;
  // Pad slightly so the outline doesn't sit ON the stroke. Normalized
  // padding (0.006 of each axis) converts cleanly to pixel space below.
  //
  // No [0, 1] clamp. Pre-fix this used Math.max(0, …) / Math.min(1 –
  // …, …) which made the outline "allergic to the canvas edge" — when
  // the asset was dragged partly off-canvas, the outline shrank to
  // only the on-canvas portion (visibly looked like the asset
  // changed size). On rotated rects the clamp ALSO shifted the
  // computed center (pivotX/pivotY below = clamped center, not the
  // rect's actual center), so the outline rotated around the wrong
  // point. The outline must bound the FULL asset wherever it is;
  // overflow:visible on .editor-svg + .editor-canvas lets the off-
  // canvas portion paint. The bake clips at canvas bounds, so off-
  // canvas content doesn't ship — but in the editor we want the user
  // to see it.
  const pad = 0.006;
  const xn = box.x - pad;
  const yn = box.y - pad;
  const wn = box.w + pad * 2;
  const hn = box.h + pad * 2;
  const x = xn * imageWidthPx;
  const y = yn * imageHeightPx;
  const w = wn * imageWidthPx;
  const h = hn * imageHeightPx;
  const stroke = "var(--accent, #ff8a1f)";
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const strokeW = Math.max(1, shortSide * 0.003);
  // Dash pattern in pixel space. Tracks the previous normalized ratio
  // (0.012 on / 0.008 off) so the rhythm reads the same on any image.
  const dashOn = shortSide * 0.012;
  const dashOff = shortSide * 0.008;
  const dashArray = `${dashOn} ${dashOff}`;
  // Rotate the outline so it follows the rotated glyph beneath. Pivot
  // matches each kind's glyph:
  //   • rect / highlight / blur — center of the rect
  //   • text                    — center of the textBoundsBox (the
  //                                visible body-box). TextGlyph
  //                                rotates around this same center so
  //                                the outline tracks the glyphs.
  //
  // Unrotated rows skip the transform attribute entirely so the
  // SelectionOutline DOM stays byte-identical for the common case.
  const rotation =
    data.kind === "shape" ||
    data.kind === "highlight" ||
    data.kind === "blur" ||
    data.kind === "text"
      ? readOverlayRotation(data)
      : 0;
  const pivotX = x + w / 2;
  const pivotY = y + h / 2;
  const rotateDeg = (rotation * 180) / Math.PI;
  const outlineTransform =
    rotation !== 0 ? `rotate(${rotateDeg} ${pivotX} ${pivotY})` : undefined;
  return (
    <g
      data-testid="selection-outline"
      {...(outlineTransform !== undefined ? { transform: outlineTransform } : {})}
    >
      {/* White halo for contrast on dark images. */}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke="white"
        strokeWidth={strokeW * 2}
        strokeDasharray={dashArray}
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeW}
        strokeDasharray={dashArray}
      />
    </g>
  );
}

// ---- TransformHandles (Phase 3.5) ----------------------------------
//
// Drag handles drawn over the selected overlay's bounding box. Lives
// outside the OverlaySvg's <svg> because the SVG sets
// `pointer-events: none`; this HTML overlay sits ON TOP of the canvas
// and absorbs pointerdown/move/up to drive geometry updates.
//
// Handle layouts per overlay kind:
//   • rect / highlight / blur: 8 handles (4 corners + 4 edge mids)
//   • arrow: 2 endpoint handles (one at `from`, one at `to`)
//   • text: 4 corner handles (move-only — no font-size resize today)
//   • step: 1 handle at the anchor point (move only)
//
// Each handle uses setPointerCapture so the drag continues even when
// the cursor leaves the handle div. The component reads the current
// overlay shape on pointerdown, then dispatches a fresh
// onGeometryChange on pointerup with the final geometry.

/** Style preset shared by every drag handle. Drawn as a small white
 *  square with an accent border + subtle shadow so it pops against
 *  both bright and dark images. */
const HANDLE_SIZE_PX = 10;

type HandleKind =
  // Corner handles (rect / text)
  | "nw" | "ne" | "se" | "sw"
  // Edge midpoint handles (rect only)
  | "n" | "e" | "s" | "w"
  // Arrow endpoints
  | "arrow-from" | "arrow-to"
  // Single anchor point (text-move, step)
  | "anchor"
  // Interior body — drag-to-move (translates entire layer). Not a
  // resize handle; rendered as a transparent rect under the resize
  // handles so resize-handle pointerdowns take priority via z-order
  // + stopPropagation.
  | "body"
  // Rotation handle — rendered above the bbox top-center. Drag
  // pivots the layer around its geometric center (rect/highlight/
  // blur) or anchor point (text). Arrow is exempt because direction
  // is already encoded in from/to.
  | "rotate";

/** Vertical offset (normalized coords) for the rotation handle above
 *  the bbox's top edge. ~3% of the canvas — small enough to keep the
 *  handle close to the glyph, big enough that it doesn't collide
 *  with the top edge resize handle. */
const ROTATE_HANDLE_OFFSET_N = 0.03;

interface HandleDescriptor {
  /** Stable identifier — also used in data-testid. */
  kind: HandleKind;
  /** Normalized [0,1] position in image coords. */
  xn: number;
  yn: number;
  /** CSS cursor for hover/drag. */
  cursor: string;
}

function cornerCursor(kind: "nw" | "ne" | "se" | "sw"): string {
  return kind === "nw" || kind === "se" ? "nwse-resize" : "nesw-resize";
}

function edgeCursor(kind: "n" | "e" | "s" | "w"): string {
  return kind === "n" || kind === "s" ? "ns-resize" : "ew-resize";
}

/** CSS cursor for a resize handle on a ROTATED rect. The handle's
 *  shape stays axis-aligned (Figma / Illustrator / PowerPoint
 *  convention — square handles are easier to click + read than
 *  diamond handles), but the CURSOR rotates so its diagonal /
 *  axial direction follows the visible edge.
 *
 *  Bucket the rotated direction vector into 8 octants:
 *    E / W       → ew-resize (horizontal)
 *    N / S       → ns-resize (vertical)
 *    NW / SE     → nwse-resize (\\ diagonal)
 *    NE / SW     → nesw-resize (/ diagonal)
 *
 *  When `rotation === 0` returns the original cursor — bit-identical
 *  to the axis-aligned cornerCursor / edgeCursor output, so unrotated
 *  rows keep their cursors exactly as before. */
function rotatedHandleCursor(
  kind: "nw" | "ne" | "se" | "sw" | "n" | "e" | "s" | "w",
  rotation: number
): string {
  if (rotation === 0) {
    return kind === "n" || kind === "e" || kind === "s" || kind === "w"
      ? edgeCursor(kind)
      : cornerCursor(kind);
  }
  // Unrotated screen-direction vector. +y is DOWN in screen space.
  const dirs: Record<typeof kind, readonly [number, number]> = {
    nw: [-1, -1], n: [0, -1], ne: [1, -1],
    e: [1, 0],
    se: [1, 1], s: [0, 1], sw: [-1, 1],
    w: [-1, 0]
  };
  const [vx, vy] = dirs[kind];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rx = vx * cos - vy * sin;
  const ry = vx * sin + vy * cos;
  // Angle in [0, 2π). Bucket into 8 sectors centered on multiples
  // of π/4: 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE.
  let angle = Math.atan2(ry, rx);
  if (angle < 0) angle += 2 * Math.PI;
  const sector = Math.round(angle / (Math.PI / 4)) % 8;
  switch (sector) {
    case 0:
    case 4:
      return "ew-resize";
    case 2:
    case 6:
      return "ns-resize";
    case 1:
    case 5:
      return "nwse-resize";
    case 3:
    case 7:
      return "nesw-resize";
    default:
      return "default";
  }
}

/** Compute handle positions for a given overlay. Returns null for
 *  overlay kinds that don't expose drag handles in Phase 3.5 (crop —
 *  has its own CropTool overlay). */
/** Rotate a handle's position around the layer's pivot. Math is done
 *  in PIXEL space so non-square canvases don't skew the rotated
 *  positions — a 45°-rotated handle on a portrait image should land
 *  on the visible corner, not somewhere off the rect.
 *
 *  Takes the handle's UNROTATED position in normalized coords, the
 *  pivot also in normalized, and image dims so the local offset
 *  from pivot can be expressed in pixels before the rotation matrix
 *  is applied. Returns the rotated position in normalized coords. */
function rotateNormalizedAroundPivot(
  xn: number,
  yn: number,
  pivotXn: number,
  pivotYn: number,
  rotation: number,
  imageWidthPx: number,
  imageHeightPx: number
): { xn: number; yn: number } {
  if (rotation === 0) return { xn, yn };
  const dxPx = (xn - pivotXn) * imageWidthPx;
  const dyPx = (yn - pivotYn) * imageHeightPx;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rotatedDxPx = dxPx * cos - dyPx * sin;
  const rotatedDyPx = dxPx * sin + dyPx * cos;
  return {
    xn: pivotXn + rotatedDxPx / imageWidthPx,
    yn: pivotYn + rotatedDyPx / imageHeightPx
  };
}

function handlesForOverlay(
  data: OverlayRow["data"],
  bodyBox: { x: number; y: number; w: number; h: number } | null,
  imageWidthPx: number,
  imageHeightPx: number
): HandleDescriptor[] | null {
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    const { x, y, w, h } = data.rect;
    const rotation = readOverlayRotation(data);
    const pivotXn = x + w / 2;
    const pivotYn = y + h / 2;
    // Each handle's UNROTATED position. We rotate around the pivot
    // below so the visible handles land on the rotated rect's
    // corners + edge midpoints — without this, rotating a rect
    // leaves the resize squares stuck on the original axis-aligned
    // bbox while the glyph rotates beneath them.
    // Cursors are rotation-aware — the handle SHAPE stays axis-
    // aligned (industry convention) but the cursor's diagonal /
    // axial direction follows the visible edge. Without this, a
    // 90°-rotated NE handle would still show the unrotated
    // nesw-resize cursor even though the visible edge there is
    // now horizontal.
    const unrotated: ReadonlyArray<Omit<HandleDescriptor, "xn" | "yn"> & {
      xn: number;
      yn: number;
    }> = [
      { kind: "nw", xn: x, yn: y, cursor: rotatedHandleCursor("nw", rotation) },
      { kind: "ne", xn: x + w, yn: y, cursor: rotatedHandleCursor("ne", rotation) },
      { kind: "se", xn: x + w, yn: y + h, cursor: rotatedHandleCursor("se", rotation) },
      { kind: "sw", xn: x, yn: y + h, cursor: rotatedHandleCursor("sw", rotation) },
      { kind: "n", xn: x + w / 2, yn: y, cursor: rotatedHandleCursor("n", rotation) },
      { kind: "e", xn: x + w, yn: y + h / 2, cursor: rotatedHandleCursor("e", rotation) },
      { kind: "s", xn: x + w / 2, yn: y + h, cursor: rotatedHandleCursor("s", rotation) },
      { kind: "w", xn: x, yn: y + h / 2, cursor: rotatedHandleCursor("w", rotation) }
    ];
    const rotated = unrotated.map((h) => {
      const r = rotateNormalizedAroundPivot(
        h.xn,
        h.yn,
        pivotXn,
        pivotYn,
        rotation,
        imageWidthPx,
        imageHeightPx
      );
      return { kind: h.kind, xn: r.xn, yn: r.yn, cursor: h.cursor };
    });
    // Rotation handle: positioned above the top edge midpoint, then
    // rotated with the rest. The local offset is in pixel space
    // (ROTATE_HANDLE_OFFSET_N × imageHeightPx) so it stays a
    // consistent visual distance regardless of canvas aspect.
    const rotateLocalY = y - ROTATE_HANDLE_OFFSET_N;
    const r = rotateNormalizedAroundPivot(
      x + w / 2,
      rotateLocalY,
      pivotXn,
      pivotYn,
      rotation,
      imageWidthPx,
      imageHeightPx
    );
    // Clamp y so the handle stays at least slightly inside the
    // canvas even when the glyph hugs the top edge (drag math
    // reads pointer pos vs pivot, not handle render location, so
    // clamping doesn't affect angles).
    const clampedRotateYn = Math.max(0.005, r.yn);
    return [
      ...rotated,
      { kind: "rotate", xn: r.xn, yn: clampedRotateYn, cursor: "grab" }
    ];
  }
  if (data.kind === "arrow") {
    // Arrow exempt from rotation — direction is already encoded in
    // from/to. Use the endpoint handles to reshape.
    return [
      { kind: "arrow-from", xn: data.from.x, yn: data.from.y, cursor: "move" },
      { kind: "arrow-to", xn: data.to.x, yn: data.to.y, cursor: "move" }
    ];
  }
  if (data.kind === "text") {
    // No standalone anchor handle for text — the 10×10 px white
    // square at point.{x,y} looked like a stray checkbox to users
    // ("what is that thing inside the box?") and was redundant with
    // the body-hit rect that already catches drag-to-move across the
    // entire bounding box. The dashed SelectionOutline communicates
    // "this is selected"; the transparent body-hit rect (sized via
    // `textBoundsBox` — same math as the outline) catches drag and
    // double-click. No extra glyph needed.
    //
    // The rotation handle IS rendered for text — positioned above the
    // glyph's bbox top edge (resolved via `bodyBox`, which uses the
    // same `textBoundsBox` math as the outline). For rotated text,
    // the handle rotates AROUND the body-box CENTER (not the anchor
    // point) so it stays visually attached to the top of the rotated
    // glyph. Pivoting on the anchor (data.point — the left edge of
    // the rendered text) made the handle swing in a giant arc as
    // rotation increased; pivoting on the body-box center keeps the
    // handle close to the glyph at every angle.
    if (bodyBox === null) return [];
    const rotation = readOverlayRotation(data);
    const pivotXn = bodyBox.x + bodyBox.w / 2;
    const pivotYn = bodyBox.y + bodyBox.h / 2;
    const unrotatedXn = bodyBox.x + bodyBox.w / 2;
    const unrotatedYn = bodyBox.y - ROTATE_HANDLE_OFFSET_N;
    const r = rotateNormalizedAroundPivot(
      unrotatedXn,
      unrotatedYn,
      pivotXn,
      pivotYn,
      rotation,
      imageWidthPx,
      imageHeightPx
    );
    const clampedYn = Math.max(0.005, r.yn);
    return [
      {
        kind: "rotate",
        xn: r.xn,
        yn: clampedYn,
        cursor: "grab"
      }
    ];
  }
  if (data.kind === "step") {
    return [
      { kind: "anchor", xn: data.point.x, yn: data.point.y, cursor: "move" }
    ];
  }
  // crop — no handles (CropTool owns its own UI).
  return null;
}

/** Geometry update for the active drag, derived from the descriptor's
 *  handle kind and a fresh pointer position. The `startPt` argument
 *  is the pointer position at pointerdown — used by the `body`
 *  handle to compute a translation delta. Resize handles ignore it.
 *
 *  Image dims drive the rotation math: handle positions, the rotation
 *  angle, the body-drag clamp, and resize math all need to convert
 *  between normalized + pixel space so rotation behaves correctly on
 *  non-square canvases. */
function geometryFromDrag(
  data: OverlayRow["data"],
  handle: HandleKind,
  newXn: number,
  newYn: number,
  startPt: { xn: number; yn: number },
  imageWidthPx: number,
  imageHeightPx: number,
  sourceWidthPx: number,
  sourceHeightPx: number,
  /** Measured glyph box for text rows (image px). Used for the text
   *  rotation pivot (body-box center) so it matches the outline +
   *  rendered glyph exactly. */
  measured?: MeasuredGlyphSize | undefined
): GeometryUpdate | null {
  // Rotation handle — compute the angle from the layer's pivot point.
  // Pivot:
  //   • rect / highlight / blur → bbox center.
  //   • text → BODY-BOX center (textBoundsBox center), NOT data.point.
  //     The anchor is on the LEFT edge of the rendered glyphs (text
  //     extends rightward from the click point). Rotating around it
  //     made the text swing in a giant arc around an off-glyph
  //     point. Pivoting on the body-box center matches what the user
  //     sees as "the middle of the text" and produces a tight,
  //     intuitive rotation.
  // The delta is (current angle from pivot) - (down angle from
  // pivot); applied to the layer's PRE-DRAG rotation. Angles are
  // computed in PIXEL space so non-square canvases don't skew the
  // rotation — atan2 in normalized coords would map equal visual
  // angles to unequal normalized angles on a portrait image.
  if (handle === "rotate") {
    let pivotXn: number;
    let pivotYn: number;
    let preRotation = 0;
    if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
      pivotXn = data.rect.x + data.rect.w / 2;
      pivotYn = data.rect.y + data.rect.h / 2;
      preRotation = data.rotation ?? 0;
    } else if (data.kind === "text") {
      const box = textBoundsBox(
        data,
        imageWidthPx,
        imageHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        measured
      );
      pivotXn = box.x + box.w / 2;
      pivotYn = box.y + box.h / 2;
      preRotation = data.rotation ?? 0;
    } else {
      // arrow / step / crop — no rotation handle exposed.
      return null;
    }
    const startDxPx = (startPt.xn - pivotXn) * imageWidthPx;
    const startDyPx = (startPt.yn - pivotYn) * imageHeightPx;
    const currDxPx = (newXn - pivotXn) * imageWidthPx;
    const currDyPx = (newYn - pivotYn) * imageHeightPx;
    const startAngle = Math.atan2(startDyPx, startDxPx);
    const currAngle = Math.atan2(currDyPx, currDxPx);
    const newRotation = preRotation + (currAngle - startAngle);
    if (data.kind === "text") {
      return { kind: "text", point: data.point, rotation: newRotation };
    }
    // rect / highlight / blur — emit unchanged rect so the merger
    // writes only the rotation field.
    return { kind: "rect", rect: data.rect, rotation: newRotation };
  }

  if (handle === "body") {
    const dx = newXn - startPt.xn;
    const dy = newYn - startPt.yn;
    // No canvas-edge clamp on body-translate — user wants to be able
    // to drag a shape mostly off-canvas (e.g., "I only want a corner
    // visible at the edge"). The underlying NormalizedScalar schema
    // accepts any finite number; coords outside [0, 1] are valid + the
    // bake clips them at the canvas edge automatically. Clamping was
    // an early defensive measure that's now actively in the way:
    // rotated rects with their AABB hugging the edge couldn't be
    // dragged further, and unrotated shapes couldn't be partially
    // pushed off (a common cropping-style annotation gesture).
    if (data.kind === "arrow") {
      return {
        kind: "arrow",
        from: { x: data.from.x + dx, y: data.from.y + dy },
        to: { x: data.to.x + dx, y: data.to.y + dy }
      };
    }
    if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
      // Preserve rotation across the translation so a body-drag
      // doesn't accidentally reset it. The merger writes both fields.
      const rotation = readOverlayRotation(data);
      return {
        kind: "rect",
        rect: {
          x: data.rect.x + dx,
          y: data.rect.y + dy,
          w: data.rect.w,
          h: data.rect.h
        },
        ...(rotation !== 0 ? { rotation } : {})
      };
    }
    if (data.kind === "text") {
      const rotation = readOverlayRotation(data);
      return {
        kind: "text",
        point: { x: data.point.x + dx, y: data.point.y + dy },
        ...(rotation !== 0 ? { rotation } : {})
      };
    }
    if (data.kind === "step") {
      return {
        kind: "step",
        point: { x: data.point.x + dx, y: data.point.y + dy }
      };
    }
    return null;
  }

  // Clamp the new position to [0,1] so the user can't drag a handle
  // off the canvas (the underlying schemas reject out-of-range values).
  const cx = Math.max(0, Math.min(1, newXn));
  const cy = Math.max(0, Math.min(1, newYn));

  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    const { x, y, w, h } = data.rect;
    const rotation = readOverlayRotation(data);
    if (rotation === 0) {
      // Axis-aligned resize path (legacy behavior). For unrotated
      // rows this is bit-for-bit the same math + result as before
      // the rotation work landed.
      let nx = x;
      let ny = y;
      let nw = w;
      let nh = h;
      // Corner / edge resize. Each handle pins the OPPOSITE edge(s) and
      // moves its own edge to the new pointer position.
      switch (handle) {
        case "nw":
          nw = x + w - cx;
          nh = y + h - cy;
          nx = cx;
          ny = cy;
          break;
        case "ne":
          nw = cx - x;
          nh = y + h - cy;
          ny = cy;
          break;
        case "se":
          nw = cx - x;
          nh = cy - y;
          break;
        case "sw":
          nw = x + w - cx;
          nh = cy - y;
          nx = cx;
          break;
        case "n":
          nh = y + h - cy;
          ny = cy;
          break;
        case "e":
          nw = cx - x;
          break;
        case "s":
          nh = cy - y;
          break;
        case "w":
          nw = x + w - cx;
          nx = cx;
          break;
        default:
          return null;
      }
      // Normalize negative width/height by flipping rect coords. Users
      // who drag a corner past the opposite edge get a "flip" effect.
      if (nw < 0) {
        nx += nw;
        nw = -nw;
      }
      if (nh < 0) {
        ny += nh;
        nh = -nh;
      }
      // Minimum size — keep at least 0.005 in normalized units so the
      // overlay doesn't collapse to a zero-area sliver the user can't
      // grab again.
      const MIN = 0.005;
      if (nw < MIN) nw = MIN;
      if (nh < MIN) nh = MIN;
      return { kind: "rect", rect: { x: nx, y: ny, w: nw, h: nh } };
    }

    // Rotation-aware resize. Strategy: pin the opposite corner / edge
    // midpoint's WORLD position, compute the pointer's position in the
    // rect's LOCAL frame (centered on old center, axes aligned with
    // the unrotated rect), derive new (w, h) from the local-frame
    // delta vs the pinned local corner, then compute the new world-
    // space center so the pinned point stays put.
    //
    // Pinned local position by handle (in HALF-rect units, so (-1, -1)
    // means NW, (+1, +1) means SE, (0, +1) means S-edge midpoint).
    // sxSign / sySign also tell us how the local delta from the
    // pinned point maps to (newW, newH). For a corner: both axes
    // active. For an edge midpoint: only the perpendicular axis
    // changes; the parallel axis preserves the old size.
    let pinSx: number;
    let pinSy: number;
    let activeX: boolean;
    let activeY: boolean;
    switch (handle) {
      case "nw":
        pinSx = 1;  pinSy = 1;  activeX = true;  activeY = true;  break;
      case "ne":
        pinSx = -1; pinSy = 1;  activeX = true;  activeY = true;  break;
      case "se":
        pinSx = -1; pinSy = -1; activeX = true;  activeY = true;  break;
      case "sw":
        pinSx = 1;  pinSy = -1; activeX = true;  activeY = true;  break;
      case "n":
        pinSx = 0;  pinSy = 1;  activeX = false; activeY = true;  break;
      case "e":
        pinSx = -1; pinSy = 0;  activeX = true;  activeY = false; break;
      case "s":
        pinSx = 0;  pinSy = -1; activeX = false; activeY = true;  break;
      case "w":
        pinSx = 1;  pinSy = 0;  activeX = true;  activeY = false; break;
      default:
        return null;
    }
    const oldCxPx = (x + w / 2) * imageWidthPx;
    const oldCyPx = (y + h / 2) * imageHeightPx;
    const oldWPx = w * imageWidthPx;
    const oldHPx = h * imageHeightPx;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    // Pinned point in WORLD (pixel) space — rotate the local pinned
    // position by θ, add the old center.
    const pinLocalXPx = (pinSx * oldWPx) / 2;
    const pinLocalYPx = (pinSy * oldHPx) / 2;
    const pinWorldXPx = oldCxPx + pinLocalXPx * cos - pinLocalYPx * sin;
    const pinWorldYPx = oldCyPx + pinLocalXPx * sin + pinLocalYPx * cos;
    // Pointer in world pixel space (clamped to canvas).
    const pointerWorldXPx = cx * imageWidthPx;
    const pointerWorldYPx = cy * imageHeightPx;
    // Inverse-rotate (pointer - pin) into local frame. That delta is
    // the rect's diagonal in local coords:
    //   localDelta.x = (pinSx * -1) * newW   (if active)
    //   localDelta.y = (pinSy * -1) * newH   (if active)
    // i.e. for NE (pinSx=-1, pinSy=1), localDelta = (newW, -newH).
    const wdx = pointerWorldXPx - pinWorldXPx;
    const wdy = pointerWorldYPx - pinWorldYPx;
    const localDxPx = wdx * cos + wdy * sin;   // rotate by -θ
    const localDyPx = -wdx * sin + wdy * cos;
    let newWPx = activeX ? localDxPx * -pinSx : oldWPx;
    let newHPx = activeY ? localDyPx * -pinSy : oldHPx;
    // Flip on negative (user dragged past the pin). Mirror the
    // pinned-corner: e.g., dragging NE past SW flips to SW behavior.
    // Simpler: just take absolute values + clamp to MIN. The pin
    // stays where it is; only the rect's local-coord extent changes.
    newWPx = Math.abs(newWPx);
    newHPx = Math.abs(newHPx);
    const MIN_PX = Math.max(2, Math.min(imageWidthPx, imageHeightPx) * 0.005);
    if (newWPx < MIN_PX) newWPx = MIN_PX;
    if (newHPx < MIN_PX) newHPx = MIN_PX;
    // New CENTER world position so the pinned local point lands back
    // on the same world coords. The pinned local position in the NEW
    // rect is (pinSx * newW/2, pinSy * newH/2).
    const newPinLocalXPx = (pinSx * newWPx) / 2;
    const newPinLocalYPx = (pinSy * newHPx) / 2;
    const newCxPx =
      pinWorldXPx - (newPinLocalXPx * cos - newPinLocalYPx * sin);
    const newCyPx =
      pinWorldYPx - (newPinLocalXPx * sin + newPinLocalYPx * cos);
    // Project back to normalized rect coords.
    const newW = newWPx / imageWidthPx;
    const newH = newHPx / imageHeightPx;
    const newX = newCxPx / imageWidthPx - newW / 2;
    const newY = newCyPx / imageHeightPx - newH / 2;
    return {
      kind: "rect",
      rect: { x: newX, y: newY, w: newW, h: newH },
      rotation
    };
  }
  if (data.kind === "arrow") {
    if (handle === "arrow-from") {
      return { kind: "arrow", from: { x: cx, y: cy }, to: data.to };
    }
    if (handle === "arrow-to") {
      return { kind: "arrow", from: data.from, to: { x: cx, y: cy } };
    }
    return null;
  }
  if (data.kind === "text") {
    if (handle !== "anchor") return null;
    return { kind: "text", point: { x: cx, y: cy } };
  }
  if (data.kind === "step") {
    if (handle !== "anchor") return null;
    return { kind: "step", point: { x: cx, y: cy } };
  }
  return null;
}

/** Drag-handles overlay rendered ON TOP of the OverlaySvg. Receives
 *  pointer events (its container has pointer-events: auto) and
 *  dispatches geometry updates as the user drags.
 *
 *  The component renders ONE absolute-positioned div per handle PLUS
 *  a transparent body-hit rect under them. On pointerdown we capture
 *  the pointer + the initial overlay snapshot. Pointermove fires
 *  `onGeometryDrag` on every move so the parent can paint a live
 *  preview of the in-progress geometry (the arrow stretches as you
 *  drag its endpoint; the rect translates as you drag its body).
 *  Pointerup commits the final geometry through `onGeometryChange`.
 *
 *  Hit precedence: handles render on top of the body (higher
 *  zIndex + later in DOM order). The handle's `stopPropagation` on
 *  pointerdown also blocks the body's pointerdown from firing when
 *  the cursor overlaps both. */
export function TransformHandles({
  selectedOverlay,
  imageWidthPx,
  imageHeightPx,
  sourceWidthPx,
  sourceHeightPx,
  onGeometryChange,
  onGeometryDrag,
  onDragStart,
  onDragEnd,
  onRequestEdit
}: {
  selectedOverlay: OverlayRow;
  /** Source dims for kind-specific bounding-box math (text). Rect /
   *  arrow / blur / highlight ignore these. */
  imageWidthPx: number;
  imageHeightPx: number;
  /** SOURCE raster dims — pwrdrvr/PwrSnap#110: text body-hit rect
   *  uses the same `computeTextGlyphSize` formula as the dashed
   *  selection outline, which needs source dims to stay constant
   *  across crops. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Called once at pointerup with the final geometry. Caller is
   *  responsible for routing this through dispatchEdit (which is
   *  format-aware) and updating the selection model to follow the
   *  new layer id. */
  onGeometryChange: (geometry: GeometryUpdate) => void;
  /** Called on EVERY pointermove with the in-progress geometry —
   *  used by the parent to render a live preview overlay so the
   *  arrow / rect visually stretches as the user drags. The
   *  geometry is the same shape the eventual `onGeometryChange`
   *  will fire. Optional; when omitted, only the handles themselves
   *  show live motion (the underlying glyph stays at its pre-drag
   *  position until commit). */
  onGeometryDrag?: (geometry: GeometryUpdate) => void;
  /** Called on pointerdown with the PRE-DRAG overlay row so the
   *  caller can stash it for undo. Optional — when omitted, undo
   *  for moves/resizes won't be recorded. */
  onDragStart?: (preDragOverlay: OverlayRow) => void;
  /** Called after onGeometryChange settles (whether or not the drag
   *  was committed). Lets the caller release any drag-related state
   *  (interaction bracket, hover affordance, etc.). */
  onDragEnd?: () => void;
  /** Called when the user double-clicks the body-hit rect of a TEXT
   *  overlay. Caller should open the TextDraftInput at the overlay's
   *  position, pre-filled with the existing body, and replace (not
   *  duplicate) the overlay on commit. Optional — when omitted, the
   *  text just isn't editable after first placement. */
  onRequestEdit?: (overlay: OverlayRow) => void;
}): ReactElement | null {
  // Live geometry during the drag — used to render the handles in
  // their new positions before the round-trip lands. Falls back to
  // the overlay's persisted data when not dragging.
  const [liveData, setLiveData] = useState<OverlayRow["data"] | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Pointerdown snapshot: the data we use to interpret subsequent
  // pointermove deltas. Kept in a ref since pointermove fires faster
  // than React state can keep up.
  const dragStartDataRef = useRef<OverlayRow["data"] | null>(null);
  const dragHandleRef = useRef<HandleKind | null>(null);
  // Pointer position at pointerdown (normalized [0,1] coords). The
  // body-translate path reads this to compute a translation delta
  // against the start data snapshot. Resize handles ignore it.
  const dragStartPtRef = useRef<{ xn: number; yn: number } | null>(null);

  // When the selected overlay changes (different layer, broadcast
  // refetch), drop any stale live geometry.
  useEffect(() => {
    setLiveData(null);
    dragStartDataRef.current = null;
    dragHandleRef.current = null;
    dragStartPtRef.current = null;
  }, [selectedOverlay.id]);

  const data = liveData ?? selectedOverlay.data;
  // The selected glyph's REAL measured box (text rows only). Subscribing
  // re-renders the handles when the glyph re-measures after an edit /
  // resize so the body-hit rect + rotation handle track it. Undefined
  // for non-text kinds and until the first measurement lands.
  const measuredGlyph = useGlyphSize(selectedOverlay.id);
  // Bounding box for the body-hit rect AND the text-kind rotation
  // handle's position (computed from the same `data` snapshot the
  // handles use so the body + rotate handle follow during a live drag).
  // bodyBox MUST be computed before handles so handlesForOverlay can
  // read it.
  const bodyBox = useMemo(
    () =>
      bodyBoxForOverlay(
        data,
        imageWidthPx,
        imageHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        measuredGlyph
      ),
    [data, imageWidthPx, imageHeightPx, sourceWidthPx, sourceHeightPx, measuredGlyph]
  );
  const handles = useMemo(
    () => handlesForOverlay(data, bodyBox, imageWidthPx, imageHeightPx),
    [data, bodyBox, imageWidthPx, imageHeightPx]
  );

  // Translate a pointer event's client coordinates back into normalized
  // [0,1] image coords. Uses the container's bounding rect — which
  // matches the canvas's rect since this overlay is absolute-positioned
  // to inset:0.
  const clientToNormalized = useCallback(
    (clientX: number, clientY: number): { xn: number; yn: number } | null => {
      const el = containerRef.current;
      if (el === null) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const xn = (clientX - rect.left) / rect.width;
      const yn = (clientY - rect.top) / rect.height;
      return { xn, yn };
    },
    []
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, handle: HandleKind): void => {
      if (event.button !== 0) return;
      // Cmd/Ctrl-click on the BODY-HIT rect is a multi-select gesture,
      // not a drag-init. Without this branch the body-hit unconditionally
      // stopPropagation'd, swallowing the event before Editor's
      // onPointerDown could hit-test for the layer underneath (the
      // body-hit of an already-selected layer is huge for rects / wide
      // arrows / multi-line text, so it covers most neighbors a user
      // would Cmd-click to extend selection). Let the event bubble so
      // Editor.hitTestOverlays runs and toggleSelection fires. Resize
      // and rotation handles stay drag-only — Cmd-clicking them isn't
      // a defined gesture (they're tiny dedicated affordances; a
      // modifier-click there should just be a no-op, not a selection
      // change), so the handle branch keeps the original behavior.
      if (handle === "body" && (event.metaKey || event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      dragStartDataRef.current = selectedOverlay.data;
      dragHandleRef.current = handle;
      const startPt = clientToNormalized(event.clientX, event.clientY);
      dragStartPtRef.current = startPt ?? { xn: 0, yn: 0 };
      onDragStart?.(selectedOverlay);
    },
    [clientToNormalized, onDragStart, selectedOverlay]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const startData = dragStartDataRef.current;
      const handle = dragHandleRef.current;
      const startPt = dragStartPtRef.current;
      if (startData === null || handle === null || startPt === null) return;
      const pt = clientToNormalized(event.clientX, event.clientY);
      if (pt === null) return;
      const geometry = geometryFromDrag(
        startData,
        handle,
        pt.xn,
        pt.yn,
        startPt,
        imageWidthPx,
        imageHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        measuredGlyph
      );
      if (geometry === null) return;
      // Project the geometry onto a fresh data snapshot for live render.
      const merged = applyGeometryLocally(startData, geometry);
      if (merged !== null) setLiveData(merged);
      // Fire onGeometryDrag every move so the parent can paint a
      // live preview of the in-progress geometry (the arrow stretches
      // as the user drags an endpoint, the rect translates as the
      // body is dragged). Parent reads this into `draftGeometry`
      // state and threads it through OverlaySvg / BlurOverlays as
      // `liveOverride`.
      onGeometryDrag?.(geometry);
    },
    [
      clientToNormalized,
      onGeometryDrag,
      imageWidthPx,
      imageHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      measuredGlyph
    ]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const startData = dragStartDataRef.current;
      const handle = dragHandleRef.current;
      const startPt = dragStartPtRef.current;
      dragStartDataRef.current = null;
      dragHandleRef.current = null;
      dragStartPtRef.current = null;
      if (startData === null || handle === null || startPt === null) return;
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
      const pt = clientToNormalized(event.clientX, event.clientY);
      if (pt === null) {
        setLiveData(null);
        onDragEnd?.();
        return;
      }
      // Click-without-drag on the body / a handle is NOT a move — skip
      // the geometry write so we don't stamp a no-op translation onto
      // the overlay (which would push a noisy entry onto the undo stack
      // every time the user just clicks-to-focus a layer). The threshold
      // is generous enough to absorb sub-pixel jitter from a real click
      // while still recognising the smallest deliberate drag.
      //
      // Pointerup is ALSO the single decision point for "click selected
      // text → enter edit mode." Real browsers fire `click` after any
      // mousedown→mouseup that targets the same element, with NO
      // movement threshold — only `dblclick` has one. The body-hit rect
      // tracks liveData during a drag, so the same <div> node sees both
      // mousedown and mouseup; the browser fires `click` on it after a
      // substantive drag. If we routed the edit branch through a React
      // onClick handler, every drag would also fire onRequestEdit
      // against the pre-drag selectedOverlay snapshot — opening a draft
      // at the OLD position with editingId pointing at the row id that
      // the geometry write has just replaced. TextHtmlOverlays can't
      // suppress that id any more, so the moved row paints at the new
      // position AND the draft input paints at the old position: a
      // clone. resolveTextDraftStyle falls back to the current tool
      // style for the missing id, so the clone also picks up a
      // different look ("clones it and leaves a copy behind with a new
      // style"). Deciding drag-vs-click here, exactly once per
      // interaction, makes the React onClick redundant.
      const NO_DRAG_THRESHOLD_N = 0.002;
      const movedN = Math.hypot(pt.xn - startPt.xn, pt.yn - startPt.yn);
      if (movedN < NO_DRAG_THRESHOLD_N) {
        setLiveData(null);
        if (
          handle === "body" &&
          selectedOverlay.data.kind === "text" &&
          onRequestEdit !== undefined
        ) {
          onRequestEdit(selectedOverlay);
        }
        onDragEnd?.();
        return;
      }
      const geometry = geometryFromDrag(
        startData,
        handle,
        pt.xn,
        pt.yn,
        startPt,
        imageWidthPx,
        imageHeightPx,
        sourceWidthPx,
        sourceHeightPx,
        measuredGlyph
      );
      if (geometry !== null) {
        onGeometryChange(geometry);
      }
      // Don't immediately clear liveData — wait for the refetch to land
      // so we don't blink to the pre-drag position. The useEffect on
      // selectedOverlay.id above clears it when the new layer arrives.
      onDragEnd?.();
    },
    [
      clientToNormalized,
      onDragEnd,
      onGeometryChange,
      onRequestEdit,
      selectedOverlay,
      imageWidthPx,
      imageHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      measuredGlyph
    ]
  );

  if (handles === null) return null;

  return (
    <div
      ref={containerRef}
      className="editor-transform-handles"
      data-testid="transform-handles"
      style={{
        position: "absolute",
        inset: 0,
        // Container itself is event-transparent — only the handles
        // themselves (and the body-hit rect) catch pointer events.
        // That way a click outside any catcher falls through to the
        // canvas's pointer handlers (selection / drawing).
        pointerEvents: "none",
        // Chrome z-index sentinel — sit ABOVE every persisted layer
        // regardless of their layer.z_index. Without this, a text or
        // blur layer with a high z_index (after many "Bring Forward"
        // ops) could paint OVER its own transform handles, leaving
        // the handles invisible / unclickable. See OverlaySvg's
        // "per-glyph mini-SVGs" comment for the parallel rationale
        // on the persisted side.
        zIndex: Z_INDEX_CHROME
      }}
    >
      {/* Body-hit rect rendered FIRST (handles paint on top + take
          pointerdown priority via stopPropagation). Transparent;
          catches pointer events; cursor `move`. Drag translates the
          entire layer. */}
      {bodyBox !== null && (
        <div
          className="editor-transform-body"
          data-testid="transform-handle-body"
          data-handle-kind="body"
          role="button"
          aria-label={selectedOverlay.data.kind === "text" ? "Click to edit text, drag to move" : "Move layer"}
          tabIndex={-1}
          onPointerDown={(e) => onPointerDown(e, "body")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // Click-without-drag on a SELECTED text overlay re-opens the
          // draft input with the existing body pre-filled — caret lands
          // exactly where they expect, no double-click puzzle. The
          // drag-vs-click decision lives entirely in onPointerUp above
          // (NOT a separate React onClick handler) so a real drag —
          // even one the browser still emits `click` for, since it
          // fires on every mousedown→mouseup pair targeting the same
          // element with no movement threshold — never trips the edit
          // branch.
          //
          // The Cmd/Ctrl-click multi-select gesture is also handled
          // here without an onClick: `onPointerDown` above early-returns
          // when modifier is held (handle === "body"), so the event
          // bubbles to Editor and `dragStartDataRef` never gets set →
          // onPointerUp's edit branch sees `startData === null` and
          // returns immediately. No double-fire of "deselect then
          // open edit input".
          //
          // First-click-to-select happens in Editor.onPointerDown
          // before TransformHandles even mounts; this body's pointerup
          // only ever fires on the SECOND click on an already-selected
          // overlay — and that pointerup IS the edit trigger when no
          // drag happened. The previous onDoubleClick handler was
          // load-bearing dead code; removed.
          style={(() => {
            // Rotate the body-hit rect to follow the visible glyph
            // when the underlying overlay has a non-zero rotation. CSS
            // `transform: rotate(...)` defaults to `transform-origin:
            // center`, which matches the renderer's pivot for ALL
            // four supported kinds now:
            //   • rect / highlight / blur — bbox center
            //   • text                    — body-box center (this is
            //                                 also the body-hit rect's
            //                                 CSS center since the
            //                                 rect IS the body-box)
            // No transform-origin override needed; CSS default
            // matches the SVG glyph's pivot.
            const d = selectedOverlay.data;
            const rotation =
              d.kind === "shape" ||
              d.kind === "highlight" ||
              d.kind === "blur" ||
              d.kind === "text"
                ? readOverlayRotation(d)
                : 0;
            const rotateDeg = (rotation * 180) / Math.PI;
            const transformAttr =
              rotation !== 0 ? `rotate(${rotateDeg}deg)` : undefined;
            // Grow the DRAG-hit rect outward to cover the visible LINE
            // of a stroked shape (the stroke is centered on the path
            // and the halo extends further out). Without this the user
            // could only drag a selected shape by its interior or the
            // thin inner sliver of its line — the same gap the hit-test
            // pad fixes for selection (both read `shapeStrokeGeometry`
            // so the line and the grabbable region stay in lockstep).
            // The resize / rotate HANDLES keep anchoring on the un-
            // padded `bodyBox` (computed above) so they stay pinned to
            // the glyph corners; only this transparent body rect grows.
            // Highlight / blur — and FILLED shapes, whose solid body has
            // no stroke line — already cover their full visible extent,
            // so no pad.
            const reachPx =
              d.kind === "shape" && !readShapeFilled(d)
                ? shapeStrokeGeometry(
                    d.thickness,
                    Math.min(imageWidthPx, imageHeightPx)
                  ).outerReachPx
                : 0;
            const padXN = reachPx / imageWidthPx;
            const padYN = reachPx / imageHeightPx;
            const dragBox = {
              x: bodyBox.x - padXN,
              y: bodyBox.y - padYN,
              w: bodyBox.w + padXN * 2,
              h: bodyBox.h + padYN * 2
            };
            return {
              position: "absolute" as const,
              left: `${dragBox.x * 100}%`,
              top: `${dragBox.y * 100}%`,
              width: `${dragBox.w * 100}%`,
              height: `${dragBox.h * 100}%`,
              cursor: d.kind === "text" ? "text" : "move",
              pointerEvents: "auto" as const,
              // Transparent — the body is a hit target only. Painting
              // is owned by OverlaySvg / BlurOverlays.
              background: "transparent",
              ...(transformAttr !== undefined ? { transform: transformAttr } : {})
            };
          })()}
        />
      )}
      {handles.map((h) => {
        // Rotation handle gets a distinct circular shape (vs the
        // square resize handles) so the affordance is unambiguous.
        // Same size + center-on-point + zIndex policy as the rest;
        // the only delta is `borderRadius: 50%` and the modifier
        // class so per-handle styling can apply (currently no
        // separate CSS rules — both kinds share .editor-transform-
        // handle; the modifier exists for future polish).
        const isRotate = h.kind === "rotate";
        return (
          <div
            key={h.kind}
            className={
              "editor-transform-handle" +
              (isRotate ? " editor-transform-handle--rotate" : "")
            }
            data-testid={`transform-handle-${h.kind}`}
            data-handle-kind={h.kind}
            role="button"
            aria-label={isRotate ? "Rotate" : `Resize handle ${h.kind}`}
            tabIndex={-1}
            onPointerDown={(e) => onPointerDown(e, h.kind)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              position: "absolute",
              left: `${h.xn * 100}%`,
              top: `${h.yn * 100}%`,
              width: HANDLE_SIZE_PX,
              height: HANDLE_SIZE_PX,
              // Center the handle on the geometric point.
              transform: "translate(-50%, -50%)",
              cursor: h.cursor,
              pointerEvents: "auto",
              // Keep handles above the body-hit rect so resize-handle
              // pointerdowns win over body pointerdowns when the cursor
              // overlaps both.
              zIndex: 1,
              ...(isRotate ? { borderRadius: "50%" } : {})
            }}
          />
        );
      })}
    </div>
  );
}

/** Compute the normalized [0,1] bounding box used as the body-hit
 *  rect for drag-to-move. Returns null for layer kinds that have no
 *  body-translate surface (crop has its own tool). The arrow's box
 *  bounds the segment from `from` to `to`; rect-shaped layers use
 *  their rect directly; text and step use a small box around the
 *  anchor point (big enough to be grabbable, small enough not to
 *  swallow neighboring clicks). */
function bodyBoxForOverlay(
  data: OverlayRow["data"],
  imageWidthPx: number,
  imageHeightPx: number,
  sourceWidthPx: number,
  sourceHeightPx: number,
  /** Measured glyph box for text rows (image px). Forwarded to
   *  `textBoundsBox` so the body-hit rect + rotation handle hug the
   *  real glyph. Ignored for non-text kinds. */
  measured?: MeasuredGlyphSize | undefined
): { x: number; y: number; w: number; h: number } | null {
  if (data.kind === "shape" || data.kind === "highlight" || data.kind === "blur") {
    return data.rect;
  }
  if (data.kind === "arrow") {
    const x = Math.min(data.from.x, data.to.x);
    const y = Math.min(data.from.y, data.to.y);
    const w = Math.abs(data.to.x - data.from.x);
    const h = Math.abs(data.to.y - data.from.y);
    // Don't bother with a body for a zero-length arrow (the endpoint
    // handles overlap and there's nothing to "drag the middle of").
    if (w < 0.001 && h < 0.001) return null;
    return { x, y, w, h };
  }
  if (data.kind === "text") {
    // Text body-hit rect uses the same bounds as the dashed
    // SelectionOutline (`textBoundsBox`) so drag-to-move catches
    // pointer events EVERYWHERE the user sees text — not a fixed-
    // size approximation that missed multi-line bodies or long
    // single-line text. The hit rect is fully transparent; the only
    // user-visible affordance is the SelectionOutline above.
    return textBoundsBox(
      data,
      imageWidthPx,
      imageHeightPx,
      sourceWidthPx,
      sourceHeightPx,
      measured
    );
  }
  if (data.kind === "step") {
    // Step keeps its small approximate box — no body length to
    // measure; rendered as a circle at the anchor point.
    const w = 0.06;
    const h = 0.06;
    const x = Math.max(0, Math.min(1 - w, data.point.x - w / 2));
    const y = Math.max(0, Math.min(1 - h, data.point.y - h / 2));
    return { x, y, w, h };
  }
  return null;
}

// Suppress unused-symbol churn for the geometry types we re-export.
export type { GeometryUpdate, NormalizedPoint, NormalizedRect };

// TextGlyph (the SVG <text> renderer) was deleted in the HTML-text
// unification. Persisted text overlays now render via <TextHtml> as
// absolute-positioned HTML divs in the EDITOR; the bake (compose.ts
// textSvgForV2) still uses SVG via librsvg/sharp — a future PR will
// unify bake rendering through a hidden BrowserWindow capture so
// editor-display = editor-edit = baked-PNG end-to-end. See:
//   • apps/desktop/src/renderer/src/features/editor/TextHtml.tsx
//   • apps/desktop/src/renderer/src/features/editor/TextHtmlOverlays.tsx
//   • packages/shared/src/text-html-style.ts
// `computeTextGlyphSize` is still used by `textBoundsBox` /
// `SelectionOutline` for hit-test + selection-outline geometry.
//
// Text rotation: the rotation field is honored by:
//   • TextHtml — CSS transform: rotate(deg) on the wrapper, with
//     transform-origin at the body-box center (auto since the
//     wrapper's intrinsic box IS the body-box after translateY(-50%)).
//   • TextDraftInput — same CSS transform path so edit-mode matches.
//   • SelectionOutline (below) — SVG rotate(deg cx cy) around the
//     textBoundsBox center so the dashed outline tracks rotated text.
//   • TransformHandles rotate handle — pivots on textBoundsBox center.
//   • compose.ts textSvg/textSvgForV2 — same body-box center pivot
//     (matches the editor render so re-edit doesn't drift).
