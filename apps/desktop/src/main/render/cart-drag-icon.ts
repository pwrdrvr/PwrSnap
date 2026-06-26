// Composes the macOS drag-cursor thumbnail for the cart Zip drag-out: the
// first cart image as a cover photo, rounded, with an orange image-count
// badge in the bottom-right corner and a "ZIP" chip in the top-left. Without
// this the drag ghost was the first image at full resolution (a giant,
// legible screenshot under the cursor — see ipc.ts cart drag bridge).
//
// Rasterizes via sharp's SVG engine, the same path compose.ts uses for v2
// overlay shapes + text (`font-family="Helvetica, Arial, sans-serif"` renders
// on macOS). Best-effort: if the badged composite fails it falls back to a
// plain rounded cover thumbnail, and only throws if sharp can't read the
// source at all — the caller then drops back to the raw image path.

import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const CARD_W = 160;
const CARD_H = 112;
const CORNER_RADIUS = 14;

/** Orange tangerine accent + the dark on-accent text color, mirroring the
 *  renderer's `--accent` / `--button-text-on-accent` so the drag chip reads
 *  as PwrSnap chrome. Hardcoded here because main has no CSS-var context. */
const ACCENT = "#ff8a1f";
const ON_ACCENT = "#1a0e00";

function roundedMaskSvg(): Buffer {
  return Buffer.from(
    `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${CARD_W}" height="${CARD_H}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="#fff"/>` +
      `</svg>`
  );
}

/** ZIP chip (top-left) + image-count badge (bottom-right) + a faint inner
 *  hairline so the card reads as a tile on any background. `count` is clamped
 *  to a 2-glyph label (`99+`). */
function overlaySvg(count: number): Buffer {
  const label = count > 99 ? "99+" : String(count);
  const badgeR = 18;
  const cx = CARD_W - 8 - badgeR;
  const cy = CARD_H - 8 - badgeR;
  const countFont = label.length > 2 ? 13 : 17;
  return Buffer.from(
    `<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">` +
      // faint inner border
      `<rect x="0.75" y="0.75" width="${CARD_W - 1.5}" height="${CARD_H - 1.5}" rx="${CORNER_RADIUS - 0.75}" ry="${CORNER_RADIUS - 0.75}" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>` +
      // ZIP chip
      `<rect x="8" y="8" width="40" height="19" rx="6" ry="6" fill="#000000" fill-opacity="0.62"/>` +
      `<text x="28" y="21.5" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="0.5" fill="${ACCENT}" text-anchor="middle">ZIP</text>` +
      // count badge
      `<circle cx="${cx}" cy="${cy}" r="${badgeR}" fill="${ACCENT}" stroke="${ON_ACCENT}" stroke-width="2.5"/>` +
      `<text x="${cx}" y="${cy + countFont / 2 - 1.5}" font-family="Helvetica, Arial, sans-serif" font-size="${countFont}" font-weight="800" fill="${ON_ACCENT}" text-anchor="middle">${label}</text>` +
      `</svg>`
  );
}

/**
 * Write a badged drag thumbnail for `imagePath` to `destPath` (PNG). The
 * caller treats a throw as "couldn't build it" and falls back to the raw
 * image path. The badged composite itself degrades to a plain rounded cover
 * thumbnail if the overlay step fails, so a font/raster hiccup still yields a
 * usable (if plainer) ghost rather than nothing.
 */
export async function composeCartDragIcon(opts: {
  imagePath: string;
  count: number;
  destPath: string;
}): Promise<void> {
  const cover = (): sharp.Sharp =>
    sharp(opts.imagePath).resize(CARD_W, CARD_H, { fit: "cover", position: "centre" });
  try {
    const png = await cover()
      .composite([
        { input: roundedMaskSvg(), blend: "dest-in" },
        { input: overlaySvg(opts.count), blend: "over" }
      ])
      .png()
      .toBuffer();
    await writeFile(opts.destPath, png);
  } catch {
    // Overlay/badge failed — fall back to a plain rounded cover. This still
    // throws (out to the caller) if sharp can't read the source at all.
    const png = await cover()
      .composite([{ input: roundedMaskSvg(), blend: "dest-in" }])
      .png()
      .toBuffer();
    await writeFile(opts.destPath, png);
  }
}
