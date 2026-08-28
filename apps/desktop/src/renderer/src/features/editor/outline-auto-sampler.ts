// Renderer half of the auto contrast-border ("outline: auto")
// resolution. The shared spec (@pwrsnap/shared outline-auto.ts) says
// WHERE to sample and how to decide; this module owns the actual
// pixel access:
//
//   • It loads the capture's BASE raster once per URL through a
//     dedicated `crossorigin="anonymous"` Image (the pwrsnap-capture
//     scheme now serves `access-control-allow-origin: *`, so the
//     draw below doesn't taint the canvas — the editor's display
//     <img> is a no-cors load and stays untouched).
//   • Draws it into a small offscreen canvas (long side ≤ 512px) and
//     keeps the ImageData. Sampling 100 points is then 100 array
//     lookups — cheap enough to run per pointermove for live drafts.
//   • `sampleOutlineAutoColor` is SYNCHRONOUS against that cache and
//     returns null until `warmOutlineSampler` has finished decoding
//     (or when the decode failed / every sample point fell outside
//     the raster). Callers treat null as "omit outlineAuto" — the
//     read helpers then fall back to the legacy-look color, so the
//     feature degrades to today's behavior, never breaks a render.
//
// Deliberate v1 scope: only the BASE source raster is sampled.
// Pasted raster layers, effect layers, and annotations underneath
// are not composited into the decision — the border ring sits over
// screenshot content in the overwhelming case, and the user can
// always pick White/Black explicitly when it doesn't.

import type { Overlay, OverlayOutlineAutoColor } from "@pwrsnap/shared";
import {
  decideOutlineAutoColor,
  outlineAutoLuma,
  outlineSamplePointsForOverlay
} from "@pwrsnap/shared";

/** Long-side cap for the sampling canvas. Downscale changes exact
 *  pixel values, but the decision is a median over 100 points against
 *  a wide threshold — resample wobble can't flip it in any case a
 *  human would call ambiguous. 512px keeps the retained ImageData
 *  under ~1.5 MB for any aspect. */
const SAMPLER_MAX_DIM = 512;

/** Retain at most this many decoded captures (the editor shows one at
 *  a time; a couple extra cover quick capture switches). */
const SAMPLER_CACHE_MAX = 4;

interface SamplerEntry {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** url → decoded entry, null = load/decode/read failed (don't retry
 *  every call; `warmOutlineSampler` may be asked again after e.g. a
 *  re-bake and will retry failures then). */
const entries = new Map<string, SamplerEntry | null>();
const pending = new Map<string, Promise<void>>();

function evictIfNeeded(): void {
  while (entries.size > SAMPLER_CACHE_MAX) {
    const oldest = entries.keys().next();
    if (oldest.done === true) return;
    entries.delete(oldest.value);
  }
}

function decodeIntoEntry(img: HTMLImageElement, url: string): void {
  const naturalWidth = img.naturalWidth;
  const naturalHeight = img.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    entries.set(url, null);
    return;
  }
  const scale = Math.min(1, SAMPLER_MAX_DIM / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      entries.set(url, null);
      return;
    }
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    entries.set(url, {
      data: imageData.data,
      width,
      height,
      naturalWidth,
      naturalHeight
    });
    evictIfNeeded();
  } catch {
    // SecurityError (tainted canvas — CORS header missing on an older
    // main process) or decode failure. Null-cache so sampling calls
    // stay cheap; Auto degrades to the legacy fallback color.
    entries.set(url, null);
  }
}

/** Kick off (or retry a failed) decode for a capture URL. Safe to call
 *  every render — an in-flight or successful load is a no-op. */
export function warmOutlineSampler(url: string | null): void {
  if (url === null || url.length === 0) return;
  if (entries.get(url) !== undefined && entries.get(url) !== null) return;
  if (pending.has(url)) return;
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  const done = new Promise<void>((resolve) => {
    img.onload = (): void => {
      decodeIntoEntry(img, url);
      pending.delete(url);
      resolve();
    };
    img.onerror = (): void => {
      entries.set(url, null);
      pending.delete(url);
      resolve();
    };
  });
  pending.set(url, done);
  img.src = url;
}

