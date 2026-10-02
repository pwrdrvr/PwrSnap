// The picture in a Draw mode button's tooltip: what the next drag will
// paint, in the color and weight it will paint with.
//
// It is drawn the way the canvas draws a stroke — `StrokeGlyph`, the
// shared `strokeGeometries`, the eraser's own `StrokeEraseSession` — on a
// tiny canvas, so the marker's see-through overlap, the airbrush's soft
// bands and the eraser's cut are the real ones, not an illustration of
// them. Registered with the app's fast tooltip under `DRAW_MODE_TIP`
// (lib/tip-previews.ts); a mode button opts in with `drawModeTipProps`.

import type { ReactElement } from "react";
import {
  eraserRadiusPx,
  StrokeEraseSession,
  strokePointsFromSegments,
  strokePointsToPx,
  type DrawToolMode,
  type DrawToolStyle,
  type OverlayThickness,
  type StrokeOverlay
} from "@pwrsnap/shared";
import { registerTipPreview } from "../../lib/tip-previews";
import { StrokeGlyph } from "./OverlaySvg";
import { resolveToolColor } from "./resolveToolColor";

export const DRAW_MODE_TIP = "draw-mode";

/** The preview canvas, in pixels. */
const W = 204;
const H = 72;
/** The annotation basis the preview sizes strokes off. One basis for
 *  every mode, so the modes keep their real widths relative to each other
 *  (a marker and an airbrush are the same width) and the presets keep
 *  theirs (a pen is 2.5…9 px, S…XL). It is about twice the ratio a
 *  capture draws at, because the airbrush only fades across the outer
 *  fifth of its width: any thinner and its soft edge is under a pixel,
 *  and it reads as a fat pen. */
const BASIS = 400;

const MODES: readonly DrawToolMode[] = ["pen", "marker", "airbrush", "eraser"];

/** A wave across the box, the pen's preview and what the eraser cuts. */
const WAVE = Array.from({ length: 33 }, (_, i) => {
  const t = i / 32;
  return { x: 0.09 + t * 0.82, y: 0.6 - 0.24 * Math.sin(t * Math.PI * 2.2 + 0.4) };
});

/** An arc, the airbrush's preview. */
const ARC = Array.from({ length: 17 }, (_, i) => {
  const t = i / 16;
  return { x: 0.14 + t * 0.73, y: 0.66 - 0.62 * t * (1 - t) * 1.6 };
});

/** Two marker passes that cross, as segments of one row: each paints on
 *  its own, so the crossing darkens the way two real passes do. */
const MARKER = strokePointsFromSegments([
  [
    { x: 0.06, y: 0.48 },
    { x: 0.74, y: 0.48 }
  ],
  [
    { x: 0.55, y: 0.18 },
    { x: 0.93, y: 0.8 }
  ]
]);

type PreviewStyle = {
  readonly mode: DrawToolMode;
  readonly color: string;
  readonly thickness: OverlayThickness;
};

/** The data attributes a Draw mode button carries for its tooltip. */
export function drawModeTipProps(
  mode: DrawToolMode,
  style: Pick<DrawToolStyle, "color" | "thickness">
): Record<string, string> {
  return {
    "data-tip-preview": DRAW_MODE_TIP,
    "data-draw-mode": mode,
    "data-draw-color": resolveToolColor(style.color),
    "data-draw-thickness": String(style.thickness)
  };
}

function readThickness(raw: string | undefined): OverlayThickness {
  if (raw === undefined || raw === "") return "auto";
  const n = Number(raw);
  if (Number.isFinite(n)) return n > 0 && n <= 1 ? n : "auto";
  return raw === "small" || raw === "medium" || raw === "large" || raw === "x-large" ? raw : "auto";
}

function readStyle(anchor: HTMLElement): PreviewStyle | null {
  const mode = MODES.find((m) => m === anchor.dataset.drawMode);
  if (mode === undefined) return null;
  return {
    mode,
    color: anchor.dataset.drawColor || "auto",
    thickness: readThickness(anchor.dataset.drawThickness)
  };
}

/** The eraser's preview: a neutral wave with the eraser's own width cut
 *  out of it, by the session the real eraser uses. */
function erasedWave(thickness: OverlayThickness): { row: StrokeOverlay | null; radius: number; x: number } {
  const radius = eraserRadiusPx(thickness, BASIS);
  const x = W * 0.49;
  const wave: StrokeOverlay = { kind: "stroke", tool: "pen", points: WAVE, color: "auto", thickness: "medium" };
  const session = new StrokeEraseSession(radius, W, H, BASIS);
  session.extend(
    strokePointsToPx(
      [
        { x: x / W, y: 0 },
        { x: x / W, y: 1 }
      ],
      W,
      H
    ),
    [{ id: "wave", data: wave }]
  );
  const cut = session.cuts().get("wave");
  return { row: cut === undefined ? wave : cut, radius, x };
}

export function DrawModePreview({ mode, color, thickness }: PreviewStyle): ReactElement {
  const glyph = (data: Omit<StrokeOverlay, "kind" | "color">, paint: string): ReactElement => (
    <StrokeGlyph data={data} color={paint} imageWidthPx={W} imageHeightPx={H} basisPx={BASIS} />
  );
  let body: ReactElement;
  if (mode === "eraser") {
    const { row, radius, x } = erasedWave(thickness);
    body = (
      <>
        {row !== null && glyph(row, "var(--text-secondary)")}
        <rect className="draw-tip__trail" x={x - radius} y={3} width={radius * 2} height={H - 6} rx={radius} />
        <circle className="draw-tip__ring" cx={x} cy={H * 0.78} r={radius} />
      </>
    );
  } else {
    const points = mode === "pen" ? { points: WAVE } : mode === "marker" ? MARKER : { points: ARC };
    body = glyph({ tool: mode, thickness, ...points }, color);
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} data-testid="draw-tip-preview" data-mode={mode}>
      <rect className="draw-tip__paper" width={W} height={H} />
      {/* A scrap of screenshot to draw over: a heading and two lines. */}
      <rect className="draw-tip__text draw-tip__text--head" x={14} y={13} width={64} height={6} rx={3} />
      <rect className="draw-tip__text" x={14} y={32} width={136} height={5} rx={2.5} />
      <rect className="draw-tip__text" x={14} y={47} width={110} height={5} rx={2.5} />
      <rect className="draw-tip__text" x={132} y={47} width={44} height={5} rx={2.5} />
      {body}
    </svg>
  );
}

registerTipPreview(DRAW_MODE_TIP, (anchor) => {
  const style = readStyle(anchor);
  return style === null ? null : <DrawModePreview {...style} />;
});
