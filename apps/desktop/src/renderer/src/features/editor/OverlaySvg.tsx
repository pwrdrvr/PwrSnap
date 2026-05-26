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
  OverlayThickness
} from "@pwrsnap/shared";
import {
  CURRENT_ARROW_STYLE_VERSION,
  computeArrowGeometry,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle,
  readOverlayThickness,
  readRectFilled,
  readTextWeight
} from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import type { GeometryUpdate, NormalizedPoint, NormalizedRect } from "./useCaptureModel";

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
  /** Rect-tool only — render the live-drag rect as a filled fill
   *  rather than a stroke-only outline. */
  filled?: boolean;
  /** Highlight-tool only — CSS mix-blend-mode for the live-drag
   *  preview. Mirrors the persisted overlay's `blend` field. */
  highlightBlend?: "multiply" | "screen" | "overlay";
}

export function OverlaySvg({
  overlays,
  draft,
  draftStyle,
  imageWidthPx,
  imageHeightPx,
  selectedLayerId = null,
  liveOverride = null
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  /** Explicitly `| undefined` (not just `?`) so callers can pass the
   *  helper's result directly under `exactOptionalPropertyTypes`. */
  draftStyle?: DraftStyle | undefined;
  imageWidthPx: number;
  imageHeightPx: number;
  /** Phase 3.2 selection model — id of the currently-selected overlay
   *  row, or null for none. When set, a 1px accent-colored outline
   *  glyph is drawn over that overlay's bounding box so the user can
   *  see what they've selected and confirm before Delete/Backspace. */
  selectedLayerId?: string | null;
  /** Live-drag geometry override. When set, the row whose id matches
   *  `layerId` is rendered with the overridden geometry instead of
   *  its persisted `data.*` fields — so e.g. an arrow's endpoint
   *  visibly follows the cursor during a TransformHandles drag,
   *  rather than staying at its old position until pointerup commits.
   *  Cleared by the parent on drag end. The selection outline also
   *  follows the override (drawn from the overridden box). */
  liveOverride?: { layerId: string; geometry: GeometryUpdate } | null;
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
    if (liveOverride === null) return overlays;
    return overlays.map((row) => {
      if (row.id !== liveOverride.layerId) return row;
      const merged = applyGeometryLocally(row.data, liveOverride.geometry);
      if (merged === null) return row;
      return { ...row, data: merged };
    });
  }, [liveOverride, overlays]);
  const arrows = useMemo(
    () =>
      effectiveOverlays.flatMap((row) =>
        row.data.kind === "arrow" ? [{ row, data: row.data }] : []
      ),
    [effectiveOverlays]
  );
  const rects = useMemo(
    () =>
      effectiveOverlays.flatMap((row) =>
        row.data.kind === "rect" ? [{ row, data: row.data }] : []
      ),
    [effectiveOverlays]
  );
  const highlights = useMemo(
    () =>
      effectiveOverlays.flatMap((row) =>
        row.data.kind === "highlight"
          ? [
              {
                row,
                data: row.data as Extract<typeof row.data, { kind: "highlight" }>
              }
            ]
          : []
      ),
    [effectiveOverlays]
  );
  const texts = useMemo(
    () =>
      effectiveOverlays.flatMap((row) =>
        row.data.kind === "text" ? [{ row, data: row.data }] : []
      ),
    [effectiveOverlays]
  );

  // Live-rect for rect/highlight/blur drags, computed once so all
  // three branches can share.
  const liveRect = draft !== null && draft.kind === "rect-drag" ? rectFromDrag(draft) : null;

  return (
    <svg className="editor-svg" viewBox={viewBox}>
      {/* Highlights painted first so they sit beneath rects/arrows. */}
      {highlights.map(({ row, data }) => (
        <HighlightGlyph
          key={row.id}
          rect={data.rect}
          color={data.color}
          opacity={data.opacity}
          blend={data.blend}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}
      {rects.map(({ row, data }) => (
        <RectGlyph
          key={row.id}
          rect={data.rect}
          color={data.color}
          thickness={data.thickness}
          filled={readRectFilled(data)}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}
      {arrows.map(({ row, data }) => (
        <ArrowGlyph
          key={row.id}
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
      ))}
      {texts.map(({ row, data }) => (
        <TextGlyph
          key={row.id}
          point={data.point}
          body={data.body}
          size={data.size}
          weight={readTextWeight(data)}
          color={data.color}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}

      {/* Phase 3.2 selection outline — rendered after all overlays but
          before drafts so a draft-in-progress doesn't hide the
          selection. Resolves the selected row + draws a thin accent
          outline around its bounding box. Out of scope: handle glyphs
          and color-of-selected-glyph editing (Phase 4). */}
      {selectedLayerId !== null && (() => {
        const sel = effectiveOverlays.find((r) => r.id === selectedLayerId);
        if (sel === undefined) return null;
        return (
          <SelectionOutline
            data={sel.data}
            imageWidthPx={imageWidthPx}
            imageHeightPx={imageHeightPx}
          />
        );
      })()}

      {/* Drafts (live-drag preview) rendered last so they're on top.
          Phase 3.3 — the draft now consumes `draftStyle.color` so the
          live preview matches the user's popover pick during the drag,
          not just on commit. Falls back to "auto" → --accent for any
          tool that doesn't pass a draftStyle. */}
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
          // Drafts always render at the CURRENT style version — they
          // get stamped with it on commit, so the live preview during
          // drag matches what's about to be persisted. Without this
          // an in-flight arrow would render at v1 (the default when
          // styleVersion is undefined) and then jump to the current
          // version proportions on pointerup.
          styleVersion={CURRENT_ARROW_STYLE_VERSION}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
          isDraft
        />
      )}
      {draft?.kind === "rect-drag" && liveRect !== null && (
        <>
          {draft.tool === "highlight" && (
            <HighlightGlyph
              rect={liveRect}
              color={draftStyle?.color}
              blend={draftStyle?.highlightBlend}
              imageWidthPx={imageWidthPx}
              imageHeightPx={imageHeightPx}
              isDraft
            />
          )}
          {draft.tool === "rect" && (
            <RectGlyph
              rect={liveRect}
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
  );
}

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
  const strokeWidthOverridePx =
    thickness === undefined || thickness === "auto"
      ? undefined
      : readOverlayThickness(thickness, autoGeom.strokeFraction) * shortSidePx;
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

  // Stroke-dash pattern. Scaled by stem stroke width so dash density
  // stays visually consistent across image sizes. dotted gets round
  // caps so the dots look like dots, not stripes.
  const dashStem = stemDashFor(resolvedStemStyle, stroke);

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

/** Compute the SVG `stroke-dasharray` string for the stem style.
 *  Returns null for solid (no attribute emitted). `stroke` is in
 *  pixel space (matches the parent viewBox). */
function stemDashFor(style: ArrowStemStyle, stroke: number): string | null {
  switch (style) {
    case "solid":
      return null;
    case "dashed":
      return `${stroke * 4} ${stroke * 2}`;
    case "dotted":
      return `${stroke * 0.01} ${stroke * 1.8}`;
  }
}

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
    case "open-triangle":
      return (
        <polygon
          points={polygon}
          fill="white"
          stroke="white"
          strokeWidth={outline * 2}
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

function RectGlyph({
  rect,
  imageWidthPx,
  imageHeightPx,
  color,
  thickness,
  filled = false,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  imageWidthPx: number;
  imageHeightPx: number;
  /** See ArrowGlyph.color for the resolution rationale. Same shape. */
  color?: "auto" | string | undefined;
  /** Optional stroke-thickness override. See ArrowGlyph.thickness. */
  thickness?: OverlayThickness | undefined;
  /** When true, the rect renders as a solid fill in `accent` rather
   *  than a stroke-only outline. The halo (white under-stroke) is
   *  skipped because a filled rect already reads at full contrast. */
  filled?: boolean | undefined;
  isDraft?: boolean;
}): ReactElement {
  // Stroke width scaled by image short-side, like the arrow's. Pixel-
  // space — multiplied here once so the rect's halo/colored strokes
  // both land in the parent SVG's pixel viewBox units.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const autoStrokeFraction = Math.min(0.012, Math.max(0.003, 8 / shortSide));
  const strokeWidthPx = readOverlayThickness(thickness, autoStrokeFraction) * shortSide;
  const outline = Math.max(strokeWidthPx * 0.25, 1.5);
  // Pixel-space rect dimensions.
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
  if (filled) {
    // Solid fill — single rect, no halo. The fill IS the glyph; a
    // halo around a solid fill would just shrink-wrap the same color
    // and add nothing.
    return (
      <g>
        <rect
          x={rx}
          y={ry}
          width={rw}
          height={rh}
          fill={accent}
          stroke="none"
        />
      </g>
    );
  }
  return (
    <g>
      <rect
        x={rx}
        y={ry}
        width={rw}
        height={rh}
        fill="none"
        stroke="white"
        strokeWidth={strokeWidthPx + outline * 2}
        strokeLinejoin="round"
      />
      <rect
        x={rx}
        y={ry}
        width={rw}
        height={rh}
        fill="none"
        stroke={accent}
        strokeWidth={strokeWidthPx}
        strokeLinejoin="round"
      />
    </g>
  );
}

function HighlightGlyph({
  rect,
  color,
  opacity,
  blend,
  imageWidthPx,
  imageHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Optional explicit color. v2-editor refresh: legacy rows (no
   *  color field) fall back to the historical yellow marker hue. */
  color?: "auto" | string | undefined;
  /** Optional 0..1 opacity. Legacy rows fall back to the marker-pen
   *  default (0.32 applied, 0.45 draft). */
  opacity?: number | undefined;
  /** CSS mix-blend-mode for the highlight rect. Mirrors the
   *  HighlightOverlay's optional `blend` field — `multiply` darkens
   *  the area below (classic marker-pen look on light bg), `screen`
   *  brightens (good for dark UI), `overlay` combines both for
   *  high-contrast emphasis. Legacy rows without blend fall back to
   *  `multiply` (the historical hardcoded behavior was implicit
   *  multiply via fill+opacity, even though no actual blend-mode
   *  was set — this default keeps existing captures looking the
   *  same). */
  blend?: "multiply" | "screen" | "overlay" | undefined;
  imageWidthPx: number;
  imageHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  // Legacy marker yellow + opacity tunings preserved as defaults for
  // back-compat — rows drawn before HighlightOverlay's color/opacity
  // fields existed render exactly as they did pre-Phase-3.1.
  const baseHex =
    color === undefined || color === "auto"
      ? "rgb(255, 220, 80)"
      : color;
  // Slightly more opaque on draft so the user sees the drag clearly.
  const fillOpacity =
    opacity !== undefined
      ? (isDraft ? Math.min(1, opacity * 1.4) : opacity)
      : isDraft
      ? 0.45
      : 0.32;
  // Resolved blend mode for the CSS mix-blend-mode attribute on the
  // <rect>. SVG 2 supports mix-blend-mode via the `style` attribute;
  // Chromium honors it on individual SVG children, so the highlight
  // rect blends only with the canvas below — NOT with other overlays
  // (which sit in the same SVG and don't have blend modes applied).
  const resolvedBlend = blend ?? "multiply";
  return (
    <rect
      x={rect.x * imageWidthPx}
      y={rect.y * imageHeightPx}
      width={rect.w * imageWidthPx}
      height={rect.h * imageHeightPx}
      fill={baseHex}
      fillOpacity={fillOpacity}
      stroke="none"
      style={{ mixBlendMode: resolvedBlend }}
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
  imageHeightPx: number
): { x: number; y: number; w: number; h: number } {
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const fontSizePx =
    data.size === "large"
      ? shortSide / 18
      : data.size === "medium"
        ? shortSide / 30
        : shortSide / 50;
  const lines = data.body.split("\n");
  const lineCount = Math.max(1, lines.length);
  const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const charAdvance = 0.55;
  const naturalWidthPx = maxChars * fontSizePx * charAdvance;
  const naturalHeightPx = fontSizePx * (lineCount * 1.2 - 0.2);
  return {
    x: data.point.x,
    // `fontSizePx / 2` is the half-glyph-height in pixels;
    // divide by imageHeightPx to convert to normalized [0,1].
    // Parens kept explicit — without them the chain
    // `fontSizePx / 2 / imageHeightPx` parses identically but reads
    // ambiguously to anyone scanning the line.
    y: data.point.y - (fontSizePx / 2) / imageHeightPx,
    w: naturalWidthPx / imageWidthPx,
    h: naturalHeightPx / imageHeightPx
  };
}

/** Phase 3.2 selection outline. Draws a 1px accent dashed rectangle
 *  around the selected overlay's bounding box, in normalized [0,1]
 *  coords. The outline is a glyph (not interactive); the pointerdown
 *  handler in Editor.tsx owns selection clear / re-select. */
function SelectionOutline({
  data,
  imageWidthPx,
  imageHeightPx
}: {
  data: OverlayRow["data"];
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement | null {
  // Derive a normalized bounding box for each overlay kind.
  let box: { x: number; y: number; w: number; h: number } | null = null;
  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
    box = data.rect;
  } else if (data.kind === "arrow") {
    // No bounding box for arrows. An axis-aligned rect drawn around the
    // arrow's extents is the WRONG shape (the arrow itself is a line,
    // not a rect) — it just adds visual noise. The TransformHandles
    // component renders 2 endpoint handles (`from` + `to`) which
    // already communicate "this arrow is selected" without redrawing
    // the user's annotation as a misleading box. Return null.
    return null;
  } else if (data.kind === "text") {
    box = textBoundsBox(data, imageWidthPx, imageHeightPx);
  } else if (data.kind === "crop") {
    box = data.rect;
  }
  if (box === null) return null;
  // Pad slightly so the outline doesn't sit ON the stroke. Normalized
  // padding (0.006 of each axis) converts cleanly to pixel space below.
  const pad = 0.006;
  const xn = Math.max(0, box.x - pad);
  const yn = Math.max(0, box.y - pad);
  const wn = Math.min(1 - xn, box.w + pad * 2);
  const hn = Math.min(1 - yn, box.h + pad * 2);
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
  return (
    <g data-testid="selection-outline">
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
  | "body";

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

/** Compute handle positions for a given overlay. Returns null for
 *  overlay kinds that don't expose drag handles in Phase 3.5 (crop —
 *  has its own CropTool overlay). */
function handlesForOverlay(data: OverlayRow["data"]): HandleDescriptor[] | null {
  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
    const { x, y, w, h } = data.rect;
    return [
      { kind: "nw", xn: x, yn: y, cursor: cornerCursor("nw") },
      { kind: "ne", xn: x + w, yn: y, cursor: cornerCursor("ne") },
      { kind: "se", xn: x + w, yn: y + h, cursor: cornerCursor("se") },
      { kind: "sw", xn: x, yn: y + h, cursor: cornerCursor("sw") },
      { kind: "n", xn: x + w / 2, yn: y, cursor: edgeCursor("n") },
      { kind: "e", xn: x + w, yn: y + h / 2, cursor: edgeCursor("e") },
      { kind: "s", xn: x + w / 2, yn: y + h, cursor: edgeCursor("s") },
      { kind: "w", xn: x, yn: y + h / 2, cursor: edgeCursor("w") }
    ];
  }
  if (data.kind === "arrow") {
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
    return [];
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
 *  handle to compute a translation delta. Resize handles ignore it. */
function geometryFromDrag(
  data: OverlayRow["data"],
  handle: HandleKind,
  newXn: number,
  newYn: number,
  startPt: { xn: number; yn: number }
): GeometryUpdate | null {
  // Body-translate: shift every coordinate by the pointer delta from
  // pointerdown, clamping so no part of the layer escapes the canvas.
  // The translation is computed against the PRE-DRAG `data` snapshot,
  // so successive pointermoves don't compound drift.
  if (handle === "body") {
    const dx = newXn - startPt.xn;
    const dy = newYn - startPt.yn;
    if (data.kind === "arrow") {
      // Clamp the delta so neither endpoint leaves [0,1]. Compute
      // the tightest min/max delta across both endpoints, then clamp.
      const minDx = -Math.min(data.from.x, data.to.x);
      const maxDx = 1 - Math.max(data.from.x, data.to.x);
      const minDy = -Math.min(data.from.y, data.to.y);
      const maxDy = 1 - Math.max(data.from.y, data.to.y);
      const ddx = Math.max(minDx, Math.min(maxDx, dx));
      const ddy = Math.max(minDy, Math.min(maxDy, dy));
      return {
        kind: "arrow",
        from: { x: data.from.x + ddx, y: data.from.y + ddy },
        to: { x: data.to.x + ddx, y: data.to.y + ddy }
      };
    }
    if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
      const { x, y, w, h } = data.rect;
      const ddx = Math.max(-x, Math.min(1 - (x + w), dx));
      const ddy = Math.max(-y, Math.min(1 - (y + h), dy));
      return { kind: "rect", rect: { x: x + ddx, y: y + ddy, w, h } };
    }
    if (data.kind === "text") {
      const ddx = Math.max(-data.point.x, Math.min(1 - data.point.x, dx));
      const ddy = Math.max(-data.point.y, Math.min(1 - data.point.y, dy));
      return {
        kind: "text",
        point: { x: data.point.x + ddx, y: data.point.y + ddy }
      };
    }
    if (data.kind === "step") {
      const ddx = Math.max(-data.point.x, Math.min(1 - data.point.x, dx));
      const ddy = Math.max(-data.point.y, Math.min(1 - data.point.y, dy));
      return {
        kind: "step",
        point: { x: data.point.x + ddx, y: data.point.y + ddy }
      };
    }
    return null;
  }

  // Clamp the new position to [0,1] so the user can't drag a handle
  // off the canvas (the underlying schemas reject out-of-range values).
  const cx = Math.max(0, Math.min(1, newXn));
  const cy = Math.max(0, Math.min(1, newYn));

  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
    const { x, y, w, h } = data.rect;
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
  const handles = useMemo(() => handlesForOverlay(data), [data]);
  // Bounding box for the body-hit rect, computed from the same
  // `data` snapshot the handles use so the body follows during a
  // live drag.
  const bodyBox = useMemo(
    () => bodyBoxForOverlay(data, imageWidthPx, imageHeightPx),
    [data, imageWidthPx, imageHeightPx]
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
      const geometry = geometryFromDrag(startData, handle, pt.xn, pt.yn, startPt);
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
    [clientToNormalized, onGeometryDrag]
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
      const geometry = geometryFromDrag(startData, handle, pt.xn, pt.yn, startPt);
      if (geometry !== null) {
        onGeometryChange(geometry);
      }
      // Don't immediately clear liveData — wait for the refetch to land
      // so we don't blink to the pre-drag position. The useEffect on
      // selectedOverlay.id above clears it when the new layer arrives.
      onDragEnd?.();
    },
    [clientToNormalized, onDragEnd, onGeometryChange]
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
        pointerEvents: "none"
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
          aria-label={selectedOverlay.data.kind === "text" ? "Move or double-click to edit text" : "Move layer"}
          tabIndex={-1}
          onPointerDown={(e) => onPointerDown(e, "body")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // Double-click on a TEXT overlay re-opens the draft input
          // with the existing body pre-filled. The caller's
          // onRequestEdit handler is responsible for removing /
          // replacing the existing overlay so the user doesn't end
          // up with two copies. Non-text kinds ignore the dblclick
          // — there's nothing equivalent to "edit the body" for an
          // arrow or rect.
          onDoubleClick={
            selectedOverlay.data.kind === "text" && onRequestEdit !== undefined
              ? (e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  onRequestEdit(selectedOverlay);
                }
              : undefined
          }
          style={{
            position: "absolute",
            left: `${bodyBox.x * 100}%`,
            top: `${bodyBox.y * 100}%`,
            width: `${bodyBox.w * 100}%`,
            height: `${bodyBox.h * 100}%`,
            cursor: selectedOverlay.data.kind === "text" ? "text" : "move",
            pointerEvents: "auto",
            // Transparent — the body is a hit target only. Painting
            // is owned by OverlaySvg / BlurOverlays.
            background: "transparent"
          }}
        />
      )}
      {handles.map((h) => (
        <div
          key={h.kind}
          className="editor-transform-handle"
          data-testid={`transform-handle-${h.kind}`}
          data-handle-kind={h.kind}
          role="button"
          aria-label={`Resize handle ${h.kind}`}
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
            zIndex: 1
          }}
        />
      ))}
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
  imageHeightPx: number
): { x: number; y: number; w: number; h: number } | null {
  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
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
    return textBoundsBox(data, imageWidthPx, imageHeightPx);
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

/** Local mirror of `applyGeometryToOverlay` — used to update the
 *  in-component liveData during pointermove without round-tripping
 *  through useCaptureModel. Kept in this file to avoid a circular
 *  import (useCaptureModel already imports things from here implicitly
 *  via the dispatcher; OverlaySvg should remain a leaf). */
function applyGeometryLocally(
  data: OverlayRow["data"],
  geometry: GeometryUpdate
): OverlayRow["data"] | null {
  switch (geometry.kind) {
    case "arrow":
      if (data.kind !== "arrow") return null;
      return { ...data, from: geometry.from, to: geometry.to };
    case "rect":
      if (data.kind !== "rect" && data.kind !== "highlight" && data.kind !== "blur") {
        return null;
      }
      return { ...data, rect: geometry.rect };
    case "text":
      if (data.kind !== "text") return null;
      return { ...data, point: geometry.point };
    case "step":
      if (data.kind !== "step") return null;
      return { ...data, point: geometry.point };
  }
}

// Suppress unused-symbol churn for the geometry types we re-export.
export type { GeometryUpdate, NormalizedPoint, NormalizedRect };

function TextGlyph({
  point,
  body,
  size,
  weight,
  imageWidthPx,
  imageHeightPx,
  color
}: {
  point: { x: number; y: number };
  body: string;
  size: "small" | "medium" | "large";
  /** Resolved CSS font-weight number — pass through `readTextWeight`
   *  from `@pwrsnap/shared` so the legacy fallback (600) and the
   *  popover values (regular=400, bold=700) all funnel through one
   *  place. */
  weight: number;
  imageWidthPx: number;
  imageHeightPx: number;
  /** See ArrowGlyph.color. */
  color?: "auto" | string | undefined;
}): ReactElement {
  // Font size derived from image short-side, matching the bake.
  // Three buckets at ~1.7× ratios so users can actually tell them
  // apart in the popover — the old 60/30 split made "small" too tiny
  // to read at typical zooms and the medium/large gap was too small
  // to be useful.
  //   small  ≈ shortSide / 50  (e.g. 38 px on a 1920-px-tall image)
  //   medium ≈ shortSide / 30  (e.g. 64 px)
  //   large  ≈ shortSide / 18  (e.g. 107 px)
  // Same values in the bake; see compose.ts textSvg.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const fontSizePx =
    size === "large" ? shortSide / 18 : size === "medium" ? shortSide / 30 : shortSide / 50;
  const accent =
    color !== undefined && color !== "auto" ? color : "var(--accent, #ff8a1f)";
  // Multi-line support: body may contain "\n" from the Shift+Enter
  // path in the draft input. Split, emit one <tspan> per line with
  // dy="1.2em" advancing the baseline. Single-line bodies keep their
  // original placement exactly (the first tspan has dy="0").
  const lines = body.split("\n");
  // Pixel-space anchor. The historical aspectCompensation `scale(H/W,1)`
  // wrapper is gone — that hack only existed to undo the non-uniform
  // viewBox stretch from preserveAspectRatio="none" on a 1×1 viewBox.
  // With a pixel-space viewBox text renders isotropically by default,
  // no extra transform needed.
  //
  // Vertically center the FIRST line on the click point — matches the
  // draft input's `translateY(-50%)` so the text doesn't jump on
  // commit. Subsequent lines extend downward via `dy="1.2em"` per
  // tspan, which is the conventional layout for multi-line annotation.
  const px = point.x * imageWidthPx;
  const py = point.y * imageHeightPx;
  return (
    <g transform={`translate(${px} ${py})`}>
      <text
        x={0}
        y={0}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSizePx}
        fontWeight={weight}
        fill="white"
        stroke="rgba(0,0,0,0.6)"
        strokeWidth={fontSizePx * 0.08}
        paintOrder="stroke"
        dominantBaseline="central"
      >
        {lines.map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? "0em" : "1.2em"}>
            {line}
          </tspan>
        ))}
      </text>
      <text
        x={0}
        y={0}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSizePx}
        fontWeight={weight}
        fill={accent}
        dominantBaseline="central"
      >
        {lines.map((line, i) => (
          <tspan key={i} x={0} dy={i === 0 ? "0em" : "1.2em"}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}
