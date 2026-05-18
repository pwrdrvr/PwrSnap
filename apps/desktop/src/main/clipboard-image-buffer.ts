import sharp from "sharp";

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
  | { ok: true; tempPath: string }
  | { ok: false; failures: RawClipboardDecodeFailure[] }
> {
  const failures: RawClipboardDecodeFailure[] = [];
  for (const format of clipboardImageBufferFormats(formats)) {
    try {
      const tempPath = await makeTempPath();
      await sharp(readBuffer(format)).png().toFile(tempPath);
      return { ok: true, tempPath };
    } catch (cause) {
      failures.push({ source: format, cause });
    }
  }
  return { ok: false, failures };
}
