/**
 * Binary contract shared by the Windows pagefile-mapping helper and main.
 *
 * All integers are unsigned little-endian. Rows are top-to-bottom, tightly
 * packed, and every pixel is four bytes in R, G, B, A order. The capture is
 * an opaque sRGB desktop frame, so A is always 255. The fixed header keeps a
 * malformed or confused mapping from turning into an unbounded allocation.
 */

export const WINDOWS_SNAPSHOT_MAGIC = new Uint8Array([
  0x50, 0x57, 0x52, 0x53, 0x53, 0x4e, 0x50, 0x00 // "PWRSSNP\0"
]);
export const WINDOWS_SNAPSHOT_VERSION = 1;
export const WINDOWS_SNAPSHOT_HEADER_BYTES = 64;
export const WINDOWS_SNAPSHOT_PIXEL_FORMAT_RGBA8_SRGB_OPAQUE = 1;
export const WINDOWS_SNAPSHOT_BYTES_PER_PIXEL = 4;
export const WINDOWS_SNAPSHOT_MAX_DIMENSION = 32_768;
export const WINDOWS_SNAPSHOT_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

export type WindowsSnapshotHeader = Readonly<{
  version: 1;
  width: number;
  height: number;
  stride: number;
  pixelFormat: 1;
  byteLength: number;
  totalByteLength: number;
  nonceHex: string;
}>;

export class WindowsSnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsSnapshotFormatError";
  }
}

function checkedLayout(width: number, height: number, stride: number): {
  payload: number;
  total: number;
} {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > WINDOWS_SNAPSHOT_MAX_DIMENSION ||
    height > WINDOWS_SNAPSHOT_MAX_DIMENSION
  ) {
    throw new WindowsSnapshotFormatError("snapshot dimensions are out of bounds");
  }
  const expectedStride = BigInt(width) * BigInt(WINDOWS_SNAPSHOT_BYTES_PER_PIXEL);
  if (!Number.isInteger(stride) || BigInt(stride) !== expectedStride) {
    throw new WindowsSnapshotFormatError("snapshot stride is not tightly packed RGBA8");
  }
  const payload = expectedStride * BigInt(height);
  if (payload > BigInt(WINDOWS_SNAPSHOT_MAX_PAYLOAD_BYTES)) {
    throw new WindowsSnapshotFormatError("snapshot payload exceeds the bounded transport limit");
  }
  const total = payload + BigInt(WINDOWS_SNAPSHOT_HEADER_BYTES);
  if (payload > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WindowsSnapshotFormatError("snapshot layout exceeds JavaScript's safe integer range");
  }
  return { payload: Number(payload), total: Number(total) };
}

export function validateWindowsSnapshotDescriptor(
  value: Omit<WindowsSnapshotHeader, "version" | "pixelFormat" | "totalByteLength"> & {
    version?: number;
    pixelFormat?: number;
    totalByteLength?: number;
  }
): WindowsSnapshotHeader {
  const layout = checkedLayout(value.width, value.height, value.stride);
  if (value.version !== undefined && value.version !== WINDOWS_SNAPSHOT_VERSION) {
    throw new WindowsSnapshotFormatError("unsupported snapshot version");
  }
  if (
    value.pixelFormat !== undefined &&
    value.pixelFormat !== WINDOWS_SNAPSHOT_PIXEL_FORMAT_RGBA8_SRGB_OPAQUE
  ) {
    throw new WindowsSnapshotFormatError("unsupported snapshot pixel format");
  }
  if (value.byteLength !== layout.payload) {
    throw new WindowsSnapshotFormatError("snapshot byte length does not match its dimensions");
  }
  if (value.totalByteLength !== undefined && value.totalByteLength !== layout.total) {
    throw new WindowsSnapshotFormatError("snapshot total length does not match its header");
  }
  if (!/^[0-9a-f]{32}$/.test(value.nonceHex)) {
    throw new WindowsSnapshotFormatError("snapshot nonce is malformed");
  }
  return {
    version: WINDOWS_SNAPSHOT_VERSION,
    width: value.width,
    height: value.height,
    stride: value.stride,
    pixelFormat: WINDOWS_SNAPSHOT_PIXEL_FORMAT_RGBA8_SRGB_OPAQUE,
    byteLength: layout.payload,
    totalByteLength: layout.total,
    nonceHex: value.nonceHex
  };
}

