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

import type { ReactElement } from "react";
import type { BlurStyle, OverlayRow } from "@pwrsnap/shared";
import { readBlurStyle } from "@pwrsnap/shared";
import { rectFromDrag, type Draft } from "./editor-types";
import "./BlurOverlays.css";

export function BlurOverlays({
  overlays,
  draft,
  blurStyle
}: {
  overlays: OverlayRow[];
  draft: Draft | null;
  /** The user's currently-staged style — applied to the live-drag
   *  preview so the in-progress rect looks like what will be
   *  committed. Committed overlays read their own style off
   *  `row.data.style`. */
  blurStyle: BlurStyle;
}): ReactElement {
  const blurs = overlays.flatMap((row) =>
    row.data.kind === "blur" ? [{ row, data: row.data }] : []
  );
  const liveRect =
    draft !== null && draft.kind === "rect-drag" && draft.tool === "blur"
      ? rectFromDrag(draft)
      : null;

  return (
    <div className="ed-blur-layer">
      {blurs.map(({ row, data }) => (
        <BlurOverlayItem key={row.id} rect={data.rect} style={readBlurStyle(data)} />
      ))}
      {liveRect !== null && (
        <BlurOverlayItem rect={liveRect} style={blurStyle} isDraft />
      )}
    </div>
  );
}

function BlurOverlayItem({
  rect,
  style,
  isDraft = false
}: {
  rect: { x: number; y: number; w: number; h: number };
  style: BlurStyle;
  isDraft?: boolean;
}): ReactElement {
  return (
    <div
      className={
        `ed-blur-item ed-blur-item--${style}` + (isDraft ? " is-draft" : "")
      }
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.w * 100}%`,
        height: `${rect.h * 100}%`
      }}
    />
  );
}
