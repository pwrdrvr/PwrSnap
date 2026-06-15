// Export-preset resolution ladder — the single source of truth for how
// the Low / Med / High export presets map to an output pixel width.
//
// Both the main render path (`apps/desktop/src/main/render/image-presets.ts`,
// the clipboard handlers, and `capture:presetMetrics`) AND the renderer's
// copy-card labels call this so the size the user sees always matches the
// bytes that get copied, in every mode. Before this module the mapping
// was duplicated as a literal `low?800:med?1440:src` in two places that
// had to be kept in lock-step by hand.
//
// See docs/plans/2026-06-14-001-feat-dpi-aware-export-presets-plan.md.

import type { RenderPreset, Settings } from "./protocol";

/**
 * How a preset resolves to an output width.
 *
 *  • `legacy`        — the historical fixed-width clamp: Low = min(src,800),
 *                      Med = min(src,1440), High = source. DPI-unaware.
 *  • `scalePhysical` — Low / Med / High = 25% / 50% / 100% of the capture's
 *                      *physical* pixels. On a 2× (Retina) capture the High
 *                      rung is the full Retina image; Med lands on the
 *                      on-screen / logical resolution.
 *  • `scaleLogical`  — same 25 / 50 / 100% ladder, re-anchored to the
 *                      *logical* (on-screen) resolution. The top rung is 1×
 *                      (not Retina) with two smaller rungs below — this is
 *                      "Allow Retina export" turned off.
 */
export type ExportStrategy = "legacy" | "scalePhysical" | "scaleLogical";

/** The capture facts the ladder needs — physical pixel size plus the
 *  display scale factor it was captured at (`device_pixel_ratio`). */
export type ExportLadderSource = {
  widthPx: number;
  heightPx: number;
  devicePixelRatio: number;
};

export type ExportRung = {
  preset: RenderPreset;
  /** Resolved output width in physical pixels. Never exceeds the source. */
  widthPx: number;
  /** Output height, aspect-preserved from the source. Informational —
   *  the real render recomputes this through sharp; may differ ±1px. */
  heightPx: number;
  /** widthPx ÷ logicalWidth: how many on-screen pixels each output pixel
   *  carries. 2 = Retina/2×, 1 = standard, 0.5 = half on-screen size. */
  onScreenMultiple: number;
  /** True when this rung genuinely carries Retina detail — a ≥2× capture
   *  whose output is ≥2× the on-screen resolution. Drives the "Retina"
   *  callout in the copy cards. */
  retina: boolean;
};

const PRESETS: readonly RenderPreset[] = ["low", "med", "high"];

/** Legacy fixed max-widths. `0` = "source resolution, no downscale". */
const LEGACY_MAX_WIDTH: Record<RenderPreset, number> = {
  low: 800,
  med: 1440,
  high: 0
};

/** Scale of the anchor (physical or logical) for the scale-* strategies. */
const SCALE_OF_ANCHOR: Record<RenderPreset, number> = {
  low: 0.25,
  med: 0.5,
  high: 1
};

/** Map the two export toggles to a concrete strategy. Takes only the
 *  fields it reads (not the whole `experimental` block) so unrelated
 *  experimental flags can't couple to it. Defensive about a missing
 *  block (older in-flight settings reads) — falls back to `legacy`, the
 *  no-behavior-change default. */
export function resolveExportStrategy(
  experimental:
    | Pick<Settings["experimental"], "dpiAwareExport" | "allowRetinaExport">
    | undefined
    | null
): ExportStrategy {
  if (experimental === undefined || experimental === null) return "legacy";
  if (!experimental.dpiAwareExport) return "legacy";
  return experimental.allowRetinaExport ? "scalePhysical" : "scaleLogical";
}

/** Convenience over a full (or partial) Settings object. */
export function exportStrategyFromSettings(
  settings: { experimental?: Settings["experimental"] } | undefined | null
): ExportStrategy {
  return resolveExportStrategy(settings?.experimental);
}

/** Resolve the full Low / Med / High ladder for a capture under a strategy. */
export function resolveExportLadder(
  src: ExportLadderSource,
  strategy: ExportStrategy
): ExportRung[] {
  const sourceWidth = Math.max(1, Math.round(src.widthPx));
  const sourceHeight = Math.max(1, Math.round(src.heightPx));
  const dpr = src.devicePixelRatio > 0 ? src.devicePixelRatio : 1;
  const logicalWidth = Math.max(1, sourceWidth / dpr);
  const aspect = sourceHeight / sourceWidth;

  return PRESETS.map((preset) => {
    const widthPx = resolveWidth(preset, strategy, sourceWidth, logicalWidth);
    const onScreenMultiple = widthPx / logicalWidth;
    return {
      preset,
      widthPx,
      heightPx: Math.max(1, Math.round(widthPx * aspect)),
      onScreenMultiple,
      // Floating-point slop on the /dpr division can leave a clean "2×"
      // a hair under 2; the epsilon keeps the Retina flag honest.
      retina: dpr >= 2 && onScreenMultiple >= 2 - 1e-6
    };
  });
}

function resolveWidth(
  preset: RenderPreset,
  strategy: ExportStrategy,
  sourceWidth: number,
  logicalWidth: number
): number {
  if (strategy === "legacy") {
    const max = LEGACY_MAX_WIDTH[preset];
    return max === 0 ? sourceWidth : Math.min(sourceWidth, max);
  }
  const anchor = strategy === "scalePhysical" ? sourceWidth : logicalWidth;
  const raw = Math.round(anchor * SCALE_OF_ANCHOR[preset]);
  // Never upscale past the source; never collapse to 0.
  return Math.max(1, Math.min(sourceWidth, raw));
}

/** Pluck a single preset's rung out of a resolved ladder. */
export function rungForPreset(
  ladder: readonly ExportRung[],
  preset: RenderPreset
): ExportRung | undefined {
  return ladder.find((rung) => rung.preset === preset);
}

/** Resolve one preset's rung directly (convenience for per-button call
 *  sites that don't need the whole ladder). */
export function resolveExportRung(
  src: ExportLadderSource,
  strategy: ExportStrategy,
  preset: RenderPreset
): ExportRung | undefined {
  return rungForPreset(resolveExportLadder(src, strategy), preset);
}
