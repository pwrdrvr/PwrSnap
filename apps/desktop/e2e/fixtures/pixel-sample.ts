// Pixel-sampling helper for region-selection assertions.
//
// Specs that drive a real screencapture run the resulting PNG through
// `samplePixel(buffer, x, y)` and compare against the expected color.
// Tolerance is per-channel — Splashtop / xvfb compositors don't always
// preserve exact RGB (anti-aliased edges, gamma round-trips), so we
// allow a small delta to keep CI from flapping on otherwise-correct
// captures.

import sharp from "sharp";

export type Rgb = { r: number; g: number; b: number };

export function hexToRgb(hex: string): Rgb {
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length !== 6) {
    throw new Error(`expected 6-digit hex, got: ${hex}`);
  }
  return {
    r: Number.parseInt(cleaned.slice(0, 2), 16),
    g: Number.parseInt(cleaned.slice(2, 4), 16),
    b: Number.parseInt(cleaned.slice(4, 6), 16)
  };
}

/**
 * Read a single (x, y) pixel out of an image file. Reads via sharp's
 * raw extract — much cheaper than decoding the whole frame and slicing
 * on the JS side.
 */
export async function samplePixel(
  imagePath: string,
  x: number,
  y: number
): Promise<Rgb> {
  const { data } = await sharp(imagePath)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  if (data.length < 3) {
    throw new Error(`unexpected raw pixel buffer length: ${data.length}`);
  }
  return { r: data[0]!, g: data[1]!, b: data[2]! };
}

/**
 * Assert two colors are equal within a per-channel tolerance.
 * Defaults to ±8 — tight enough to fail when we capture the wrong
 * region, loose enough to absorb compositor jitter.
 */
export function colorsClose(a: Rgb, b: Rgb, tolerance = 8): boolean {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

export function formatRgb(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}