export function parseWindowsSnapshotHeader(
  bytes: Uint8Array,
  expected?: Partial<Pick<WindowsSnapshotHeader, "nonceHex" | "width" | "height" | "totalByteLength">>
): WindowsSnapshotHeader {
  if (bytes.byteLength < WINDOWS_SNAPSHOT_HEADER_BYTES) {
    throw new WindowsSnapshotFormatError("snapshot header is truncated");
  }
  for (let i = 0; i < WINDOWS_SNAPSHOT_MAGIC.byteLength; i += 1) {
    if (bytes[i] !== WINDOWS_SNAPSHOT_MAGIC[i]) {
      throw new WindowsSnapshotFormatError("snapshot magic is invalid");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, WINDOWS_SNAPSHOT_HEADER_BYTES);
  const version = view.getUint32(8, true);
  const headerBytes = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const height = view.getUint32(20, true);
  const stride = view.getUint32(24, true);
  const pixelFormat = view.getUint32(28, true);
  const byteLengthBig = view.getBigUint64(32, true);
  const totalByteLengthBig = view.getBigUint64(40, true);
  if (version !== WINDOWS_SNAPSHOT_VERSION) {
    throw new WindowsSnapshotFormatError("unsupported snapshot version");
  }
  if (headerBytes !== WINDOWS_SNAPSHOT_HEADER_BYTES) {
    throw new WindowsSnapshotFormatError("snapshot header length is invalid");
  }
  if (pixelFormat !== WINDOWS_SNAPSHOT_PIXEL_FORMAT_RGBA8_SRGB_OPAQUE) {
    throw new WindowsSnapshotFormatError("unsupported snapshot pixel format");
  }
  if (
    byteLengthBig > BigInt(Number.MAX_SAFE_INTEGER) ||
    totalByteLengthBig > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new WindowsSnapshotFormatError("snapshot lengths exceed JavaScript's safe integer range");
  }
  const nonceHex = Array.from(bytes.subarray(48, 64), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const header = validateWindowsSnapshotDescriptor({
    version,
    width,
    height,
    stride,
    pixelFormat,
    byteLength: Number(byteLengthBig),
    totalByteLength: Number(totalByteLengthBig),
    nonceHex
  });
  if (expected?.nonceHex !== undefined && header.nonceHex !== expected.nonceHex) {
    throw new WindowsSnapshotFormatError("snapshot nonce does not match the registry entry");
  }
  if (expected?.width !== undefined && header.width !== expected.width) {
    throw new WindowsSnapshotFormatError("snapshot width does not match the registry entry");
  }
  if (expected?.height !== undefined && header.height !== expected.height) {
    throw new WindowsSnapshotFormatError("snapshot height does not match the registry entry");
  }
  if (
    expected?.totalByteLength !== undefined &&
    header.totalByteLength !== expected.totalByteLength
  ) {
    throw new WindowsSnapshotFormatError("snapshot size does not match the registry entry");
  }
  return header;
}

/** Test/support encoder for contract fixtures. Production headers are written by Win32. */
export function encodeWindowsSnapshotHeader(header: WindowsSnapshotHeader): Uint8Array {
  const valid = validateWindowsSnapshotDescriptor(header);
  const bytes = new Uint8Array(WINDOWS_SNAPSHOT_HEADER_BYTES);
  bytes.set(WINDOWS_SNAPSHOT_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, valid.version, true);
  view.setUint32(12, WINDOWS_SNAPSHOT_HEADER_BYTES, true);
  view.setUint32(16, valid.width, true);
  view.setUint32(20, valid.height, true);
  view.setUint32(24, valid.stride, true);
  view.setUint32(28, valid.pixelFormat, true);
  view.setBigUint64(32, BigInt(valid.byteLength), true);
  view.setBigUint64(40, BigInt(valid.totalByteLength), true);
  for (let i = 0; i < 16; i += 1) {
    bytes[48 + i] = Number.parseInt(valid.nonceHex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
