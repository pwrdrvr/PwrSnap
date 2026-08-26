import { createHash } from "node:crypto";
import {
  CLIPBOARD_FRAGMENT_MAX_DECODED_BYTES,
  CLIPBOARD_FRAGMENT_MAX_PIXELS
} from "@pwrsnap/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canonicalizeSafeRasterToPng: vi.fn(),
  inspectSafeRaster: vi.fn()
}));

vi.mock("../../image/safe-raster-decode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../image/safe-raster-decode")>()),
  canonicalizeSafeRasterToPng: mocks.canonicalizeSafeRasterToPng,
  inspectSafeRaster: mocks.inspectSafeRaster
}));

const { sanitizeLayerFragmentSources } = await import(
  "../verified-layer-fragment-sources"
);

const metadata = {
  widthPx: 1,
  heightPx: 1,
  channels: 4,
  pages: 1,
  decodedBytes: 4,
  format: "png" as const
};

function sourceRef(bytes: Buffer): { sha256: string; png_base64: string } {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    png_base64: bytes.toString("base64")
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectSafeRaster.mockResolvedValue(metadata);
  mocks.canonicalizeSafeRasterToPng.mockImplementation(async (bytes: Buffer) => ({
    pngBytes: Buffer.from(bytes),
    metadata
  }));
});

describe("sanitizeLayerFragmentSources aggregate decode budget", () => {
  test("verifies duplicate declarations but decodes each hash only once", async () => {
    const ref = sourceRef(Buffer.from("same raster"));

    const result = await sanitizeLayerFragmentSources([ref, ref], []);

    expect(result.ok).toBe(true);
    expect(mocks.inspectSafeRaster).toHaveBeenCalledTimes(1);
    expect(mocks.canonicalizeSafeRasterToPng).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error("expected sanitized sources");
    expect(result.sources.size).toBe(1);
  });

  test("rejects aggregate pixels before decoding the source that exceeds the cap", async () => {
    const first = sourceRef(Buffer.from("first raster"));
    const second = sourceRef(Buffer.from("second raster"));
    mocks.inspectSafeRaster
      .mockResolvedValueOnce({
        ...metadata,
        widthPx: 8_192,
        heightPx: 4_096,
        decodedBytes: 1
      })
      .mockResolvedValueOnce(metadata);

    const result = await sanitizeLayerFragmentSources([first, second], []);

    expect(result).toMatchObject({
      ok: false,
      code: "source_decode_budget_exceeded"
    });
    expect(8_192 * 4_096).toBe(CLIPBOARD_FRAGMENT_MAX_PIXELS);
    expect(mocks.canonicalizeSafeRasterToPng).toHaveBeenCalledTimes(1);
  });

  test("rejects aggregate decoded bytes before decoding the source that exceeds the cap", async () => {
    const first = sourceRef(Buffer.from("first raster"));
    const second = sourceRef(Buffer.from("second raster"));
    mocks.inspectSafeRaster
      .mockResolvedValueOnce({
        ...metadata,
        decodedBytes: CLIPBOARD_FRAGMENT_MAX_DECODED_BYTES
      })
      .mockResolvedValueOnce(metadata);

    const result = await sanitizeLayerFragmentSources([first, second], []);

    expect(result).toMatchObject({
      ok: false,
      code: "source_decode_budget_exceeded"
    });
    expect(mocks.canonicalizeSafeRasterToPng).toHaveBeenCalledTimes(1);
  });
});
