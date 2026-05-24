// Editor canvas overlay layer — single <svg> with viewBox="0 0 1 1"
// that renders every committed overlay PLUS the live-drag draft on
// top. Glyphs are coordinate-normalized to [0,1]² so they render
// identically regardless of canvas display size, and so the bake
// (compose.ts) can reuse the same shape math at source-pixel
// resolution.
//
// Extracted from Editor.tsx as part of the v1 polish round so the
// Editor file itself stays focused on state/handlers/effects.

import { useMemo, type ReactElement } from "react";
import type { ArrowEndStyle, ArrowStemStyle, OverlayRow } from "@pwrsnap/shared";
import {
  computeArrowGeometry,
  readArrowDoubleEnded,
  readArrowEndStyle,
  readArrowStemStyle
} from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";

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
}

export function OverlaySvg({
  overlays,
  draft,
  draftStyle,
  imageWidthPx,
  imageHeightPx,
  selectedLayerId = null
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
}): ReactElement {
  // Blur overlays render outside this SVG via <BlurOverlays> — HTML
  // divs with backdrop-filter, so the live preview ACTUALLY blurs
  // the underlying image. SVG <filter> can blur SVG content but
  // can't reach behind itself to blur a sibling <img>.
  const viewBox = "0 0 1 1";
  const arrows = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "arrow" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  const rects = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "rect" ? [{ row, data: row.data }] : [])),
    [overlays]
  );
  const highlights = useMemo(
    () =>
      overlays.flatMap((row) =>
        row.data.kind === "highlight"
          ? [
              {
                row,
                data: row.data as Extract<typeof row.data, { kind: "highlight" }>
              }
            ]
          : []
      ),
    [overlays]
  );
  const texts = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "text" ? [{ row, data: row.data }] : [])),
    [overlays]
  );

  // Live-rect for rect/highlight/blur drags, computed once so all
  // three branches can share.
  const liveRect = draft !== null && draft.kind === "rect-drag" ? rectFromDrag(draft) : null;

  return (
    <svg className="editor-svg" viewBox={viewBox} preserveAspectRatio="none">
      {/* Highlights painted first so they sit beneath rects/arrows. */}
      {highlights.map(({ row, data }) => (
        <HighlightGlyph
          key={row.id}
          rect={data.rect}
          color={data.color}
          opacity={data.opacity}
        />
      ))}
      {rects.map(({ row, data }) => (
        <RectGlyph
          key={row.id}
          rect={data.rect}
          color={data.color}
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
        const sel = overlays.find((r) => r.id === selectedLayerId);
        if (sel === undefined) return null;
        return <SelectionOutline data={sel.data} />;
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
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
          isDraft
        />
      )}
      {draft?.kind === "rect-drag" && liveRect !== null && (
        <>
          {draft.tool === "highlight" && (
            <HighlightGlyph rect={liveRect} color={draftStyle?.color} isDraft />
          )}
          {draft.tool === "rect" && (
            <RectGlyph
              rect={liveRect}
              color={draftStyle?.color}
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
  isDraft?: boolean;
}): ReactElement {
  const resolvedEndStyle: ArrowEndStyle = endStyle ?? "filled-triangle";
  const resolvedStemStyle: ArrowStemStyle = stemStyle ?? "solid";
  const headGeom = computeArrowGeometry({
    from: { x: fromXn, y: fromYn },
    to: { x: toXn, y: toYn },
    imageWidthPx,
    imageHeightPx
  });
  // Secondary geometry for double-ended arrows — swap from/to so the
  // tail-end head's triangle points at `from` with its base centered
  // along the stem.
  const tailGeom = doubleEnded
    ? computeArrowGeometry({
        from: { x: toXn, y: toYn },
        to: { x: fromXn, y: fromYn },
        imageWidthPx,
        imageHeightPx
      })
    : null;
  const stroke = headGeom.strokeFraction;
  const outline = Math.max(stroke * 0.25, 0.0015);
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
  // stem at the geometric base instead of the apex.
  const stemEndAtTo = stemEndpointFor(resolvedEndStyle, headGeom);
  const stemEndAtFrom = tailGeom !== null ? stemEndpointFor(resolvedEndStyle, tailGeom) : null;
  const fromPoint = stemEndAtFrom ?? { x: headGeom.from.x, y: headGeom.from.y };

  // Stroke-dash pattern. Scaled by stem stroke width so dash density
  // stays visually consistent across image sizes. dotted gets round
  // caps so the dots look like dots, not stripes.
  const dashStem = stemDashFor(resolvedStemStyle, stroke);

  return (
    <g strokeLinejoin="round">
      {/* Stem halo — solid white under-stroke regardless of stem
          style. Drawing the halo dashed would let the dark image
          show through the gaps and defeat the legibility purpose. */}
      <line
        x1={fromPoint.x}
        y1={fromPoint.y}
        x2={stemEndAtTo.x}
        y2={stemEndAtTo.y}
        stroke="white"
        strokeWidth={stroke + outline * 2}
        strokeLinecap="round"
        fill="none"
      />
      {/* Head halo at the `to` endpoint. */}
      <ArrowHeadHalo style={resolvedEndStyle} geom={headGeom} outline={outline} stroke={stroke} />
      {/* Mirrored head halo at the `from` endpoint (double-ended). */}
      {tailGeom !== null && (
        <ArrowHeadHalo style={resolvedEndStyle} geom={tailGeom} outline={outline} stroke={stroke} />
      )}
      {/* Colored stem on top of the halo. */}
      <line
        x1={fromPoint.x}
        y1={fromPoint.y}
        x2={stemEndAtTo.x}
        y2={stemEndAtTo.y}
        stroke={accent}
        strokeWidth={stroke}
        strokeLinecap={resolvedStemStyle === "dotted" ? "round" : "round"}
        strokeDasharray={dashStem ?? undefined}
        fill="none"
      />
      {/* Colored head at the `to` endpoint. */}
      <ArrowHead style={resolvedEndStyle} geom={headGeom} stroke={stroke} accent={accent} />
      {/* Mirrored colored head at the `from` endpoint (double-ended). */}
      {tailGeom !== null && (
        <ArrowHead style={resolvedEndStyle} geom={tailGeom} stroke={stroke} accent={accent} />
      )}
    </g>
  );
}

/** Return where the stem should terminate for a given head style.
 *  - filled-triangle / open-triangle: pull back to baseCenter (head
 *    triangle takes over from there).
 *  - line: stop at the apex; the perpendicular bar overlaps the stem
 *    end cleanly.
 *  - dot: stop at the apex; the dot is centered on `to` and the stem
 *    runs to its center (which is the visual end of the arrow). */
function stemEndpointFor(
  style: ArrowEndStyle,
  geom: ReturnType<typeof computeArrowGeometry>
): { x: number; y: number } {
  switch (style) {
    case "filled-triangle":
    case "open-triangle":
      return { x: geom.baseCenter.x, y: geom.baseCenter.y };
    case "line":
    case "dot":
      return { x: geom.to.x, y: geom.to.y };
  }
}

/** Compute the SVG `stroke-dasharray` string for the stem style.
 *  Returns null for solid (no attribute emitted). All values are in
 *  the same normalized [0,1] space as `stroke`. */
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
 *  head so the entire glyph reads on busy backgrounds. */
function ArrowHeadHalo({
  style,
  geom,
  outline,
  stroke
}: {
  style: ArrowEndStyle;
  geom: ReturnType<typeof computeArrowGeometry>;
  outline: number;
  stroke: number;
}): ReactElement {
  const polygon = `${geom.to.x},${geom.to.y} ${geom.baseLeft.x},${geom.baseLeft.y} ${geom.baseRight.x},${geom.baseRight.y}`;
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
          x1={geom.baseLeft.x}
          y1={geom.baseLeft.y}
          x2={geom.baseRight.x}
          y2={geom.baseRight.y}
          stroke="white"
          strokeWidth={stroke + outline * 2}
          strokeLinecap="round"
        />
      );
    case "dot": {
      const r = stroke * 1.5;
      return (
        <circle
          cx={geom.to.x}
          cy={geom.to.y}
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
  accent
}: {
  style: ArrowEndStyle;
  geom: ReturnType<typeof computeArrowGeometry>;
  stroke: number;
  accent: string;
}): ReactElement {
  const polygon = `${geom.to.x},${geom.to.y} ${geom.baseLeft.x},${geom.baseLeft.y} ${geom.baseRight.x},${geom.baseRight.y}`;
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
          x1={geom.baseLeft.x}
          y1={geom.baseLeft.y}
          x2={geom.baseRight.x}
          y2={geom.baseRight.y}
          stroke={accent}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      );
    case "dot": {
      const r = stroke * 1.5;
      return <circle cx={geom.to.x} cy={geom.to.y} r={r} fill={accent} />;
    }
  }
}

function RectGlyph({
  rect,
  imageWidthPx,
  imageHeightPx,
  color,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  imageWidthPx: number;
  imageHeightPx: number;
  /** See ArrowGlyph.color for the resolution rationale. Same shape. */
  color?: "auto" | string | undefined;
  isDraft?: boolean;
}): ReactElement {
  // Stroke width scaled by image short-side, like the arrow's. We
  // compute via computeArrowGeometry across the diagonal so the
  // stroke matches the arrow's visual weight on the same image.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const strokeFraction = Math.min(0.012, Math.max(0.003, 8 / shortSide));
  const outline = Math.max(strokeFraction * 0.25, 0.0015);
  const accent =
    color !== undefined && color !== "auto"
      ? color
      : isDraft
      ? "var(--accent-strong, #ffa33d)"
      : "var(--accent, #ff8a1f)";
  return (
    <g>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke="white"
        strokeWidth={strokeFraction + outline * 2}
        strokeLinejoin="round"
      />
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke={accent}
        strokeWidth={strokeFraction}
        strokeLinejoin="round"
      />
    </g>
  );
}

function HighlightGlyph({
  rect,
  color,
  opacity,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Optional explicit color. v2-editor refresh: legacy rows (no
   *  color field) fall back to the historical yellow marker hue. */
  color?: "auto" | string | undefined;
  /** Optional 0..1 opacity. Legacy rows fall back to the marker-pen
   *  default (0.32 applied, 0.45 draft). */
  opacity?: number | undefined;
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
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill={baseHex}
      fillOpacity={fillOpacity}
      stroke="none"
    />
  );
}

/** Phase 3.2 selection outline. Draws a 1px accent dashed rectangle
 *  around the selected overlay's bounding box, in normalized [0,1]
 *  coords. The outline is a glyph (not interactive); the pointerdown
 *  handler in Editor.tsx owns selection clear / re-select. */
function SelectionOutline({
  data
}: {
  data: OverlayRow["data"];
}): ReactElement | null {
  // Derive a normalized bounding box for each overlay kind.
  let box: { x: number; y: number; w: number; h: number } | null = null;
  if (data.kind === "rect" || data.kind === "highlight" || data.kind === "blur") {
    box = data.rect;
  } else if (data.kind === "arrow") {
    const x = Math.min(data.from.x, data.to.x);
    const y = Math.min(data.from.y, data.to.y);
    const w = Math.abs(data.to.x - data.from.x);
    const h = Math.abs(data.to.y - data.from.y);
    box = { x, y, w, h };
  } else if (data.kind === "text") {
    // Small fixed box around the text anchor point. The actual
    // rendered glyph extends to the right/down; a tight box would
    // miss most of the glyph. Approximate at 12% width × 4% height.
    box = {
      x: Math.max(0, data.point.x - 0.005),
      y: Math.max(0, data.point.y - 0.005),
      w: 0.12,
      h: 0.04
    };
  } else if (data.kind === "crop") {
    box = data.rect;
  }
  if (box === null) return null;
  // Pad slightly so the outline doesn't sit ON the stroke.
  const pad = 0.006;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const w = Math.min(1 - x, box.w + pad * 2);
  const h = Math.min(1 - y, box.h + pad * 2);
  const stroke = "var(--accent, #ff8a1f)";
  const strokeW = 0.003;
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
        strokeDasharray="0.012 0.008"
      />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeW}
        strokeDasharray="0.012 0.008"
      />
    </g>
  );
}

function TextGlyph({
  point,
  body,
  size,
  imageWidthPx,
  imageHeightPx,
  color
}: {
  point: { x: number; y: number };
  body: string;
  size: "small" | "large";
  imageWidthPx: number;
  imageHeightPx: number;
  /** See ArrowGlyph.color. */
  color?: "auto" | string | undefined;
}): ReactElement {
  // Font size derived from image short-side, matching the bake.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const sizePx = size === "large" ? shortSide / 30 : shortSide / 60;
  const fontSize = sizePx / shortSide;
  const accent =
    color !== undefined && color !== "auto" ? color : "var(--accent, #ff8a1f)";
  return (
    <g>
      <text
        x={point.x}
        y={point.y}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSize}
        fontWeight={600}
        fill="white"
        stroke="rgba(0,0,0,0.6)"
        strokeWidth={fontSize * 0.08}
        paintOrder="stroke"
        dominantBaseline="hanging"
      >
        {body}
      </text>
      <text
        x={point.x}
        y={point.y}
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize={fontSize}
        fontWeight={600}
        fill={accent}
        dominantBaseline="hanging"
      >
        {body}
      </text>
    </g>
  );
}
