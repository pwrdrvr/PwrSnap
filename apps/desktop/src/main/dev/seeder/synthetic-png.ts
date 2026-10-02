// Synthetic source image for one seeded row. Kept apart from runner.ts
// (which pulls in electron, the bus, and the DB) so tests can decode it
// directly.
//
// Every pixel is invented: a background hue derived from the row's
// synthetic bundle id and an 8×8 block in the top-left whose RGB is the
// row index. Nothing here reads a screen, a file, or the user's library.

import sharp from "sharp";

import type { PlannedRow } from "./profiles";

export const SYNTHETIC_PNG_SIZE_PX = 64;
const INDEX_BLOCK_PX = 8;
const CHANNELS = 3;

/**
 * Compose a 64×64 opaque RGB PNG: bundle-id-derived hue background +
 * 8×8 index block top-left. Each row's sha256 is unique because the
 * block's RGB is the row index (unique up to 2^24 rows).
 *
 * Two things here are load-bearing for seeding speed:
 *
 * - **No alpha channel.** `persistCaptureFromTempV2` probes transparency
 *   with a full `stats()` decode whenever the PNG carries an alpha
 *   channel (source-alpha.ts), which measured ~7–11 ms a row. sharp's
 *   `composite()` always adds one, so the pixels are built raw instead.
 * - **One encode.** The previous generator ran three sharp pipelines a
 *   row (block, background, composite).
 *
 * Default compression, not `compressionLevel: 0`: two flat colors
 * deflate to ~200 bytes against ~12 KB stored, at the same encode time,
 * and a v2 capture keeps its source twice (in the bundle and as the
 * render cache's source.png).
 */
export async function composeSyntheticPng(
  row: Pick<PlannedRow, "index" | "bundleId">
): Promise<Buffer> {
  return sharp(composeSyntheticPixels(row), {
    raw: { width: SYNTHETIC_PNG_SIZE_PX, height: SYNTHETIC_PNG_SIZE_PX, channels: CHANNELS }
  })
    .png()
    .toBuffer();
}

/** Raw RGB pixels for {@link composeSyntheticPng}. Exported for tests. */
export function composeSyntheticPixels(row: Pick<PlannedRow, "index" | "bundleId">): Buffer {
  const bg = bundleIdToColor(row.bundleId);
  const idx = indexToColor(row.index);
  const size = SYNTHETIC_PNG_SIZE_PX;
  const pixels = Buffer.alloc(size * size * CHANNELS);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = x < INDEX_BLOCK_PX && y < INDEX_BLOCK_PX ? idx : bg;
      const o = (y * size + x) * CHANNELS;
      pixels[o] = c.r;
      pixels[o + 1] = c.g;
      pixels[o + 2] = c.b;
    }
  }
  return pixels;
}

function bundleIdToColor(bundleId: string): { r: number; g: number; b: number } {
  let h = 5381;
  for (let i = 0; i < bundleId.length; i++) {
    h = ((h << 5) + h + bundleId.charCodeAt(i)) | 0;
  }
  // Map to a HSL-inspired palette: warm, saturated, mid-light.
  const hue = (h >>> 0) % 360;
  return hslToRgb(hue, 0.55, 0.40);
}

function indexToColor(index: number): { r: number; g: number; b: number } {
  return {
    r: index & 0xff,
    g: (index >>> 8) & 0xff,
    b: (index >>> 16) & 0xff
  };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}
