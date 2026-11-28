// Bake a contact sheet PNG: every rendered cart image on one sheet, placed by
// the shared `planContactSheet` geometry. Sizes come from the RENDERED files
// (edits can crop), never from the capture records.

import sharp, { type OverlayOptions } from "sharp";
import {
  CONTACT_SHEET_WIDTHS,
  planContactSheet,
  type ContactSheetBackground,
  type ContactSheetLayout,
  type ContactSheetPlan,
  type ContactSheetSize
} from "@pwrsnap/shared";

/** The 45° hatch is a seamless tile: a pixel is dark when (x + y) mod period
 *  falls in the first half, so the stripes meet across every tile edge. */
const HATCH_PERIOD = 16;
const HATCH_DARK = [0x1d, 0x1d, 0x1f, 0xff] as const;
const HATCH_LIGHT = [0x2a, 0x2a, 0x2d, 0xff] as const;

export function hatchTile(period: number = HATCH_PERIOD): Buffer {
  const tile = Buffer.alloc(period * period * 4);
  for (let y = 0; y < period; y++) {
    for (let x = 0; x < period; x++) {
      const color = (x + y) % period < period / 2 ? HATCH_DARK : HATCH_LIGHT;
      tile.set(color, (y * period + x) * 4);
    }
  }
  return tile;
}

function solidBackground(background: ContactSheetBackground): { r: number; g: number; b: number; alpha: number } {
  switch (background) {
    case "black":
      return { r: 0, g: 0, b: 0, alpha: 1 };
    case "white":
      return { r: 255, g: 255, b: 255, alpha: 1 };
    case "clear":
    case "hatch":
      // Hatch paints over a transparent base with a tiled overlay.
      return { r: 0, g: 0, b: 0, alpha: 0 };
  }
}

export type ContactSheetBakeResult = {
  plan: ContactSheetPlan;
};

/**
 * Lay `imagePaths` (rendered PNGs, in cart order) out at `size` with
 * `layout`, and write the sheet to `destPath`. Throws when an image cannot be
 * read; the caller decides whether that is fatal. Checks `signal` between
 * tiles and before the write.
 */
export async function bakeContactSheet(args: {
  imagePaths: readonly string[];
  size: ContactSheetSize;
  layout: ContactSheetLayout;
  destPath: string;
  signal?: AbortSignal;
}): Promise<ContactSheetBakeResult> {
  const images = [];
  for (const path of args.imagePaths) {
    args.signal?.throwIfAborted();
    const meta = await sharp(path).metadata();
    images.push({ width: meta.width ?? 1, height: meta.height ?? 1 });
  }
  const plan = planContactSheet({
    images,
    widthPx: CONTACT_SHEET_WIDTHS[args.size],
    columns: args.layout.columns,
    spacing: args.layout.spacing
  });

  const overlays: OverlayOptions[] = [];
  if (args.layout.background === "hatch") {
    overlays.push({
      input: hatchTile(),
      raw: { width: HATCH_PERIOD, height: HATCH_PERIOD, channels: 4 },
      tile: true
    });
  }
  for (const [index, path] of args.imagePaths.entries()) {
    args.signal?.throwIfAborted();
    const tile = plan.tiles[index]!;
    // A fast PNG keeps each tile compact in memory until the composite.
    const input = await sharp(path)
      .resize(tile.width, tile.height, { fit: "fill" })
      .png({ compressionLevel: 1 })
      .toBuffer();
    overlays.push({ input, top: tile.y, left: tile.x });
  }
  args.signal?.throwIfAborted();
  await sharp({
    create: {
      width: plan.width,
      height: plan.height,
      channels: 4,
      background: solidBackground(args.layout.background)
    }
  })
    .composite(overlays)
    .png()
    .toFile(args.destPath);
  return { plan };
}
