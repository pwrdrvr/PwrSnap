import sharp from "sharp";

type RawImage = {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
};

export type PngOptimizationResult = {
  buffer: Buffer;
  optimized: boolean;
  originalBytes: number;
  byteSize: number;
  strategy: "original" | "truecolor" | "palette";
  uniqueColors: number | null;
};

export type PngOptimizationOptions = {
  /**
   * Set false when the caller already encoded the input with the desired
   * truecolor PNG settings and only wants the exact-palette win.
   */
  recompressTruecolor?: boolean;
};

const MAX_EXACT_PALETTE_COLORS = 256;

const TRUECOLOR_PNG_OPTIONS = {
  compressionLevel: 9,
  adaptiveFiltering: true
} as const;

/**
 * Produce the smallest PNG that decodes to exactly the same RGBA pixels.
 * Palette output is used only when the image has <=256 unique RGBA colors
 * and the encoded candidate survives a raw-pixel equality check.
 */
export async function optimizePngBuffer(
  input: Buffer,
  options: PngOptimizationOptions = {}
): Promise<PngOptimizationResult> {
  const raw = await decodeRgba(input);
  const uniqueColors = countUniqueColorsUpTo(raw.data, MAX_EXACT_PALETTE_COLORS + 1);

  let best = input;
  let strategy: PngOptimizationResult["strategy"] = "original";

  if (options.recompressTruecolor !== false) {
    const truecolor = await encodeTruecolor(raw);
    if (await isSmallerPixelMatch(truecolor, best, raw)) {
      best = truecolor;
      strategy = "truecolor";
    }
  }

  if (uniqueColors <= MAX_EXACT_PALETTE_COLORS) {
    const palette = await encodePalette(raw, uniqueColors);
    if (await isSmallerPixelMatch(palette, best, raw)) {
      best = palette;
      strategy = "palette";
    }
  }

  return {
    buffer: best,
    optimized: best.length < input.length,
    originalBytes: input.length,
    byteSize: best.length,
    strategy,
    uniqueColors: uniqueColors <= MAX_EXACT_PALETTE_COLORS ? uniqueColors : null
  };
}

async function decodeRgba(input: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width <= 0 || info.height <= 0 || info.channels !== 4) {
    throw new Error(
      `png-optimize: expected RGBA decode, got ${info.width}x${info.height}x${info.channels}`
    );
  }

  return {
    data,
    width: info.width,
    height: info.height,
    channels: 4
  };
}

async function encodeTruecolor(raw: RawImage): Promise<Buffer> {
  return sharp(raw.data, {
    raw: {
      width: raw.width,
      height: raw.height,
      channels: raw.channels
    }
  })
    .png(TRUECOLOR_PNG_OPTIONS)
    .toBuffer();
}

async function encodePalette(raw: RawImage, uniqueColors: number): Promise<Buffer> {
  return sharp(raw.data, {
    raw: {
      width: raw.width,
      height: raw.height,
      channels: raw.channels
    }
  })
    .png({
      compressionLevel: 9,
      palette: true,
      colours: Math.max(2, uniqueColors),
      dither: 0,
      effort: 7
    })
    .toBuffer();
}

async function isSmallerPixelMatch(
  candidate: Buffer,
  currentBest: Buffer,
  expected: RawImage
): Promise<boolean> {
  if (candidate.length >= currentBest.length) return false;

  const actual = await decodeRgba(candidate);
  return (
    actual.width === expected.width &&
    actual.height === expected.height &&
    actual.data.length === expected.data.length &&
    Buffer.compare(actual.data, expected.data) === 0
  );
}

function countUniqueColorsUpTo(data: Buffer, limit: number): number {
  const colors = new Set<number>();
  for (let i = 0; i < data.length; i += 4) {
    const color =
      data[i] * 0x1000000 +
      data[i + 1] * 0x10000 +
      data[i + 2] * 0x100 +
      data[i + 3];
    colors.add(color);
    if (colors.size >= limit) return colors.size;
  }
  return colors.size;
}
