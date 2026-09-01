import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { SelectorCropReceiver } from "../selector-crop-receiver";

async function png(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function send(
  receiver: SelectorCropReceiver,
  bytes: Buffer,
  declared: { width: number; height: number },
  chunkBytes = 17
): Promise<string> {
  await receiver.accept({
    type: "crop-start",
    invocationId: receiver.invocationId,
    ...declared,
    mimeType: "image/png",
    totalBytes: bytes.byteLength
  });
  let sequence = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const chunk = Uint8Array.from(bytes.subarray(offset, offset + chunkBytes)).buffer;
    const result = await receiver.accept({
      type: "crop-chunk",
      invocationId: receiver.invocationId,
      sequence,
      bytes: chunk
    });
    expect(result.reply).toEqual({
      type: "crop-chunk-accepted",
      invocationId: receiver.invocationId,
      sequence
    });
    sequence += 1;
  }
  const result = await receiver.accept({
    type: "crop-end",
    invocationId: receiver.invocationId,
    chunks: sequence
  });
  expect(result.reply).toEqual({
    type: "crop-accepted",
    invocationId: receiver.invocationId
  });
  const path = receiver.takeCompletedPath();
  if (path === null) throw new Error("receiver did not retain the completed crop");
  return path;
}

describe("selector committed crop receiver", () => {
  test("backpressures bounded chunks and accepts a fully decoded PNG", async () => {
    const receiver = new SelectorCropReceiver(41);
    const path = await send(receiver, await png(8, 6), { width: 8, height: 6 });
    try {
      await expect(sharp(path).metadata()).resolves.toMatchObject({
        format: "png",
        width: 8,
        height: 6
      });
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  test("rejects non-PNG bytes even when declared metadata is valid", async () => {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 20, g: 40, b: 60 }
      }
    })
      .jpeg()
      .toBuffer();
    const receiver = new SelectorCropReceiver(42);
    await expect(send(receiver, bytes, { width: 8, height: 6 })).rejects.toThrow();
    await receiver.dispose();
  });

  test("rejects a PNG whose decoded dimensions disagree with the declaration", async () => {
    const receiver = new SelectorCropReceiver(43);
    await expect(send(receiver, await png(8, 6), { width: 7, height: 6 })).rejects.toThrow(
      "metadata"
    );
    await receiver.dispose();
  });

  test("rejects a truncated PNG that still has readable header metadata", async () => {
    const complete = await png(64, 64);
    const truncated = complete.subarray(0, complete.length - 20);
    await expect(sharp(truncated).metadata()).resolves.toMatchObject({
      format: "png",
      width: 64,
      height: 64
    });
    const receiver = new SelectorCropReceiver(44);
    await expect(send(receiver, truncated, { width: 64, height: 64 })).rejects.toThrow();
    await receiver.dispose();
  });
});
