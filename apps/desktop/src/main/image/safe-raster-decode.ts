import sharp, { type Metadata, type Sharp } from "sharp";
import {
  MAX_IMAGE_DIM_PX,
  PASTE_IMAGE_MAX_BYTES,
  PASTE_IMAGE_MAX_CHANNELS,
  PASTE_IMAGE_MAX_DECODED_BYTES,
  PASTE_IMAGE_MAX_PAGES,
  PASTE_IMAGE_MAX_PIXELS,
  PASTE_IMAGE_MAX_PNG_BYTES
} from "@pwrsnap/shared";

export type SafeRasterErrorCode =
  | "input_size_cap_exceeded"
  | "invalid_dimensions"
  | "pixel_cap_exceeded"
  | "channel_cap_exceeded"
  | "decoded_size_cap_exceeded"
  | "unsupported_multi_page"
  | "output_size_cap_exceeded"
  | "decode_failed";

const ERROR_MESSAGES: Readonly<Record<SafeRasterErrorCode, string>> = {
  input_size_cap_exceeded: "Encoded image exceeds size cap",
  invalid_dimensions: "Image dimensions are invalid",
  pixel_cap_exceeded: "Decoded image exceeds pixel cap",
  channel_cap_exceeded: "Decoded image exceeds channel cap",
  decoded_size_cap_exceeded: "Decoded image exceeds memory cap",
  unsupported_multi_page: "Animated or multi-page images are not supported",
  output_size_cap_exceeded: "Canonical image exceeds output cap",
  decode_failed: "Image failed to decode"
};

/** Path-free typed rejection safe to translate into Result/log codes. */
export class SafeRasterError extends Error {
  readonly code: SafeRasterErrorCode;

  constructor(code: SafeRasterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "SafeRasterError";
    this.code = code;
  }
}

export type SafeRasterMetadata = {
  widthPx: number;
  heightPx: number;
  channels: number;
  pages: number;
  decodedBytes: number;
  format: Metadata["format"];
  density?: number;
};

export type RasterMetadataLike = {
  width: number;
  height: number;
  channels: number;
  depth: Metadata["depth"];
  format: Metadata["format"];
  density?: number | undefined;
  pages?: number | undefined;
  pageHeight?: number | undefined;
  delay?: number[] | undefined;
};

const DEPTH_BYTES: Readonly<Record<Metadata["depth"], number>> = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  complex: 8,
  double: 8,
  dpcomplex: 16
};

const SHARP_INPUT_OPTIONS = {
  failOn: "warning" as const,
  limitInputPixels: PASTE_IMAGE_MAX_PIXELS,
  limitInputChannels: PASTE_IMAGE_MAX_CHANNELS,
  sequentialRead: true,
  unlimited: false
};

function checkedProduct(...values: readonly number[]): number | null {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    product *= value;
    if (!Number.isSafeInteger(product)) return null;
  }
  return product;
}

/** Validate decoder metadata before any pixel decode or PNG encode starts. */
export function validateSafeRasterMetadata(
  metadata: RasterMetadataLike
): SafeRasterMetadata {
  const { width, height, channels } = metadata;
  if (
    width > MAX_IMAGE_DIM_PX ||
    height > MAX_IMAGE_DIM_PX ||
    checkedProduct(width, height) === null
  ) {
    throw new SafeRasterError("invalid_dimensions");
  }

  const pages = metadata.pages ?? 1;
  if (
    pages !== PASTE_IMAGE_MAX_PAGES ||
    (metadata.pageHeight !== undefined && metadata.pageHeight !== height) ||
    (metadata.delay?.length ?? 0) > PASTE_IMAGE_MAX_PAGES
  ) {
    throw new SafeRasterError("unsupported_multi_page");
  }
  if (
    !Number.isSafeInteger(channels) ||
    channels <= 0 ||
    channels > PASTE_IMAGE_MAX_CHANNELS
  ) {
    throw new SafeRasterError("channel_cap_exceeded");
  }

  const pixels = checkedProduct(width, height);
  if (pixels === null) throw new SafeRasterError("invalid_dimensions");
  if (pixels > PASTE_IMAGE_MAX_PIXELS) {
    throw new SafeRasterError("pixel_cap_exceeded");
  }

  const bytesPerSample = DEPTH_BYTES[metadata.depth];
  const decodedBytes = checkedProduct(pixels, channels, bytesPerSample);
  if (
    decodedBytes === null ||
    decodedBytes > PASTE_IMAGE_MAX_DECODED_BYTES
  ) {
    throw new SafeRasterError("decoded_size_cap_exceeded");
  }

  return {
    widthPx: width,
    heightPx: height,
    channels,
    pages,
    decodedBytes,
    format: metadata.format,
    ...(metadata.density === undefined ? {} : { density: metadata.density })
  };
}

