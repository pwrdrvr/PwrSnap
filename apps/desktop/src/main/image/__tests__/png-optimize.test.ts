import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { optimizePngBuffer } from "../png-optimize";

describe("optimizePngBuffer", () => {
  test("uses a smaller exact palette PNG when the image has 256 colors or fewer", async () => {
    const input = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        {
          input: Buffer.from(
            `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
              <rect width="512" height="256" fill="#111111"/>
              <rect y="256" width="512" height="256" fill="#e8743a"/>
            </svg>`
          )
        }
      ])
      .png({ compressionLevel: 0 })
      .toBuffer();

    const optimized = await optimizePngBuffer(input);

    expect(optimized.strategy).toBe("palette");
    expect(optimized.byteSize).toBeLessThan(input.length);
    await expectRawPixelsToMatch(input, optimized.buffer);
  });

  test("does not use palette quantization when it would change rich-color pixels", async () => {
    const raw = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < raw.length; i += 4) {
      const pixel = i / 4;
      raw[i] = pixel & 0xff;
      raw[i + 1] = (pixel >> 4) & 0xff;
      raw[i + 2] = (pixel >> 8) & 0xff;
      raw[i + 3] = 255;
    }

    const input = await sharp(raw, {
      raw: { width: 64, height: 64, channels: 4 }
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const optimized = await optimizePngBuffer(input);

    expect(optimized.strategy).not.toBe("palette");
    expect(optimized.uniqueColors).toBeNull();
    await expectRawPixelsToMatch(input, optimized.buffer);
  });

  test("can skip truecolor recompression for already-encoded PNGs", async () => {
    const raw = Buffer.alloc(64 * 64 * 4);
    for (let i = 0; i < raw.length; i += 4) {
      const pixel = i / 4;
      raw[i] = pixel & 0xff;
      raw[i + 1] = (pixel >> 4) & 0xff;
      raw[i + 2] = (pixel >> 8) & 0xff;
      raw[i + 3] = 255;
    }

    const input = await sharp(raw, {
      raw: { width: 64, height: 64, channels: 4 }
    })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

    const optimized = await optimizePngBuffer(input, { recompressTruecolor: false });

    expect(optimized.strategy).toBe("original");
    expect(optimized.buffer).toBe(input);
    expect(optimized.uniqueColors).toBeNull();
  });
});

async function expectRawPixelsToMatch(left: Buffer, right: Buffer): Promise<void> {
  const a = await sharp(left).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  expect(b.info.width).toBe(a.info.width);
  expect(b.info.height).toBe(a.info.height);
  expect(Buffer.compare(b.data, a.data)).toBe(0);
}
