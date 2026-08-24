import { describe, expect, test } from "vitest";
import sharp from "sharp";
import {
  canonicalizeSafeRasterToPng,
  SafeRasterError,
  validateSafeRasterMetadata
} from "../safe-raster-decode";

async function makeAnimatedGif(): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const pages = 2;
  const channels = 3;
  const height = pageHeight * pages;
  const frameBytes = width * pageHeight * channels;
  const raw = Buffer.alloc(width * height * channels);
  raw.fill(0xff, 0, frameBytes);
  raw.fill(0x20, frameBytes);
  return await sharp(raw, {
    raw: { width, height, channels, pageHeight }
  })
    .gif({ delay: [50, 50], loop: 0 })
    .toBuffer();
}

async function makeMultiPageTiff(): Promise<Buffer> {
  const width = 2;
  const pageHeight = 2;
  const channels = 3;
  const height = pageHeight * 2;
  return await sharp(Buffer.alloc(width * height * channels), {
    raw: { width, height, channels, pageHeight }
  })
    .tiff()
    .toBuffer();
}

describe("safe raster decode boundary", () => {
  test("rejects decoded sample bytes even when total pixels are below cap", () => {
    expect(() =>
      validateSafeRasterMetadata({
        width: 5_000,
        height: 4_000,
        channels: 4,
        depth: "ushort",
        format: "png"
      })
    ).toThrowError(
      expect.objectContaining({
        name: "SafeRasterError",
        code: "decoded_size_cap_exceeded"
      })
    );
  });

  test("rejects channel counts above the RGB/RGBA boundary", () => {
    expect(() =>
      validateSafeRasterMetadata({
        width: 16,
        height: 16,
        channels: 5,
        depth: "uchar",
        format: "tiff"
      })
    ).toThrowError(
      expect.objectContaining({
        name: "SafeRasterError",
        code: "channel_cap_exceeded"
      })
    );
  });

  test("rejects an animated source before PNG encoding", async () => {
    await expect(
      canonicalizeSafeRasterToPng(await makeAnimatedGif())
    ).rejects.toMatchObject({
      name: "SafeRasterError",
      code: "unsupported_multi_page"
    });
  });

  test("rejects a multipage document before PNG encoding", async () => {
    await expect(
      canonicalizeSafeRasterToPng(await makeMultiPageTiff())
    ).rejects.toMatchObject({
      name: "SafeRasterError",
      code: "unsupported_multi_page"
    });
  });

  test("bounds streamed canonical PNG output", async () => {
    const jpeg = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 40, g: 80, b: 120 }
      }
    })
      .jpeg()
      .toBuffer();

    let caught: unknown;
    try {
      await canonicalizeSafeRasterToPng(jpeg, { maxOutputBytes: 16 });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(SafeRasterError);
    expect(caught).toMatchObject({ code: "output_size_cap_exceeded" });
  });
});
