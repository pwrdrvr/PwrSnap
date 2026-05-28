// In-canvas HTML rendering of persisted TextOverlays — replaces the
// pre-unification SVG <text> in OverlaySvg.TextGlyph. Same Chromium
// HTML pipeline as TextDraftInput (the edit-mode visible div +
// invisible textarea), so display + edit go through ONE renderer and
// share `computeTextHtmlStyle` from @pwrsnap/shared.
//
// Why HTML instead of SVG (for editor display):
//   • SVG text and HTML text in Chromium go through DIFFERENT font-
//     metric pipelines (SVG uses glyph layout; HTML uses line-box
//     layout + Core Text). Even at identical font-family / size /
//     weight they produce visibly different output (HTML is heavier
//     on macOS due to subpixel-antialiased smoothing).
//   • Empty SVG <tspan dy="1.2em"></tspan> elements DON'T advance the
//     baseline in Chromium — blank lines in multi-line text silently
//     collapsed. HTML line-boxes always take vertical space, so this
//     class of bug disappears.
//
// The export bake (compose.ts textSvgForV2) still uses SVG + librsvg.
// A future PR will unify bake rendering through a hidden Chromium
// BrowserWindow capture so editor-display = baked-PNG end-to-end. The
// shared style helper is already structured to feed both surfaces.
//
// Pointer behavior: the wrapper is `pointer-events: none` so clicks
// pass THROUGH the text glyph to the canvas's pointerdown handler
// (hit-test → select). When selected, TransformHandles' body-hit rect
// overlays the text and catches the click → enter edit mode. The
// glyph itself is non-interactive.

import type { CSSProperties, ReactElement } from "react";
import {
  computeTextHtmlStyle,
  type TextSizeBucket
} from "@pwrsnap/shared";

export interface TextHtmlProps {
  /** Overlay anchor point in normalized [0,1] coords. */
  point: { x: number; y: number };
  /** Persisted body. Newlines preserved via `white-space: pre` on the
   *  glyph element — multi-line text renders each line in its own
   *  line-box. Blank lines also take a full line-box (the bug the SVG
   *  side had). */
  body: string;
  /** Resolved size bucket from the overlay row. */
  size: TextSizeBucket;
  /** Resolved CSS font-weight number. */
  weight: number;
  /** Resolved color — hex string or CSS var() expression. Editor
   *  callers can pass either; if the future bake-unification PR
   *  consumes this, it'll need to pre-resolve var() to hex since the
   *  hidden BrowserWindow won't inherit the editor's CSS variables. */
  colorHex: string;
  /** Persisted absolute pixel height (pwrdrvr/PwrSnap#110). */
  storedSizePx: number | undefined;
  /** Canvas pixel dims (record.width_px / record.height_px). */
  imageWidthPx: number;
  imageHeightPx: number;
  /** Source raster pixel dims (raster layer's natural_*_px). */
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** CSS-pixel height of the canvas div — read from
   *  canvasRef.getBoundingClientRect().height by the caller and
   *  passed in. We don't read the ref here because TextHtml may be
   *  rendered in a list (one per overlay) and we'd be reading the
   *  same ref N times per frame; the caller reads once and threads. */
  canvasCssHeight: number;
  /** Clockwise rotation in radians from the overlay row. Threaded
   *  through to computeTextHtmlStyle which appends rotate(rad) to
   *  the wrapper's CSS transform. Pivot is the visible body-box
   *  center (see computeTextHtmlStyle for the math). */
  rotation?: number | undefined;
}

/** Read-only display surface for a persisted TextOverlay. Renders as
 *  an absolutely-positioned div over the canvas. Selection outline +
 *  TransformHandles are drawn separately by OverlaySvg /
 *  TransformHandles — this component is glyph-only. */
export function TextHtml(props: TextHtmlProps): ReactElement {
  const style = computeTextHtmlStyle({
    point: props.point,
    size: props.size,
    weight: props.weight,
    storedSizePx: props.storedSizePx,
    colorHex: props.colorHex,
    sourceWidthPx: props.sourceWidthPx,
    sourceHeightPx: props.sourceHeightPx,
    canvasWidthPx: props.imageWidthPx,
    canvasHeightPx: props.imageHeightPx,
    canvasCssHeight: props.canvasCssHeight,
    ...(props.rotation !== undefined ? { rotation: props.rotation } : {})
  });
  // pointer-events: none on the wrapper so clicks fall through to the
  // canvas's pointerdown handler. The hit-test there will find the
  // text via `hitTestOverlays` (which checks the anchor point + a
  // small radius) and select it.
  const wrapperStyle: CSSProperties = {
    ...(style.wrapper as CSSProperties),
    pointerEvents: "none"
  };
  // User-select also off — the glyph is "rendered", not "selectable
  // text". Selecting it would interfere with the canvas selection
  // model (selecting a layer vs selecting text characters).
  const glyphStyle: CSSProperties = {
    ...(style.glyph as CSSProperties),
    userSelect: "none",
    WebkitUserSelect: "none"
  };
  return (
    <div style={wrapperStyle}>
      <div style={glyphStyle}>{props.body}</div>
    </div>
  );
}
