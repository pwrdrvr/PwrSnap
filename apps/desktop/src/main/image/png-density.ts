import { crc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHUNK_OVERHEAD = 12; // length, type and CRC

/** Set square-pixel density on an already encoded PNG without touching the
 * compressed pixels. Keep existing EXIF resolution in sync with pHYs
 * because ImageIO and libvips prefer it when both are present. */
export function pngWithDensity(png: Buffer, dpi: number): Buffer {
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Expected a PNG");
  }

  const pixelsPerMetre = Math.round(dpi / 0.0254);
  const densityChunk = Buffer.alloc(CHUNK_OVERHEAD + 9);
  densityChunk.writeUInt32BE(9, 0);
  densityChunk.write("pHYs", 4, "ascii");
  densityChunk.writeUInt32BE(pixelsPerMetre, 8);
  densityChunk.writeUInt32BE(pixelsPerMetre, 12);
  densityChunk[16] = 1; // metre
  densityChunk.writeUInt32BE(crc32(densityChunk.subarray(4, 17)), 17);

  // pHYs goes before the first IDAT. Older PNGs can put eXIf after their
  // image data, so scan chunk boundaries through IEND.
  const parts: Buffer[] = [];
  let remaining = 0;
  let hasDensity = false;
  let seenImageData = false;
  for (let start = PNG_SIGNATURE.length; start + CHUNK_OVERHEAD <= png.length; ) {
    const end = start + CHUNK_OVERHEAD + png.readUInt32BE(start);
    if (end > png.length) break;
    const type = png.toString("ascii", start + 4, start + 8);
    if (type === "IDAT" && !seenImageData) {
      if (!hasDensity) {
        parts.push(png.subarray(remaining, start), densityChunk);
        remaining = start;
      }
      seenImageData = true;
    }
    if (type === "IEND" && seenImageData) {
      return parts.length === 0 ? png : Buffer.concat([...parts, png.subarray(remaining)]);
    }
    if (type === "pHYs" || type === "eXIf") {
      const original = png.subarray(start, end);
      const updated = type === "pHYs" ? densityChunk : exifWithDensity(original, dpi);
      if (type === "pHYs") hasDensity = true;
      if (!original.equals(updated)) {
        parts.push(png.subarray(remaining, start), updated);
        remaining = end;
      }
    }
    start = end;
  }
  throw new Error("PNG is missing image data or its end marker");
}

function exifWithDensity(chunk: Buffer, dpi: number): Buffer {
  const TIFF_OFFSET = 8; // chunk length and type
  const tiffLength = chunk.length - CHUNK_OVERHEAD;
  if (tiffLength < 8) return chunk;

  const tiff = new DataView(chunk.buffer, chunk.byteOffset + TIFF_OFFSET, tiffLength);
  const order = tiff.getUint16(0);
  const littleEndian = order === 0x4949;
  if ((!littleEndian && order !== 0x4d4d) || tiff.getUint16(2, littleEndian) !== 42) return chunk;
  // IFD0 describes the primary image. Leave thumbnail and other IFDs alone.
  const ifd = tiff.getUint32(4, littleEndian);
  if (ifd < 8 || ifd + 2 > tiffLength) return chunk;
  const entryCount = tiff.getUint16(ifd, littleEndian);
  const ifdEnd = ifd + 2 + 12 * entryCount;
  if (ifdEnd + 4 > tiffLength) return chunk;

  const resolutionOffsets: number[] = [];
  let unitOffset: number | undefined;
  for (let entry = ifd + 2; entry < ifdEnd; entry += 12) {
    const tag = tiff.getUint16(entry, littleEndian);
    const type = tiff.getUint16(entry + 2, littleEndian);
    if (tiff.getUint32(entry + 4, littleEndian) !== 1) continue;
    if (tag === 0x0128 && type === 3) unitOffset = entry + 8; // ResolutionUnit (SHORT)
    if ((tag === 0x011a || tag === 0x011b) && type === 5) { // X/YResolution (RATIONAL)
      const value = tiff.getUint32(entry + 8, littleEndian);
      const outsideDirectory = value + 8 <= ifd || value >= ifdEnd + 4;
      if (value >= 8 && value + 8 <= tiffLength && outsideDirectory) resolutionOffsets.push(value);
    }
  }
  if (resolutionOffsets.length === 0) return chunk;

  const updated = Buffer.from(chunk);
  const output = new DataView(updated.buffer, updated.byteOffset + TIFF_OFFSET, tiffLength);
  const centimetres = unitOffset !== undefined && output.getUint16(unitOffset, littleEndian) === 3;
  if (!centimetres && unitOffset !== undefined) output.setUint16(unitOffset, 2, littleEndian);
  for (const offset of resolutionOffsets) {
    output.setUint32(offset, centimetres ? dpi * 50 : dpi, littleEndian);
    output.setUint32(offset + 4, centimetres ? 127 : 1, littleEndian);
  }
  const crcOffset = updated.length - 4;
  updated.writeUInt32BE(crc32(updated.subarray(4, crcOffset)), crcOffset);
  return updated;
}