/** Await the warm-up for callers on an async path (commit handlers). */
export async function ensureOutlineSampler(url: string | null): Promise<void> {
  if (url === null || url.length === 0) return;
  warmOutlineSampler(url);
  const inFlight = pending.get(url);
  if (inFlight !== undefined) await inFlight;
}

/** Test hook — drop all cached pixels. */
export function resetOutlineSamplerForTests(): void {
  entries.clear();
  pending.clear();
}

export interface OutlineSampleContext {
  canvasWidthPx: number;
  canvasHeightPx: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  /** Base raster's transform translation in source-pixel units —
   *  non-zero for off-origin crops (see BlurOverlays'
   *  `canvasRectToImgNaturalRect`, whose inverse mapping this
   *  mirrors). */
  rasterTranslateXPx: number;
  rasterTranslateYPx: number;
}

/**
 * Decide the auto border color for an overlay against the capture's
 * base raster. Synchronous — returns null until the URL is warmed,
 * when the decode failed, when the overlay kind carries no outline,
 * or when every sample point (or its pixel) is unusable. Callers omit
 * `outlineAuto` on null and the legacy-look fallback applies.
 */
export function sampleOutlineAutoColor(
  url: string | null,
  data: Overlay,
  ctx: OutlineSampleContext
): OverlayOutlineAutoColor | null {
  if (url === null || url.length === 0) return null;
  const entry = entries.get(url);
  if (entry === undefined || entry === null) return null;
  if (ctx.canvasWidthPx <= 0 || ctx.canvasHeightPx <= 0) return null;
  const points = outlineSamplePointsForOverlay(data, {
    canvasWidthPx: ctx.canvasWidthPx,
    canvasHeightPx: ctx.canvasHeightPx,
    sourceWidthPx: ctx.sourceWidthPx,
    sourceHeightPx: ctx.sourceHeightPx
  });
  if (points === null || points.length === 0) return null;

  const safeSourceW = ctx.sourceWidthPx > 0 ? ctx.sourceWidthPx : 1;
  const safeSourceH = ctx.sourceHeightPx > 0 ? ctx.sourceHeightPx : 1;
  // canvas-px → img-natural-px (crop translate + DPR scale), then
  // natural-px → sampling-canvas px. Same mapping as BlurOverlays'
  // canvasRectToImgNaturalRect, collapsed into one scale per axis.
  const naturalScaleX = entry.naturalWidth / safeSourceW;
  const naturalScaleY = entry.naturalHeight / safeSourceH;
  const sampleScaleX = entry.width / entry.naturalWidth;
  const sampleScaleY = entry.height / entry.naturalHeight;

  const lumas: number[] = [];
  for (const point of points) {
    const canvasX = point.xn * ctx.canvasWidthPx;
    const canvasY = point.yn * ctx.canvasHeightPx;
    const sx = Math.floor(
      (canvasX - ctx.rasterTranslateXPx) * naturalScaleX * sampleScaleX
    );
    const sy = Math.floor(
      (canvasY - ctx.rasterTranslateYPx) * naturalScaleY * sampleScaleY
    );
    if (sx < 0 || sy < 0 || sx >= entry.width || sy >= entry.height) continue;
    const offset = (sy * entry.width + sx) * 4;
    const alpha = entry.data[offset + 3] ?? 0;
    // Transparent source pixels show whatever's BEHIND the export —
    // unknowable here, so they don't get a vote.
    if (alpha < 128) continue;
    lumas.push(
      outlineAutoLuma(
        entry.data[offset] ?? 0,
        entry.data[offset + 1] ?? 0,
        entry.data[offset + 2] ?? 0
      )
    );
  }
  if (lumas.length === 0) return null;
  return decideOutlineAutoColor(lumas);
}
