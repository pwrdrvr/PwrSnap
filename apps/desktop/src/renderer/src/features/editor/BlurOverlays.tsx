// HTML blur-overlay layer sitting between the canvas <img> and the
// SVG overlay layer. Renders blur overlays as absolutely-positioned
// divs whose CSS `backdrop-filter` does the actual blurring of the
// image beneath. The SVG layer no longer renders blurs — only
// non-blur glyphs (arrows, rects, highlights, text) live there.
//
// Why HTML instead of SVG? SVG <filter> can blur SVG content but
// can't reach behind itself to blur the page <img>. CSS
// `backdrop-filter` on an HTML element blurs ANYTHING behind it in
// the same stacking context, including a sibling <img> — which
// is exactly what we want for a faithful live preview that matches
// what the sharp bake produces on export.

import { useMemo, type ReactElement } from "react";
import type { BlurStyle, OverlayRow } from "@pwrsnap/shared";
import { readBlurStyle, readOverlayRotation } from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import type { GeometryUpdate } from "./useCaptureModel";
import "./BlurOverlays.css";

export function BlurOverlays({
  overlays,
  draft,
  blurStyle,
  liveOverride = null
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  /** The user's currently-staged style — applied to the live-drag
   *  preview so the in-progress rect looks like what will be
   *  committed. Committed overlays read their own style off
   *  `row.data.style`. */
  blurStyle: BlurStyle;
  /** Live-drag geometry override — Map of layer id → in-progress
   *  geometry. Same shape OverlaySvg / TextHtmlOverlays consume.
   *  When the matching row is a blur and the override's geometry
   *  is `kind: "rect"`, the blur item renders at the overridden
   *  rect so a TransformHandles drag (single-select) OR a multi-
   *  drag (group translation) visually moves / resizes the blur in
   *  real time. Single-select passes a 1-entry map; multi-drag
   *  passes one entry per selected blur layer. */
  liveOverride?: ReadonlyMap<string, GeometryUpdate> | null;
}): ReactElement {
  const effectiveOverlays = useMemo(() => {
    if (liveOverride === null || liveOverride.size === 0) return overlays;
    return overlays.map((row) => {
      const geom = liveOverride.get(row.id);
      if (geom === undefined) return row;
      // Blur is rect-shaped, so a non-rect geometry update (text /
      // arrow / step) for the same id can't apply here. Pass through
      // unchanged in that case — the row is probably a non-blur kind
      // that the override is meant for elsewhere (OverlaySvg /
      // TextHtmlOverlays handle it).
      if (geom.kind !== "rect") return row;
      if (row.data.kind !== "blur") return row;
      // Carry through the rotation from the live override so the
      // in-progress rotation-handle drag updates the CSS transform
      // in real time.
      return {
        ...row,
        data: {
          ...row.data,
          rect: geom.rect,
          ...(geom.rotation !== undefined ? { rotation: geom.rotation } : {})
        }
      };
    });
  }, [liveOverride, overlays]);
  const blurs = effectiveOverlays.flatMap((row) =>
    row.data.kind === "blur" ? [{ row, data: row.data }] : []
  );
  const liveRect =
    draft !== null && draft.kind === "rect-drag" && draft.tool === "blur"
      ? rectFromDrag(draft)
      : null;

  return (
    <div className="ed-blur-layer">
      {blurs.map(({ row, data }) => (
        <BlurOverlayItem
          key={row.id}
          rect={data.rect}
          rotation={readOverlayRotation(data)}
          style={readBlurStyle(data)}
        />
      ))}
      {liveRect !== null && (
        <BlurOverlayItem rect={liveRect} rotation={0} style={blurStyle} isDraft />
      )}
    </div>
  );
}

function BlurOverlayItem({
  rect,
  rotation,
  style,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise rotation in radians around the rect's geometric center.
   *  CSS `transform: rotate(deg)` defaults to rotating around the
   *  element's center, which matches the SelectionOutline / SVG
   *  glyph rotation pivot for rect/highlight kinds. NOTE: v1 export
   *  (`compose.ts` blur path) currently ignores rotation — sharp's
   *  extract+blur pipeline doesn't support rotated clip regions. The
   *  live editor preview will rotate; the baked PNG will not. */
  rotation: number;
  style: BlurStyle;
  isDraft?: boolean;
}): ReactElement {
  const rotateDeg = (rotation * 180) / Math.PI;
  return (
    <div
      className={
        `ed-blur-item ed-blur-item--${style}` + (isDraft ? " is-draft" : "")
      }
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`,
        ...(rotation !== 0 ? { transform: `rotate(${rotateDeg}deg)` } : {})
      }}
    />
  );
}
