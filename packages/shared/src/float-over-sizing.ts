/**
 * Float-over toast sizing policy — the ONE definition of how tall the
 * post-capture toast may get, shared by the two processes that both
 * have to agree about it:
 *
 *   - main (`float-over.ts`) clamps the `setContentSize` it performs in
 *     response to the renderer's measured height;
 *   - the renderer (`FloatOverHost.tsx`) caps `.fo` at the same number
 *     so the toast SCROLLS its middle instead of handing main a height
 *     that main will clamp — which is what clipped the footer
 *     (Discard / Dismiss / Edit) off the bottom of the window.
 *
 * Keeping the policy in one pure module is the point: if the renderer's
 * cap were even a pixel looser than main's clamp, the difference would
 * reappear as clipped footer.
 *
 * ## Units
 *
 * Everything here that is named `Dip` is in device-independent pixels —
 * the unit `BrowserWindow.setContentSize` and `Display.workArea` speak.
 * `...Css` is in the renderer's CSS pixels, which is DIP divided by the
 * webContents zoom factor. Main already does that conversion in the
 * other direction (`heightDip = heightCss * zoom`); this module does it
 * for the renderer so the two cannot disagree about the rounding.
 *
 * ## Why no window size is an input here
 *
 * Deliberate, and enforced by this module's signature having nowhere to
 * put one. Deriving the cap from the toast window's CURRENT size
 * (`100vh`, `window.innerHeight`) is a feedback loop: the measured
 * wrapper would report `min(natural, current window)`, main would size
 * the window to that, and the toast could then never grow again — a
 * short window would stay short forever, which is a worse bug than the
 * clipping this replaces. See AGENTS.md §"Tray + float-over popover
 * sizing". Both inputs below are window-size-independent:
 * `FLOAT_OVER_HEIGHT_MAX_DIP` is a constant, and a display's work area
 * is a property of the display. (Measured on Electron 41: a renderer's
 * `window.screen.availHeight` equals `Display.workArea.height` exactly
 * and does NOT move with page zoom, while `window.innerHeight` does.)
 */

/** Hard floor, so a renderer measurement bug can't collapse the toast. */
export const FLOAT_OVER_HEIGHT_MIN_DIP = 160;

/**
 * Hard ceiling, independent of the display. Sized so the toast stays a
 * toast rather than a second window; content past it scrolls.
 */
export const FLOAT_OVER_HEIGHT_MAX_DIP = 800;

/**
 * Gap between the toast and the work-area edges it is anchored to —
 * must match the `margin` used by `anchorBottomRight` in
 * `main/float-over.ts`. Counted twice below: a toast tall enough to
 * need the top margin as well is one whose top edge would otherwise
 * leave the work area, and on macOS AppKit responds to that by MOVING
 * the window back inside (AGENTS.md §"macOS MOVES a window placed
 * outside the work area") — which pushes the footer off the bottom,
 * i.e. exactly the failure this policy exists to prevent.
 */
export const FLOAT_OVER_ANCHOR_MARGIN_DIP = 24;

/**
 * The tallest content the toast window may show, in DIP.
 *
 * `workAreaHeightDip` is the work area of the display the toast is
 * anchored to. Pass `null` when it isn't known yet (no display
 * anchored, or a renderer whose `window.screen` is unavailable) and
 * only the constant ceiling applies.
 *
 * **Zero and negative mean UNKNOWN, not "a 0px display".** That
 * distinction is the whole reason the guard below is `> 0` rather than
 * just `Number.isFinite`. A renderer with no display resolved reports
 * `screen.availHeight === 0` — jsdom does exactly this — and it is a
 * `number`, so a bare isFinite check admits it: the ceiling becomes
 * `0 - 48 = -48`, the floor takes over, and the toast is capped at
 * 160px showing its header and a sliver with the footer unreachable,
 * which is the failure this whole module exists to prevent. A
 * positive-but-tiny value is a real (if odd) display and the floor
 * below handles it deliberately; 0 is an absence of information and
 * must not constrain anything.
 */
export function floatOverMaxContentHeightDip(
  workAreaHeightDip: number | null | undefined
): number {
  const ceilings = [FLOAT_OVER_HEIGHT_MAX_DIP];
  if (
    typeof workAreaHeightDip === "number" &&
    Number.isFinite(workAreaHeightDip) &&
    workAreaHeightDip > 0
  ) {
    ceilings.push(workAreaHeightDip - FLOAT_OVER_ANCHOR_MARGIN_DIP * 2);
  }
  // The floor wins over a pathologically short work area: a 200px-tall
  // display is not a reason to hand main a height it will clamp back up.
  return Math.max(FLOAT_OVER_HEIGHT_MIN_DIP, Math.min(...ceilings));
}

/**
 * The same ceiling expressed in the renderer's CSS pixels, for use as a
 * `max-height` on the toast.
 *
 * Floored rather than rounded: main re-derives DIP from the measured
 * CSS height with `Math.ceil(heightCss * zoom)`, so a cap that rounded
 * UP could come back a pixel over the clamp and clip a hairline of the
 * footer's border.
 */
export function floatOverMaxContentHeightCss(options: {
  readonly workAreaHeightDip: number | null | undefined;
  readonly zoomFactor: number;
}): number {
  const { workAreaHeightDip, zoomFactor } = options;
  const zoom =
    Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.floor(floatOverMaxContentHeightDip(workAreaHeightDip) / zoom);
}
