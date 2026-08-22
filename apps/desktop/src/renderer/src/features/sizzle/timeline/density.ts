// Zoom presets and the density ladder (plan §4.5). Pure.
//
// At `sequenceBeatsMax = 80` and fit-to-width in a ~900 px column a clip
// is ~11 px — not draggable, not labelable. So: default fit-to-width, a
// zoom control in px/sec with presets, and progressive disclosure by the
// clip's RENDERED width. Never render a label that cannot be read.

export type TimelineZoom = "fit" | 1 | 2 | 4;

export const TIMELINE_ZOOMS: readonly TimelineZoom[] = ["fit", 1, 2, 4];

/** 1× zoom. Picked by analogy to other NLEs (plan §8 — not measured). */
export const TIMELINE_PX_PER_SEC_1X = 40;

/** Pixels per second for a zoom level, given the strip's available width. */
export function pxPerSecFor(zoom: TimelineZoom, fitWidthPx: number, totalSec: number): number {
  if (zoom === "fit") {
    if (totalSec <= 0 || fitWidthPx <= 0) return 0;
    return fitWidthPx / totalSec;
  }
  return TIMELINE_PX_PER_SEC_1X * zoom;
}

/** The next preset up (⌘+). `fit` steps to the first preset that is
 *  denser than the current fit, so zooming in always zooms IN. */
export function zoomIn(zoom: TimelineZoom, fitPxPerSec: number): TimelineZoom {
  if (zoom === "fit") {
    const next = ([1, 2, 4] as const).find((z) => TIMELINE_PX_PER_SEC_1X * z > fitPxPerSec + 0.5);
    // A short reel can already be denser at fit than 4× (a 4 s reel in a
    // 1000 px column is 250 px/s). Stepping to 4× would then zoom OUT and
    // leave empty track past the end — so stay put, mirroring `zoomOut`.
    return next ?? "fit";
  }
  return zoom === 1 ? 2 : 4;
}

/** The next preset down (⌘−); the coarsest is `fit`. */
export function zoomOut(zoom: TimelineZoom, fitPxPerSec: number): TimelineZoom {
  if (zoom === "fit") return "fit";
  const prev = zoom === 4 ? 2 : zoom === 2 ? 1 : "fit";
  // Do not step to a preset that is LESS dense than fit — that would
  // leave empty track past the reel. Jump to fit instead.
  if (prev !== "fit" && TIMELINE_PX_PER_SEC_1X * prev <= fitPxPerSec + 0.5) return "fit";
  return prev;
}

export type ClipDetail = "full" | "thumb" | "tick";

/** ≥ 96 px: thumbnail + label (+ fit chip); ≥ 24 px: thumbnail only;
 *  below that a bare tick. */
export const CLIP_DETAIL_FULL_PX = 96;
export const CLIP_DETAIL_THUMB_PX = 24;
/** The fit chip needs a little more room than the name + duration. */
export const CLIP_DETAIL_FIT_CHIP_PX = 150;

export function clipDetailForWidth(widthPx: number): ClipDetail {
  if (widthPx >= CLIP_DETAIL_FULL_PX) return "full";
  if (widthPx >= CLIP_DETAIL_THUMB_PX) return "thumb";
  return "tick";
}