/** Preflight an Electron NativeImage before its synchronous `toPNG()` call. */
export function validateSafeRgbaRasterDimensions(
  width: number,
  height: number
): SafeRasterMetadata {
  return validateSafeRasterMetadata({
    width,
    height,
    channels: 4,
    depth: "uchar",
    format: "png",
    pages: 1
  });
}

function translateSharpProbeError(cause: unknown): SafeRasterError {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (message.includes("pixel limit")) {
    return new SafeRasterError("pixel_cap_exceeded");
  }
  if (message.includes("channel limit")) {
    return new SafeRasterError("channel_cap_exceeded");
  }
  return new SafeRasterError("decode_failed");
}

export async function inspectSafeRaster(
  inputBytes: Buffer
): Promise<SafeRasterMetadata> {
  if (
    inputBytes.byteLength === 0 ||
    inputBytes.byteLength > PASTE_IMAGE_MAX_BYTES
  ) {
    throw new SafeRasterError("input_size_cap_exceeded");
  }
  try {
    const metadata = await sharp(inputBytes, SHARP_INPUT_OPTIONS).metadata();
    return validateSafeRasterMetadata(metadata);
  } catch (cause) {
    if (cause instanceof SafeRasterError) throw cause;
    throw translateSharpProbeError(cause);
  }
}

async function readBoundedPngOutput(
  pipeline: Sharp,
  maxOutputBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of pipeline) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxOutputBytes) {
        throw new SafeRasterError("output_size_cap_exceeded");
      }
      chunks.push(bytes);
    }
  } catch (cause) {
    if (cause instanceof SafeRasterError) throw cause;
    throw new SafeRasterError("decode_failed");
  } finally {
    pipeline.destroy();
  }
  return Buffer.concat(chunks, totalBytes);
}

/**
 * Validate an encoded still image, then return a bounded PNG. The PNG stream
 * is accumulated only up to the configured cap; raw decode is independently
 * bounded by metadata-derived pixels × channels × sample depth.
 */
export async function canonicalizeSafeRasterToPng(
  inputBytes: Buffer,
  options: { preservePng?: boolean; maxOutputBytes?: number } = {}
): Promise<{ pngBytes: Buffer; metadata: SafeRasterMetadata }> {
  const metadata = await inspectSafeRaster(inputBytes);
  const requestedOutputBytes = options.maxOutputBytes ?? PASTE_IMAGE_MAX_PNG_BYTES;
  if (!Number.isSafeInteger(requestedOutputBytes) || requestedOutputBytes <= 0) {
    throw new SafeRasterError("output_size_cap_exceeded");
  }
  const maxOutputBytes = Math.min(
    requestedOutputBytes,
    PASTE_IMAGE_MAX_PNG_BYTES
  );

  if (options.preservePng === true && metadata.format === "png") {
    if (inputBytes.byteLength > maxOutputBytes) {
      throw new SafeRasterError("output_size_cap_exceeded");
    }
    return { pngBytes: inputBytes, metadata };
  }

  // `pages: 1` is safe only after the unrestricted metadata probe above has
  // proved the source itself contains exactly one page/frame. Passing it to
  // metadata() would make sharp report the selected page count and conceal an
  // animation.
  const pipeline = sharp(inputBytes, {
    ...SHARP_INPUT_OPTIONS,
    pages: PASTE_IMAGE_MAX_PAGES
  }).png();
  const pngBytes = await readBoundedPngOutput(pipeline, maxOutputBytes);
  return { pngBytes, metadata };
}
