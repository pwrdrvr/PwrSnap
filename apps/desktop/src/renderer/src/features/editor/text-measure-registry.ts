// Registry of REAL measured text-glyph box sizes, keyed by overlay id.
//
// The selection outline, the TransformHandles body-hit rect + rotation
// pivot, and the pointer hit-test all need to know the on-screen extent
// of a rendered TextOverlay. Historically each RE-DERIVED that extent
// analytically (`textBoundsBox` in OverlaySvg.tsx): bucket → fontSize,
// then `canvas.measureText()` for width and `fontSize * lineCount` for
// height. That estimate has to stay in lockstep with how Chromium
// ACTUALLY lays out the glyph `<div>` (TextHtml.tsx via
// `computeTextHtmlStyle`) — two independent code paths computing the
// same geometry, which is a permanent source of drift.
//
// A correction, because this comment used to assert the wrong reason
// and cost someone a full investigation: `canvas.getContext("2d")`
// DOES resolve `-apple-system, BlinkMacSystemFont` the way the DOM
// does. Measured inside the packaged Electron renderer on macOS, at
// equal font size, `measureText` and the laid-out `<div>` agree to
// 0.013%. The analytic path is inaccurate for a different reason: it
// measures at the IMAGE-px font size and relies on the result scaling
// LINEARLY down to the CSS-px size the glyph renders at, and the macOS
// system font's metrics are not linear in size (optical sizing). Same
// string, same weight, measured at 18px and scaled to 9px: 7.3% off.
// At 30px scaled to 18px: 2.3% off. Linux's fallback face is linear,
// which is why the divergence is invisible in CI.
//
// This registry inverts the dependency: the glyph `<div>` is already a
// live, laid-out DOM element, so TextHtml MEASURES it
// (`offsetWidth`/`offsetHeight`, which are transform-independent — the
// CSS rotate() doesn't perturb them) and PUBLISHES the natural box here.
// Every consumer reads the published box instead of re-deriving it, so
// the outline/handles/hit-test track exactly what the user sees. The
// same lesson the tray + float-over popovers already encode (CLAUDE.md
// "Tray + float-over popover sizing"): measure the real element, don't
// compute it.
//
// Sizes are stored in IMAGE-PIXEL units (resolution-independent) so the
// value is stable across editor zoom / window resize: consumers
// normalize by `imageWidthPx` / `imageHeightPx` exactly as the analytic
// path did. TextHtml converts its CSS-pixel `offsetWidth` to image px
// via the canvas's uniform CSS:image scale (`canvasCssHeight /
// imageHeightPx`).
//
// That scale MUST be layout-derived. `offsetWidth` is a layout measure,
// so dividing it by a scale read from a post-transform
// `getBoundingClientRect()` publishes a box that is wrong by whatever
// transform was in flight — which is exactly how a 180ms entrance
// animation on `.psl__focus` froze a ~1%-short scale into every glyph
// box for the life of the editor. See
// docs/solutions/2026-08-28-text-outline-stale-canvas-scale.md.

import { useSyncExternalStore } from "react";

export interface MeasuredGlyphSize {
  /** Natural (un-rotated, pre-transform) glyph box width in IMAGE px —
   *  the advance of the WIDEST line as Chromium laid it out. */
  widthImagePx: number;
  /** Natural glyph box height in IMAGE px (`line-height: 1` × lineCount,
   *  as Chromium laid it out). */
  heightImagePx: number;
}

const sizes = new Map<string, MeasuredGlyphSize>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Publish a freshly-measured glyph box. No-ops when the dimensions
 *  match the last published value so a ResizeObserver firing with an
 *  unchanged size (e.g. a window resize that scales CSS px but leaves
 *  image px constant) doesn't churn subscribers. */
export function reportGlyphSize(id: string, size: MeasuredGlyphSize): void {
  const prev = sizes.get(id);
  if (
    prev !== undefined &&
    prev.widthImagePx === size.widthImagePx &&
    prev.heightImagePx === size.heightImagePx
  ) {
    return;
  }
  sizes.set(id, size);
  emit();
}

/** Drop a measurement when its glyph unmounts (overlay deleted, edit
 *  opened, capture switched). Consumers fall back to the analytic
 *  estimate until a fresh measurement lands. */
export function clearGlyphSize(id: string): void {
  if (sizes.delete(id)) emit();
}

/** Synchronous read for imperative callers (the pointer hit-test runs
 *  outside React render). Returns the latest published box or undefined
 *  when nothing has measured this id yet. */
export function getGlyphSize(id: string): MeasuredGlyphSize | undefined {
  return sizes.get(id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reactive read for render-path callers (SelectionOutline,
 *  TransformHandles). Re-renders the component when this id's measured
 *  box changes — needed because a text edit / resize re-measures AFTER
 *  the consumer's render commit, so the outline must follow on the next
 *  store emit. `null` id (nothing selected) reads as undefined. The
 *  stored object reference is stable until the box actually changes, so
 *  `useSyncExternalStore`'s snapshot identity check stays happy. */
export function useGlyphSize(id: string | null): MeasuredGlyphSize | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (id === null ? undefined : sizes.get(id))
  );
}
