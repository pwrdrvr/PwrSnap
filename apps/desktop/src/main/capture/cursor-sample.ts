// One-shot cursor sample for the image-capture flow (cursor-capture
// plan, Phase 3). Spawns the window-list Swift helper's
// `--sample-cursor` subcommand, which returns the CURRENT system
// cursor's sprite PNG + hotspot + global position — sampled at
// hotkey-trigger time, BEFORE the region selector swaps the OS cursor
// for its synthetic crosshair, so the sample matches the frozen screen
// snapshot the capture is cut from.
//
// Every failure path resolves to `null`, never throws: the cursor
// layer is a best-effort nicety and must not break a capture. Known
// null cases: non-macOS, unbuilt dev helper, `NSCursor.currentSystem`
// returning nil (deprecated in macOS 15 — Finding B in the plan), a
// hostile/garbled JSON payload.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getMainLogger } from "../log";
import { resolveWindowListHelperPath } from "./window-list";

const execFileAsync = promisify(execFile);
const log = getMainLogger("pwrsnap:cursor-sample");

/** Sprite payloads are small (a cursor is tens of KB); anything huge is
 *  a malfunction, not a cursor. Cap well below Node's default. */
const MAX_SAMPLE_JSON_BYTES = 4 * 1024 * 1024;
const SAMPLE_TIMEOUT_MS = 2_000;

export type CursorSample = {
  /** Decoded sprite PNG bytes (RGBA, alpha preserved). */
  pngBytes: Buffer;
  /** PNG raster dims — Retina sprites are typically 2× the point size. */
  pixelWidth: number;
  pixelHeight: number;
  /** Sprite draw size in POINTS (NSImage.size). */
  pointWidth: number;
  pointHeight: number;
  /** Hotspot offset within the sprite, in POINTS. */
  hotspotX: number;
  hotspotY: number;
  /** Global cursor position in POINTS, top-left origin. */
  posX: number;
  posY: number;
};

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Sample the current system cursor. Resolves `null` on any failure —
 * callers treat that as "no cursor layer for this capture".
 */
export async function sampleCursor(): Promise<CursorSample | null> {
  if (process.platform !== "darwin") return null;
  const helper = resolveWindowListHelperPath();
  if (helper === null) return null;
  try {
    const { stdout } = await execFileAsync(helper, ["--sample-cursor"], {
      timeout: SAMPLE_TIMEOUT_MS,
      maxBuffer: MAX_SAMPLE_JSON_BYTES
    });
    const parsed: unknown = JSON.parse(stdout);
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.pngBase64 !== "string" ||
      p.pngBase64.length === 0 ||
      !finiteNumber(p.pixelWidth) ||
      !finiteNumber(p.pixelHeight) ||
      !finiteNumber(p.pointWidth) ||
      !finiteNumber(p.pointHeight) ||
      !finiteNumber(p.hotspotX) ||
      !finiteNumber(p.hotspotY) ||
      !finiteNumber(p.posX) ||
      !finiteNumber(p.posY) ||
      p.pixelWidth <= 0 ||
      p.pixelHeight <= 0 ||
      p.pointWidth <= 0 ||
      p.pointHeight <= 0
    ) {
      log.warn("cursor sample: malformed helper payload");
      return null;
    }
    return {
      pngBytes: Buffer.from(p.pngBase64, "base64"),
      pixelWidth: p.pixelWidth,
      pixelHeight: p.pixelHeight,
      pointWidth: p.pointWidth,
      pointHeight: p.pointHeight,
      hotspotX: p.hotspotX,
      hotspotY: p.hotspotY,
      posX: p.posX,
      posY: p.posY
    };
  } catch (cause) {
    // Exit 5 = cursor unavailable (expected on macOS 15+ if the
    // deprecated API stops returning); anything else is logged the
    // same — the capture proceeds without a cursor layer either way.
    log.info("cursor sample unavailable", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return null;
  }
}

/**
 * Compute the cursor layer's placement for a captured region, or null
 * when the cursor isn't inside the region (R6 in the plan — a cursor
 * on another display or outside the selection gets no layer).
 *
 * All rect inputs are LOGICAL points; `regionOrigin` is the captured
 * rect's origin in GLOBAL points (display.bounds origin + selection
 * rect origin). `scaleFactor` maps points → the capture's physical px.
 *
 * Returns the sprite's top-left position + on-canvas draw size in
 * CANVAS PIXELS: position = (pos − hotspot − regionOrigin) · scale;
 * draw size = pointSize · scale (the raster layer's transform scale is
 * then drawSize / naturalPx, handling Retina/XL-cursor sprites whose
 * PNG raster exceeds the point size).
 */
export function computeCursorPlacement(args: {
  sample: Pick<
    CursorSample,
    "posX" | "posY" | "hotspotX" | "hotspotY" | "pointWidth" | "pointHeight"
  >;
  regionOriginX: number;
  regionOriginY: number;
  regionWidth: number;
  regionHeight: number;
  scaleFactor: number;
}): { xPx: number; yPx: number; drawWidthPx: number; drawHeightPx: number } | null {
  const { sample, regionOriginX, regionOriginY, regionWidth, regionHeight, scaleFactor } =
    args;
  const localX = sample.posX - regionOriginX;
  const localY = sample.posY - regionOriginY;
  // R6: the HOTSPOT (the pixel the user "points" with) must be inside
  // the captured region. Sprite overhang past the edge is fine — it
  // clips at the canvas like any raster.
  if (localX < 0 || localY < 0 || localX >= regionWidth || localY >= regionHeight) {
    return null;
  }
  return {
    xPx: (localX - sample.hotspotX) * scaleFactor,
    yPx: (localY - sample.hotspotY) * scaleFactor,
    drawWidthPx: sample.pointWidth * scaleFactor,
    drawHeightPx: sample.pointHeight * scaleFactor
  };
}
