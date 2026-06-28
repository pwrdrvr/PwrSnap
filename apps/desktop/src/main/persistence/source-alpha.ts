// Transparency probe for a capture's source PNG. Feeds the
// `captures.has_alpha` column (migration 0025) which the Library grid +
// editor read to decide whether to paint the transparency checker.
//
// `metadata().hasAlpha` only reports that an alpha *channel* exists —
// macOS screenshots are RGBA even when fully opaque, so it over-reports.
// The truth is `stats().isOpaque`, which inspects the alpha channel's
// actual minimum. stats() decodes the whole image, so we skip it when
// there's no alpha channel to inspect (the common RGB case) and treat a
// stats() failure as opaque — a transparency probe must never block a
// capture from persisting.

import sharp from "sharp";
import type { Metadata } from "sharp";

/**
 * True when `buf` (a PNG/image buffer) has at least one non-opaque pixel.
 *
 * @param buf      the source image bytes
 * @param metadata an already-computed `sharp(buf).metadata()`, if the
 *                 caller has one — lets the persist path reuse its decode
 *                 instead of paying a second metadata pass. Omit to read
 *                 metadata here.
 */
export async function sourceBufferHasAlpha(
  buf: Buffer,
  metadata?: Metadata
): Promise<boolean> {
  const meta = metadata ?? (await sharp(buf).metadata());
  // No alpha channel at all → definitely opaque; skip the full decode.
  if (meta.hasAlpha !== true) return false;
  try {
    const stats = await sharp(buf).stats();
    return !stats.isOpaque;
  } catch {
    return false;
  }
}
