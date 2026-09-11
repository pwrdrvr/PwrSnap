import { describe, expect, test } from "vitest";
import {
  WINDOWS_SNAPSHOT_HEADER_BYTES,
  WINDOWS_SNAPSHOT_MAX_PAYLOAD_BYTES,
  WINDOWS_SNAPSHOT_VERSION,
  encodeWindowsSnapshotHeader,
  parseWindowsSnapshotHeader,
  validateWindowsSnapshotDescriptor,
  WindowsSnapshotFormatError
} from "../windows-snapshot-format";

const nonceHex = "00112233445566778899aabbccddeeff";

function header() {
  return validateWindowsSnapshotDescriptor({
    width: 3,
    height: 2,
    stride: 12,
    byteLength: 24,
    nonceHex
  });
}

describe("Windows snapshot mapping format", () => {
  test("round-trips the fixed little-endian header from a non-zero buffer offset", () => {
    const encoded = encodeWindowsSnapshotHeader(header());
    const framed = new Uint8Array(encoded.byteLength + 7);
    framed.set(encoded, 7);

    expect(
      parseWindowsSnapshotHeader(framed.subarray(7), {
        nonceHex,
        width: 3,
        height: 2,
        totalByteLength: WINDOWS_SNAPSHOT_HEADER_BYTES + 24
      })
    ).toEqual({
      version: WINDOWS_SNAPSHOT_VERSION,
      width: 3,
      height: 2,
      stride: 12,
      pixelFormat: 1,
      byteLength: 24,
      totalByteLength: WINDOWS_SNAPSHOT_HEADER_BYTES + 24,
      nonceHex
    });
  });

  test("rejects magic, nonce, stride, and declared-size confusion", () => {
    const badMagic = encodeWindowsSnapshotHeader(header());
    badMagic[0] = 0;
    expect(() => parseWindowsSnapshotHeader(badMagic)).toThrow(WindowsSnapshotFormatError);

    const encoded = encodeWindowsSnapshotHeader(header());
    expect(() =>
      parseWindowsSnapshotHeader(encoded, {
        nonceHex: "ffeeddccbbaa99887766554433221100"
      })
    ).toThrow("nonce");
    expect(() =>
      validateWindowsSnapshotDescriptor({
        width: 3,
        height: 2,
        stride: 16,
        byteLength: 24,
        nonceHex
      })
    ).toThrow("stride");
    expect(() =>
      validateWindowsSnapshotDescriptor({
        width: 3,
        height: 2,
        stride: 12,
        byteLength: 20,
        nonceHex
      })
    ).toThrow("byte length");
  });

  test("bounds allocations before any transport buffer is created", () => {
    expect(() =>
      validateWindowsSnapshotDescriptor({
        width: 32_768,
        height: 32_768,
        stride: 32_768 * 4,
        byteLength: 32_768 * 32_768 * 4,
        nonceHex
      })
    ).toThrow("bounded transport limit");
    expect(WINDOWS_SNAPSHOT_MAX_PAYLOAD_BYTES).toBe(512 * 1024 * 1024);
  });
});
