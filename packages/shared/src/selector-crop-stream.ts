export const SELECTOR_CROP_CHUNK_BYTES = 256 * 1024;
export const SELECTOR_CROP_MAX_BYTES = 256 * 1024 * 1024;
export const SELECTOR_CROP_MAX_DIMENSION = 32_768;
export const SELECTOR_CROP_MAX_PIXELS = 100_000_000;

export type SelectorCropStartMessage = {
  type: "crop-start";
  invocationId: number;
  width: number;
  height: number;
  mimeType: "image/png";
  totalBytes: number;
};

export type SelectorCropChunkMessage = {
  type: "crop-chunk";
  invocationId: number;
  sequence: number;
  bytes: ArrayBuffer;
};

export type SelectorCropEndMessage = {
  type: "crop-end";
  invocationId: number;
  chunks: number;
};

export type SelectorCropStreamMessage =
  | SelectorCropStartMessage
  | SelectorCropChunkMessage
  | SelectorCropEndMessage;

export type SelectorCropStreamReply =
  | { type: "crop-started"; invocationId: number }
  | { type: "crop-chunk-accepted"; invocationId: number; sequence: number }
  | { type: "crop-accepted"; invocationId: number }
  | { type: "crop-rejected"; invocationId: number; code: string };

export function isSelectorCropStartMessage(value: unknown): value is SelectorCropStartMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const width = message.width;
  const height = message.height;
  return (
    message.type === "crop-start" &&
    typeof message.invocationId === "number" &&
    Number.isSafeInteger(message.invocationId) &&
    typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    width <= SELECTOR_CROP_MAX_DIMENSION &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0 &&
    height <= SELECTOR_CROP_MAX_DIMENSION &&
    width * height <= SELECTOR_CROP_MAX_PIXELS &&
    message.mimeType === "image/png" &&
    typeof message.totalBytes === "number" &&
    Number.isSafeInteger(message.totalBytes) &&
    message.totalBytes > 0 &&
    message.totalBytes <= SELECTOR_CROP_MAX_BYTES
  );
}

export function isSelectorCropChunkMessage(value: unknown): value is SelectorCropChunkMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "crop-chunk" &&
    typeof message.invocationId === "number" &&
    Number.isSafeInteger(message.invocationId) &&
    typeof message.sequence === "number" &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence >= 0 &&
    message.bytes instanceof ArrayBuffer &&
    message.bytes.byteLength > 0 &&
    message.bytes.byteLength <= SELECTOR_CROP_CHUNK_BYTES
  );
}

export function isSelectorCropEndMessage(value: unknown): value is SelectorCropEndMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "crop-end" &&
    typeof message.invocationId === "number" &&
    Number.isSafeInteger(message.invocationId) &&
    typeof message.chunks === "number" &&
    Number.isSafeInteger(message.chunks) &&
    message.chunks > 0
  );
}
