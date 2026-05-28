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
  /** Live-drag geometry override (same shape as OverlaySvg's).
   *  When the matching row is a blur and the override's geometry
   *  is `kind: "rect"`, the blur item renders at the overridden
   *  rect so a TransformHandles drag visually moves / resizes the
   *  blur in real time. */
  liveOverride?: { layerId: string; geometry: GeometryUpdate } | null;
}): ReactElement {
  const effectiveOverlays = useMemo(() => {
    if (liveOverride === null) return overlays;
    const geom = liveOverride.geometry;
    if (geom.kind !== "rect") return overlays;
    // Hoist the narrowed geometry into a local so the closure below
    // preserves the discriminator — TS doesn't carry refinement across
    // the `.map` callback. Carry through the rotation from the live
    // override so the in-progress rotation-handle drag updates the
    // CSS transform in real time.
    const overrideRect = geom.rect;
    const overrideRotation = geom.rotation;
    const overrideLayerId = liveOverride.layerId;
    return overlays.map((row) => {
      if (row.id !== overrideLayerId) return row;
      if (row.data.kind !== "blur") return row;
      return {
        ...row,
        data: {
          ...row.data,
          rect: overrideRect,
          ...(overrideRotation !== undefined ? { rotation: overrideRotation } : {})
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
