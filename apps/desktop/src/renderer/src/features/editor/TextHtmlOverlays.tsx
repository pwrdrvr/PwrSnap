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

import { type ReactElement, useMemo } from "react";
import type { OverlayRow } from "@pwrsnap/shared";
import { readOverlayRotation, readTextWeight } from "@pwrsnap/shared";
import { resolveToolColor } from "./resolveToolColor";
import { TextHtml } from "./TextHtml";
import { applyGeometryLocally, type GeometryUpdate } from "./geometry-projection";

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
  /** Live-drag geometry override — same shape OverlaySvg / BlurOverlays
   *  consume. When a rotation handle / body drag / resize is in flight,
   *  the matching text row renders with the in-progress geometry
   *  instead of its persisted `data.*` fields. Without this the
   *  SelectionOutline (SVG, gets the override) rotated/translated
   *  during a drag while the HTML glyph (no override) stayed put —
   *  visible divergence the user reported as "text rotation is not
   *  live anymore" and "the glyph snaps on pointerup". Cleared by the
   *  parent on drag end. */
  liveOverride?: { layerId: string; geometry: GeometryUpdate } | null;
}

export function TextHtmlOverlays(props: TextHtmlOverlaysProps): ReactElement {
  // Project the live-drag override onto the matching row's data so the
  // text glyph follows the user's gesture in real time. Goes through
  // the shared `applyGeometryLocally` helper so the merge shape stays
  // identical to OverlaySvg / BlurOverlays — same contract one place.
  //
  // Memoized so that during a rotation drag every pointermove (= new
  // `liveOverride` reference) doesn't force the downstream `texts.map`
  // JSX to re-reconcile every `<TextHtml>` child. Memo keys cover the
  // two axes the projection actually depends on.
  const effectiveOverlays = useMemo(() => {
    const override = props.liveOverride;
    if (override === undefined || override === null) return props.overlays;
    return props.overlays.map((row) => {
      if (row.id !== override.layerId) return row;
      if (row.data.kind !== "text") return row;
      const merged = applyGeometryLocally(row.data, override.geometry);
      if (merged === null || merged.kind !== "text") return row;
      return { ...row, data: merged };
    });
  }, [props.overlays, props.liveOverride]);
  // Second memo keeps the rendered `texts` array reference stable when
  // no text row changed — avoids re-reconciliation of every glyph on
  // unrelated overlay updates (e.g., a rect drag elsewhere on the
  // canvas that bumps `overlays` but doesn't touch any text row).
  const texts = useMemo(
    () =>
      effectiveOverlays.flatMap((row) =>
        row.data.kind === "text" && row.id !== props.editingLayerId
          ? [{ row, data: row.data }]
          : []
      ),
    [effectiveOverlays, props.editingLayerId]
  );

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
            rotation={readOverlayRotation(data)}
          />
        );
      })}
    </>
  );
}
