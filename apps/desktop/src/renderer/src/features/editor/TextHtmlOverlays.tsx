// List wrapper for `TextHtml` — renders one `<TextHtml>` per persisted
// TextOverlay, suppressing the row currently open for re-edit (the
// TextDraftInput renders that one instead). Sits between OverlaySvg
// and TransformHandles in the editor's stacking order:
//
//   img → BlurOverlays → OverlaySvg → TextHtmlOverlays →
//     TransformHandles → TextDraftInput
//
// `canvasCssHeight` is OWNED by EditorLoaded (one ResizeObserver, one
// source of truth) and threaded in via props. Pre-refactor each
// surface measured the canvas independently; the values disagreed
// mid-resize (ResizeObserver-state lag vs synchronous read) and
// produced a visible ~11% font-size delta between display and edit.
// Lifting the measurement upstream eliminates the drift.

import { type ReactElement } from "react";
import type { OverlayRow } from "@pwrsnap/shared";
import { readTextWeight } from "@pwrsnap/shared";
import { resolveToolColor } from "./resolveToolColor";
import { TextHtml } from "./TextHtml";
import { applyGeometryLocally } from "./OverlaySvg";
import type { GeometryUpdate } from "./useCaptureModel";

const AUTO_COLOR_HEX = "var(--accent, #ff8a1f)";

export interface TextHtmlOverlaysProps {
  /** All overlays for the current capture. The component filters
   *  internally to the text rows. */
  overlays: OverlayRow[];
  /** Id of the overlay currently open in TextDraftInput. Suppressed
   *  from this list so display + edit don't double-render the same
   *  glyph. */
  editingLayerId: string | null;
  /** CANVAS pixel dims (record.width_px / record.height_px). */
  imageWidthPx: number;
  imageHeightPx: number;
  /** SOURCE raster pixel dims. */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Editor canvas CSS-pixel height — owned by EditorLoaded so both
   *  display + edit consume the same value. Drives fontPx via
   *  computeTextHtmlStyle. */
  canvasCssHeight: number;
  /** Live-drag geometry override. When set, the text row whose id
   *  matches `layerId` is rendered with the overridden geometry
   *  instead of its persisted `data.point`, so the painted glyph
   *  follows the cursor during a TransformHandles drag (same
   *  contract OverlaySvg / BlurOverlays implement for arrow / rect /
   *  highlight / blur). Without this, only the bounding box + handles
   *  move during the drag — the text snaps to the new position on
   *  pointerup. */
  liveOverride?: { layerId: string; geometry: GeometryUpdate } | null;
}

export function TextHtmlOverlays(props: TextHtmlOverlaysProps): ReactElement {
  const liveOverride = props.liveOverride ?? null;
  const texts = props.overlays.flatMap((row) => {
    if (row.data.kind !== "text" || row.id === props.editingLayerId) return [];
    if (liveOverride !== null && row.id === liveOverride.layerId) {
      const merged = applyGeometryLocally(row.data, liveOverride.geometry);
      if (merged !== null && merged.kind === "text") {
        return [{ row, data: merged }];
      }
    }
    return [{ row, data: row.data }];
  });

  return (
    <>
      {texts.map(({ row, data }) => {
        const resolvedColor = resolveToolColor(data.color);
        const colorHex =
          resolvedColor === "auto" ? AUTO_COLOR_HEX : resolvedColor;
        return (
          <TextHtml
            key={row.id}
            point={data.point}
            body={data.body}
            size={data.size}
            weight={readTextWeight(data)}
            colorHex={colorHex}
            storedSizePx={data.sizePx}
            imageWidthPx={props.imageWidthPx}
            imageHeightPx={props.imageHeightPx}
            sourceWidthPx={props.sourceWidthPx}
            sourceHeightPx={props.sourceHeightPx}
            canvasCssHeight={props.canvasCssHeight}
          />
        );
      })}
    </>
  );
}
