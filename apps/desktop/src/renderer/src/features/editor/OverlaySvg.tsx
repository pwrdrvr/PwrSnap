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
import type { OverlayRow } from "@pwrsnap/shared";
import { computeArrowGeometry } from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";

export function OverlaySvg({
  overlays,
  draft,
  imageWidthPx,
  imageHeightPx
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
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
        row.data.kind === "highlight" ? [{ row, data: row.data }] : []
      ),
    [overlays]
  );
  const blurs = useMemo(
    () =>
      overlays.flatMap((row) => (row.data.kind === "blur" ? [{ row, data: row.data }] : [])),
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
        <HighlightGlyph key={row.id} rect={data.rect} />
      ))}
      {blurs.map(({ row, data }) => (
        <BlurGlyph key={row.id} rect={data.rect} />
      ))}
      {rects.map(({ row, data }) => (
        <RectGlyph
          key={row.id}
          rect={data.rect}
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
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
        />
      ))}

      {/* Drafts (live-drag preview) rendered last so they're on top. */}
      {draft?.kind === "arrow" && (
        <ArrowGlyph
          fromXn={draft.fromXn}
          fromYn={draft.fromYn}
          toXn={draft.toXn}
          toYn={draft.toYn}
          imageWidthPx={imageWidthPx}
          imageHeightPx={imageHeightPx}
          isDraft
        />
      )}
      {draft?.kind === "rect-drag" && liveRect !== null && (
        <>
          {draft.tool === "highlight" && <HighlightGlyph rect={liveRect} isDraft />}
          {draft.tool === "blur" && <BlurGlyph rect={liveRect} isDraft />}
          {draft.tool === "rect" && (
            <RectGlyph
              rect={liveRect}
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
  isDraft = false
}: {
  fromXn: number;
  fromYn: number;
  toXn: number;
  toYn: number;
  imageWidthPx: number;
  imageHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  const geom = computeArrowGeometry({
    from: { x: fromXn, y: fromYn },
    to: { x: toXn, y: toYn },
    imageWidthPx,
    imageHeightPx
  });
  const headPolygon = `${geom.to.x},${geom.to.y} ${geom.baseLeft.x},${geom.baseLeft.y} ${geom.baseRight.x},${geom.baseRight.y}`;
  const stroke = geom.strokeFraction;
  const outline = Math.max(stroke * 0.25, 0.0015);
  const accent = isDraft ? "var(--accent-strong, #ffa33d)" : "var(--accent, #ff8a1f)";
  return (
    <g strokeLinecap="round" strokeLinejoin="round">
      <line
        x1={geom.from.x}
        y1={geom.from.y}
        x2={geom.baseCenter.x}
        y2={geom.baseCenter.y}
        stroke="white"
        strokeWidth={stroke + outline * 2}
        fill="none"
      />
      <polygon
        points={headPolygon}
        fill="white"
        stroke="white"
        strokeWidth={outline * 2}
      />
      <line
        x1={geom.from.x}
        y1={geom.from.y}
        x2={geom.baseCenter.x}
        y2={geom.baseCenter.y}
        stroke={accent}
        strokeWidth={stroke}
        fill="none"
      />
      <polygon points={headPolygon} fill={accent} />
    </g>
  );
}

function RectGlyph({
  rect,
  imageWidthPx,
  imageHeightPx,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  imageWidthPx: number;
  imageHeightPx: number;
  isDraft?: boolean;
}): ReactElement {
  // Stroke width scaled by image short-side, like the arrow's. We
  // compute via computeArrowGeometry across the diagonal so the
  // stroke matches the arrow's visual weight on the same image.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const strokeFraction = Math.min(0.012, Math.max(0.003, 8 / shortSide));
  const outline = Math.max(strokeFraction * 0.25, 0.0015);
  const accent = isDraft ? "var(--accent-strong, #ffa33d)" : "var(--accent, #ff8a1f)";
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
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  isDraft?: boolean;
}): ReactElement {
  // Yellow translucent fill — the marker-pen look. Slightly more
  // opaque on draft so the user sees the drag clearly.
  return (
    <rect
      x={rect.x}
      y={rect.y}
      width={rect.w}
      height={rect.h}
      fill={isDraft ? "rgba(255, 220, 80, 0.45)" : "rgba(255, 220, 80, 0.32)"}
      stroke="none"
    />
  );
}

function BlurGlyph({
  rect,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  isDraft?: boolean;
}): ReactElement {
  // Live preview: a translucent gray block with a "frosted" pattern.
  // The actual blur is applied in the bake — the live render just
  // signals "this region will be blurred when copied/exported".
  return (
    <g>
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={isDraft ? "rgba(40, 40, 50, 0.55)" : "rgba(40, 40, 50, 0.45)"}
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={0.0015}
        strokeDasharray="0.005 0.005"
      />
    </g>
  );
}

function TextGlyph({
  point,
  body,
  size,
  imageWidthPx,
  imageHeightPx
}: {
  point: { x: number; y: number };
  body: string;
  size: "small" | "large";
  imageWidthPx: number;
  imageHeightPx: number;
}): ReactElement {
  // Font size derived from image short-side, matching the bake.
  const shortSide = Math.min(imageWidthPx, imageHeightPx);
  const sizePx = size === "large" ? shortSide / 30 : shortSide / 60;
  const fontSize = sizePx / shortSide;
  const accent = "var(--accent, #ff8a1f)";
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
