import sharp from "sharp";
import { writeFile } from "node:fs/promises";

const CLIPBOARD_IMAGE_FORMAT_NEEDLES = [
  "avif",
  "bmp",
  "gif",
  "jp2",
  "jpeg",
  "jpg",
  "pict",
  "png",
  "tiff",
  "webp"
] as const;

export type RawClipboardDecodeFailure = {
  source: string;
  cause: unknown;
};

export type IngestedClipboardImage = {
  tempPath: string;
  /** Display scale inferred from the source image's DPI metadata. */
  devicePixelRatio: number;
};

/**
 * Infer a display scale factor from an image's DPI density.
 *
 * macOS tags raster assets via the PNG `pHYs` chunk / TIFF resolution
 * tags: 1× content at 72 DPI, Retina (2×) at 144, 3× at 216. Recover the
 * scale by rounding `density / 72`, clamped to [1, 3]. Anything missing,
 * non-finite, or ≤ 72 DPI is treated as 1× — this is a best-effort
 * heuristic (not every source tags density), so callers must tolerate the
 * 1× default rather than depend on it.
 */
export function devicePixelRatioFromDensity(density: number | undefined): number {
  if (density === undefined || !Number.isFinite(density) || density <= 72) return 1;
  return Math.min(3, Math.round(density / 72));
}

/**
 * Turn a decoded-image buffer into a temp PNG, **preserving the original
 * bytes verbatim when they're already PNG**.
 *
 * Re-encoding a decoded bitmap (`nativeImage.toPNG()` or `sharp().png()`)
 * inflates the file — the Chromium / libvips PNG encoder is not the
 * source encoder — and strips the `pHYs` density we need for the DPR.
 * Storing the source PNG bytes keeps both the size and the DPI signal
 * intact. Non-PNG inputs (TIFF / JPEG / …) must still be encoded to PNG,
 * but we read their density first so the DPR survives.
 *
 * Throws if the buffer doesn't decode as an image (the caller records the
 * failure and tries the next clipboard flavor).
 */
export async function ingestImageBufferToTempPng(
  buf: Buffer,
  makeTempPath: () => Promise<string>
): Promise<IngestedClipboardImage> {
  const meta = await sharp(buf).metadata();
  if (meta.width === undefined || meta.height === undefined || meta.width <= 0 || meta.height <= 0) {
    throw new Error("clipboard image has no decodable dimensions");
  }
  const devicePixelRatio = devicePixelRatioFromDensity(meta.density);
  const tempPath = await makeTempPath();
  if (meta.format === "png") {
    await writeFile(tempPath, buf);
  } else {
    await sharp(buf).png().toFile(tempPath);
  }
  return { tempPath, devicePixelRatio };
}

export function clipboardImageBufferFormats(formats: readonly string[]): string[] {
  return formats.filter(isClipboardImageBufferFormat);
}

export function isClipboardImageBufferFormat(format: string): boolean {
  const lower = format.toLowerCase();
  if (lower.startsWith("image/")) return false;
  if (lower.includes("file-url") || lower.includes("url")) return false;
  return CLIPBOARD_IMAGE_FORMAT_NEEDLES.some((needle) => lower.includes(needle));
}

export async function writeFirstDecodableClipboardBufferToPng({
  formats,
  readBuffer,
  makeTempPath
}: {
  formats: readonly string[];
  readBuffer: (format: string) => Buffer;
  makeTempPath: () => Promise<string>;
}): Promise<
  | ({ ok: true } & IngestedClipboardImage)
  | { ok: false; failures: RawClipboardDecodeFailure[] }
> {
  const failures: RawClipboardDecodeFailure[] = [];
  for (const format of clipboardImageBufferFormats(formats)) {
    try {
      const ingested = await ingestImageBufferToTempPng(readBuffer(format), makeTempPath);
      return { ok: true, ...ingested };
    } catch (cause) {
      failures.push({ source: format, cause });
    }
  }
  return { ok: false, failures };
}
