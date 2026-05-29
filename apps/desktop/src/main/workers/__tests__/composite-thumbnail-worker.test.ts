// Unit tests for the off-thread composite-thumbnail encoder. Exercises
// the pure `encodeCompositeThumbnail` function directly so we don't have
// to spawn a Worker (the worker entrypoint is just a message loop that
// calls this and postMessage's the result). The client's lifecycle —
// reuse, crash recovery, timeout — is covered separately in
// composite-thumbnail-worker-client.test.ts.

import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { encodeCompositeThumbnail } from "../composite-thumbnail-worker";
import { COMPOSITE_THUMBNAIL_MAX_DIM_PX } from "../../image/composite-thumbnail";

async function makePng(widthPx: number, heightPx: number): Promise<Buffer> {
  return await sharp({
    create: {
      width: widthPx,
      height: heightPx,
      channels: 3,
      background: { r: 255, g: 128, b: 31 }
    }
  })
    .png()
    .toBuffer();
}

describe("composite-thumbnail-worker: encodeCompositeThumbnail", () => {
  test("happy path: encodes a JPEG thumbnail from PNG bytes", async () => {
    const png = await makePng(120, 80);
    const jpeg = await encodeCompositeThumbnail(new Uint8Array(png));
    const meta = await sharp(Buffer.from(jpeg)).metadata();
    expect(meta.format).toBe("jpeg");
    // Under the cap → no resize, natural dimensions preserved.
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(80);
  });

  test("oversized source is resized to fit the long-edge cap", async () => {
    const png = await makePng(2000, 1500);
    const jpeg = await encodeCompositeThumbnail(new Uint8Array(png));
    const meta = await sharp(Buffer.from(jpeg)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(COMPOSITE_THUMBNAIL_MAX_DIM_PX);
    expect(meta.height).toBe(
      Math.round(1500 * (COMPOSITE_THUMBNAIL_MAX_DIM_PX / 2000))
    );
  });

  test("malformed input rejects (a poison image fails its own item)", async () => {
    await expect(
      encodeCompositeThumbnail(new Uint8Array([1, 2, 3, 4]))
    ).rejects.toThrow();
  });
});
